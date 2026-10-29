#!/usr/bin/env node
/**
 * server.mjs — MCP (stdio) 适配层，把插件里的五个工具原样暴露给 Qoder CLI。
 *
 * 为什么单独一层：上游是 DSH 的 cordis 插件（dsh.plugin.json + @deepseek-ai/dsh-tools）。
 * Qoder CLI 不认那套宿主 API，但认 MCP。这里只做 JSON-RPC 胶水，真正的逻辑仍然全部
 * 来自 src/ —— 一份实现，两套宿主，不会出现"Qoder 版行为和 CLI 版不一样"。
 *
 * 协议：JSON-RPC 2.0，每行一条消息（MCP stdio transport）。
 * 日志一律写 stderr —— stdout 只能有协议消息，否则宿主解析直接失败。
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { DETAIL_CHARS, formatManifest, formatProbe, formatRemoteProbe, runStoryboard } from '../src/pipeline.js';
import { probeVideo } from '../src/probe.js';
import { formatMatches, matchSegments, recallSegments } from '../src/locate.js';
import { lookupCell } from '../src/cells.js';
import { isHttpUrl, probeUrl, resolveDirectUrl, resolveInput } from '../src/fetch.js';
import { runWatchPass } from '../src/watch-run.js';
import { loopStatus, stopWatchLoop } from '../src/watch-loop.js';
import {
  locateToolSpec, probeToolSpec, storyboardToolSpec, validateToolArgs, validateWatchArgs,
  validateZoomArgs, watchToolSpec, zoomToolSpec,
} from '../src/tool-spec.js';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const SERVER_INFO = { name: PKG.name, version: PKG.version };
const PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const watchCache = new Map();

const log = (...parts) => console.error('[qoder-video-mcp]', ...parts);

/* ------------------------------------------------------------------ helpers */

const CLIP = 'Cell numbers are burned into the top-left corner; cite them and use video_zoom({ cellId }) to re-read one.';

const commonInput = {
  type: 'string',
  description: 'Local absolute path (mp4/mov/mkv/webm), or an http(s) link such as a Bilibili URL. ' +
    'Links are downloaded once at low resolution for scanning; zoom re-reads the original stream in high resolution.',
};

const cookies = { type: 'string', description: 'Path to a Netscape cookies.txt for login-gated sources.' };
const allowAnonymous = { type: 'boolean', description: 'Allow anonymous fetches for links (default false).' };

