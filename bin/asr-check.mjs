#!/usr/bin/env node
/**
 * asr-check — 在真机上验一次台词链路，只花十几秒音频的钱。
 *
 *   node bin/asr-check.mjs <video> [--from 60] [--seconds 12]
 *
 * 顺序：字幕轨 → ASR。没有配置 key 时会直接告诉你缺什么，不会发请求。
 */
import { args as parse } from './_args.mjs';
import { probeVideo } from '../src/probe.js';
import {
  ASR_DEFAULTS, canTranscribe, describeAsrTarget, extractSubtitleTrack, filterSuspectSegments,
  transcribeLong,
} from '../src/asr.js';
import { ensureAsr } from '../src/asr-lifecycle.js';
import { analyzeAudio } from '../src/audio.js';
import { spawn } from 'node:child_process';

const opt = parse(process.argv.slice(2), { from: 0, seconds: 12 });
const input = opt._[0];
if (!input) {
  console.error('usage: node bin/asr-check.mjs <video> [--from 60] [--seconds 12]');
  process.exit(2);
}
const from = Number(opt.from) || 0;
const seconds = Number(opt.seconds) || 12;

const info = await probeVideo(input);
console.log(`[probe] ${info.width}x${info.height} ${info.duration.toFixed(1)}s  ` +
  `${info.hasAudio ? 'audio' : 'NO AUDIO'}${info.hasSubtitle ? ' + 字幕轨' : ''}`);
if (!info.hasAudio) {
  console.log('这个文件没有音轨，台词链路无事可做。');
  process.exit(0);
}

// 1) 字幕轨
if (info.hasSubtitle) {
  const subs = await extractSubtitleTrack({ input });
  if (subs?.length) {
    console.log(`[subtitle] 抽到 ${subs.length} 条字幕，前 3 条：`);
    for (const s of subs.slice(0, 3)) console.log(`  ${s.from.toFixed(1)}–${s.to.toFixed(1)}  ${s.text}`);
    console.log('\n有字幕轨时根本不用调 ASR —— 这条路径是免费且最准的。');
    process.exit(0);
  }
  console.log('[subtitle] 声明了字幕轨但抽不出来，回退到 ASR');
}

// 2) ASR 配置：走和工具同一套解析（env > asr.json > 默认），别再各读各的
const keyEnv = ASR_DEFAULTS.keyEnv;
console.log(`[asr] ${describeAsrTarget()}`);
// 本机端点（127.0.0.1 / localhost / [::1]）按设计不需要 key —— 判据必须和
// transcribe() 同源，否则自建服务明明在跑，这里却报"没配 key"。
if (!canTranscribe(ASR_DEFAULTS)) {
  console.log(`\n没有检测到 ${keyEnv}，且 ${ASR_DEFAULTS.baseUrl} 不是本机端点。设置后重跑：`);
  console.log('  Linux/macOS:  export ' + keyEnv + '=sk-...');
  console.log('  PowerShell:   $env:' + keyEnv + ' = "sk-..."');
  console.log('可选：DSH_ASR_BASE_URL / DSH_ASR_MODEL / DSH_ASR_LANG（默认 zh）');
  console.log('      本机服务直接写到 ~/.dsh/asr.json 的 baseUrl 即可，不需要 key。');
  process.exit(1);
}

// 3) 本地服务没起就按 asr.json 的 manage.start 拉起来（和工具里同一条生命周期路径）
const life = await ensureAsr({
  baseUrl: ASR_DEFAULTS.baseUrl, config: ASR_DEFAULTS, spawnImpl: spawn,
  log: (m) => console.log('[asr]', m),
}).catch((e) => {
  console.error('[asr] 无法启动本地服务：', e?.message ?? e);
  return { owned: false };
});
if (life.started && !life.pid) {
  console.error('[asr] 服务启动超时，检查 manage.start 里的命令。');
  process.exit(1);
}

// 4) 真调一次
const t0 = Date.now();
console.log(`[asr] 转写 ${from}s–${from + seconds}s（≈${(seconds * 31.25).toFixed(0)}KB @16k 单声道）…`);
// 走和工具同一套切片逻辑（>45s 会自动切成多请求，切点优先落在静音）
const { silences } = (await analyzeAudio({ input, start: from, end: from + seconds })) ?? { silences: [] };
const result = await transcribeLong({
  input, start: from, end: from + seconds, silences, maxChunk: 45,
});
const ms = Date.now() - t0;
if (!result) {
  console.log('没有返回内容（音频可能全是静音）。');
  process.exit(0);
}
console.log(`[asr] ${ms}ms，${result.segments.length} 段` +
  `${result.chunks ? `（${result.chunks} 片）` : ''}，model=${result.model}`);
for (const s of result.segments) {
  console.log(`  ${s.from.toFixed(2)}–${s.to.toFixed(2)}  ${s.text}`);
}
const { kept, dropped } = filterSuspectSegments(result.segments);
const chars = kept.reduce((n, s) => n + s.text.length, 0);
if (dropped.length > 0) {
  console.log(`\n[过滤] ${dropped.length} 段疑似非语音（音乐/噪声），已忽略：`);
  for (const d of dropped.slice(0, 5)) {
    console.log(`  ${d.from.toFixed(2)}–${d.to.toFixed(2)}  ${d.charsPerSec} 字/秒  ${d.reason}  "${d.text.slice(0, 20)}"`);
  }
}
console.log(`\n[统计] ${chars} 字 / ${seconds}s = ${(chars / seconds).toFixed(2)} 字/秒`);
console.log('[提示] 这些时间码会按重叠贴到分镜格子上；字/秒也会作为第三条密度信号。');
if (life.owned) console.log('[asr] 本地服务这次由本脚本拉起，空闲后会自动退出（默认 30 分钟）。');