const TOOLS = [
  {
    name: 'video_probe',
    description: 'Read a video container\'s metadata without decoding frames: duration, resolution, fps, rotation, ' +
      'audio/subtitle tracks, and a suggested reading plan. Call this first when the length is unknown; costs no image tokens.',
    inputSchema: {
      type: 'object',
      properties: { input: commonInput, cookies, allowAnonymous },
      required: ['input'],
      additionalProperties: false,
    },
    run: probeTool,
  },
  {
    name: 'video_storyboard',
    description: 'Turn a video (or a window of it) into ONE numbered storyboard image plus a text index of every cell, ' +
      'so you can look at the video instead of guessing. Cell count adapts to duration and cut density. ' + CLIP,
    inputSchema: {
      type: 'object',
      properties: {
        input: commonInput,
        from: { type: 'number', description: 'Window start in seconds (default 0).' },
        to: { type: 'number', description: 'Window end in seconds (default: end of file).' },
        cells: { type: 'integer', description: 'Cells per image, 1-16 (default: auto).' },
        sheets: { type: 'integer', description: 'How many images to return, 1-4 (default: auto).' },
        pick: { type: 'string', enum: ['sharp', 'mid', 'thumb'], description: 'Frame picker (default sharp).' },
        burn: { type: 'string', enum: ['index', 'none'], description: 'Burn cell numbers (default index).' },
        minGap: { type: 'number', description: 'Minimum spacing between sampled frames in seconds (default 1.2).' },
        transcript: { type: 'string', enum: ['auto', 'off'], description: 'auto uses subtitle track, then local ASR.' },
        transcriptFile: { type: 'string', description: 'Existing SRT/JSON transcript; skips subtitle track and ASR.' },
        hotwords: { type: 'string', description: 'Space-separated terms to bias this run\'s ASR.' },
        ocr: { type: 'boolean', description: 'Correct ASR against hard-coded subtitles with local OCR.' },
        detail: { type: 'string', enum: ['low', 'med', 'high'], description: 'Text budget per cell (default med).' },
        scanHeight: { type: 'integer', description: 'For links: download height used for scanning (default 360).' },
        cellRange: {
          type: 'array', items: { type: 'integer' },
          description: '[first,last] cell numbers to include in the text index (default all).',
        },
        cookies, allowAnonymous,
        sourceHash: { type: 'boolean', description: 'Also record the source SHA-256 (off by default).' },
        textOnly: { type: 'boolean', description: 'Return only the text index, no image.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    run: storyboardTool,
  },
  {
    name: 'video_zoom',
    description: 'Re-read a short window at higher per-cell resolution (default 6 large cells) so faces, subtitles ' +
      'and on-screen text become legible. Use after video_storyboard; prefer cellId over hand-copied timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        input: commonInput,
        from: { type: 'number', description: 'Window start in seconds (omit when using cellId).' },
        to: { type: 'number', description: 'Window end in seconds (omit when using cellId).' },
        cellId: { type: 'integer', description: 'Cell number from the last storyboard of this input.' },
        cells: { type: 'integer', description: 'Cells for this window, 1-9 (default 6).' },
        pick: { type: 'string', enum: ['sharp', 'mid', 'thumb'], description: 'Frame picker (default sharp).' },
        burn: { type: 'string', enum: ['index', 'none'], description: 'Burn cell numbers (default index).' },
        transcript: { type: 'string', enum: ['auto', 'off'], description: 'Include transcript text for this window.' },
        minGap: { type: 'number', description: 'Minimum spacing between cells (default 1.2; use 0.3-0.5 for fast cuts).' },
        zoomHeight: { type: 'integer', description: 'For links: resolution to read the original stream at (default 1080).' },
        cookies, allowAnonymous,
        sourceHash: { type: 'boolean', description: 'Also record the source SHA-256.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    run: zoomTool,
  },
  {
    name: 'video_locate',
    description: 'Find where a line is spoken, as timecodes, without decoding frames or spending image tokens. ' +
      'Uses the transcript already produced by video_storyboard; feed the result to video_zoom.',
    inputSchema: {
      type: 'object',
      properties: {
        input: commonInput,
        query: { type: 'string', description: 'Line or keywords to search (verbatim works best).' },
        from: { type: 'number', description: 'Restrict search to >= this second.' },
        to: { type: 'number', description: 'Restrict search to <= this second.' },
        max: { type: 'integer', description: 'Maximum matches (default 5, max 20).' },
        transcriptFile: { type: 'string', description: 'Existing SRT/JSON transcript to use instead of ASR.' },
        cookies, allowAnonymous,
      },
      required: ['input', 'query'],
      additionalProperties: false,
    },
    run: locateTool,
  },
  {
    name: 'video_watch',
    description: 'Watch a video together with the user, segment by segment, following their playback position. ' +
      'Reads the OS media session (SMTC on Windows, MPRIS on Linux); pass cursor explicitly when nothing is playing. ' +
      'Do not retell the plot the user just watched — say at most one sentence.',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Local path or link being watched. Omit to auto-detect from the OS media session ' +
            '(reads title + duration, then looks for a matching local file).',
        },
        cursor: { type: 'number', description: 'Where the user is, in seconds. Omit to read the OS media session.' },
        segment: { type: 'number', description: 'Segment length in seconds (default 120).' },
        lead: { type: 'number', description: 'Deliver this many seconds before the segment ends (default 15).' },
        cells: { type: 'number', description: 'Cells per segment sheet (default 5).' },
        title: { type: 'string', description: 'Video title, used to pick the right media session.' },
        transcript: { type: 'string', enum: ['auto', 'off'], description: 'auto (default) transcribes each segment.' },
        statusOnly: { type: 'boolean', description: 'Return the watch-loop state only, without reading the video.' },
        stopLoop: { type: 'boolean', description: 'Stop the background watch loop (idempotent).' },
        cookies, allowAnonymous,
      },
      additionalProperties: false,
    },
    run: watchTool,
  },
];

const imageBlock = (png) => ({ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' });

function textBlock(text) {
  return { type: 'text', text };
}

function manifestText(result, args) {
  return formatManifest(result, {
    cellRange: Array.isArray(args.cellRange) && args.cellRange.length === 2 ? args.cellRange : null,
    maxCellChars: DETAIL_CHARS[args.detail] ?? DETAIL_CHARS.med,
  });
}

/* -------------------------------------------------------------------- tools */

async function probeTool(args) {
  if (!args?.input) throw new Error('input is required');
  const fetchOptions = { cookies: args.cookies, allowAnonymous: args.allowAnonymous === true };
  if (isHttpUrl(args.input)) {
    return { content: [textBlock(formatRemoteProbe(await probeUrl(args.input, fetchOptions)))] };
  }
  const info = { ...(await probeVideo(args.input)), path: args.input };
  return { content: [textBlock(await formatProbe(info))] };
}

async function storyboardTool(args) {
  const problems = validateToolArgs(args);
  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);
  const detail = args.detail ?? 'med';
  const result = await runStoryboard({
    input: args.input,
    from: args.from ?? 0,
    to: args.to ?? 0,
    cells: args.cells ?? 0,
    sheets: args.sheets ?? 0,
    pick: args.pick ?? 'sharp',
    burn: args.burn ?? 'index',
    minGap: args.minGap ?? 1.2,
    transcript: args.transcript ?? 'auto',
    transcriptFile: args.transcriptFile,
    ...(typeof args.hotwords === 'string' ? { hotwords: args.hotwords } : {}),
    sourceHash: args.sourceHash === true,
    textOnly: args.textOnly === true,
    detail,
    ocr: args.ocr === true || (args.ocr !== false && detail === 'high'),
    fetchOptions: {
      cookies: args.cookies,
      allowAnonymous: args.allowAnonymous === true,
      scanHeight: args.scanHeight ?? 360,
    },
  });
  const content = result.sheets.map((sheet) => imageBlock(sheet.png));
  content.push(textBlock(manifestText(result, args)));
  return { content };
}

async function zoomTool(args) {
  const problems = validateZoomArgs(args);
  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);

  const fetchOptions = {
    cookies: args.cookies,
    allowAnonymous: args.allowAnonymous === true,
    scanHeight: 360,
    zoomHeight: args.zoomHeight ?? 1080,
  };

  let from = args.from;
  let to = args.to;
  if (args.cellId !== undefined && args.cellId !== null) {
    // 链接模式：cell map 记的是解析后的本地路径，直接查原 URL 查不到 —— 先解析再查一次。
    let hit = await lookupCell(args.input, args.cellId);
    if (!hit && isHttpUrl(args.input)) {
      try {
        hit = await lookupCell((await resolveInput(args.input, fetchOptions)).path, args.cellId);
      } catch { /* 下载失败就让下面的报错兜底 */ }
    }
    if (!hit) {
      throw new Error(`no cell map recorded for this input (cellId ${args.cellId}). ` +
        'Run video_storyboard on it first, or pass from/to.');
    }
    from = hit.from;
    to = hit.to;
  }

  let frameSource = null;
  if (isHttpUrl(args.input)) {
    try {
      const resolved = await resolveInput(args.input, fetchOptions);
      frameSource = resolved.frameSource
        ?? await resolveDirectUrl(args.input, { ...fetchOptions, height: fetchOptions.zoomHeight });
    } catch { /* 直链拿不到就退回本地低清 */ }
  }

  const result = await runStoryboard({
    input: args.input,
    from,
    to,
    cells: args.cells ?? 6,
    sheets: 1,
    minGap: args.minGap ?? 1.2,
    pick: args.pick ?? 'sharp',
    burn: args.burn ?? 'index',
    transcript: args.transcript ?? 'auto',
    sourceHash: args.sourceHash === true,
    adaptive: false,
    // 窗口内格号 ≠ 整片格号；zoom 不能覆盖 storyboard 写下的格位表
    recordCells: false,
    frameSource,
    fetchOptions,
  });
  const content = result.sheets.map((sheet) => imageBlock(sheet.png));
  content.push(textBlock(manifestText(result, args)));
  return { content };
}

async function locateTool(args) {
  if (!args?.input) throw new Error('input is required');
  if (!args?.query) throw new Error('query is required');
  const max = Math.min(20, Math.max(1, Number(args.max) || 5));
  const resolved = await resolveInput(args.input, {
    cookies: args.cookies, allowAnonymous: args.allowAnonymous === true,
  });
  let segments = recallSegments(resolved.path);
  if (!segments) {
    await runStoryboard({
      input: resolved.path, from: args.from, to: args.to, cells: 1,
      transcriptFile: args.transcriptFile, textOnly: true, encode: false,
    });
    segments = recallSegments(resolved.path);
  }
  if (!segments || segments.length === 0) {
    return {
      content: [textBlock('no transcript available for this file: run video_storyboard first, ' +
        'or pass transcriptFile. Without a transcript there is nothing to match on.')],
    };
  }
  const lo = Number.isFinite(args.from) ? args.from : 0;
  const hi = Number.isFinite(args.to) ? args.to : Infinity;
  const inWindow = segments.filter((x) => x.to >= lo && x.from <= hi);
  const matches = matchSegments(inWindow, args.query, { max });
  return { content: [textBlock(formatMatches(args.query, matches, { total: inWindow.length }))] };
}

async function watchTool(args) {
  const problems = validateWatchArgs(args);
  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);
  // 后台叫醒需要宿主的会话 id；MCP 是请求-应答模型，这里只暴露"看状态 / 停表"。
  if (args.stopLoop === true) return { content: [textBlock(JSON.stringify(stopWatchLoop('requested')))] };
  if (args.statusOnly === true) return { content: [textBlock(JSON.stringify(loopStatus()))] };
  const r = await runWatchPass(args, {
    cache: watchCache,
    // runWatchPass 把 cookies/allowAnonymous 直接塞给 runStoryboard，而它只认 fetchOptions；
    // 在适配层补一次，链接陪看才不会因为"匿名未允许"被拒。
    runStoryboard: (opts) => runStoryboard({
      ...opts,
      fetchOptions: { cookies: args.cookies, allowAnonymous: args.allowAnonymous === true },
    }),
    formatManifest,
    saveImage: async ({ data }) => imageBlock(data),
  });
  return { content: [...(r.images ?? []), textBlock(r.text)] };
}

/* --------------------------------------------------------------- JSON-RPC */

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: PROTOCOLS.has(requested) ? requested : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Video tools backed by ffmpeg + local SenseVoice ASR. Probe first, then storyboard, then zoom.',
      },
    };
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0', id,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      },
    };
  }
  if (method === 'tools/call') {
    const tool = TOOL_BY_NAME.get(params?.name);
    if (!tool) throw Object.assign(new Error(`unknown tool: ${params?.name}`), { code: -32602 });
    try {
      const result = await tool.run(params?.arguments ?? {});
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      return {
        jsonrpc: '2.0', id,
        result: { content: [textBlock(String(error?.message ?? error))], isError: true },
      };
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (message.id === undefined || message.id === null) return; // notifications
  queue = queue.then(async () => {
    try {
      send(await handleRequest(message));
    } catch (error) {
      send({
        jsonrpc: '2.0', id: message.id ?? null,
        error: { code: error?.code ?? -32603, message: String(error?.message ?? error) },
      });
    }
  });
});

rl.on('close', () => {
  // 留一点时间给后台落盘（格位表 / 记忆）；立刻 process.exit 会把未完成的写入截断。
  queue.finally(() => setTimeout(() => process.exit(0), 100));
});

process.on('uncaughtException', (error) => log('uncaught:', error));
process.on('unhandledRejection', (error) => log('unhandled:', error));
log(`ready ${SERVER_INFO.name}@${SERVER_INFO.version} · tools=${TOOLS.length}`);
