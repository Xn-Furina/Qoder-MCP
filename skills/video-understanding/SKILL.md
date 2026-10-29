---
name: video-understanding
description: Look at a video instead of guessing. Use when the user asks what a video/link contains, what happens at a timestamp, wants a summary grounded in actual frames, or asks to find where a line was said (视频讲了什么、第几分钟发生了什么、帮我看看这个片子、这句话在第几分钟). Works on local files and http(s) links, with local SenseVoice speech-to-text.
---

# Video Understanding

You have five MCP tools backed by ffmpeg and a local ASR service. The point is to **see the video**, not to invent a plot from the filename.

## Workflow

1. **Unknown length or format** → `video_probe({ input })`. No image tokens, returns duration, fps, audio/subtitle tracks and a suggested reading plan.
2. **Overview** → `video_storyboard({ input })`, or a window with `{ from, to }` for long films. One image shows numbered cells; the text index gives `cell k (r2c3) = 00:12.76-00:31.40`.
3. **Close-up** → `video_zoom({ input, cellId })` using a cell number from the storyboard. Only fall back to hand-typed `from/to` when there is no cell map; `minGap: 0.4` keeps fast cuts separate.
4. **Find a line** → `video_locate({ input, query })`. It searches the transcript and returns timecodes; feed them to `video_zoom`.
5. **Watching together** → `video_watch({ input })` repeatedly while the user is playing the file. `input` may be omitted: it reads the OS media session (MPRIS on Linux, SMTC on Windows) and finds the source itself. If position cannot be read, ask the user for `cursor` in seconds instead of guessing. `statusOnly: true` explains why it went quiet; `stopLoop: true` stops the background loop.

## Rules

- Cite cells by number (`cell 4`), not by re-describing pixels. The text index already carries `frame@` timestamps.
- Do not claim dialogue you did not get from a subtitle track or ASR. If the transcript says `no-key` / `asr-failed`, say so and offer `transcriptFile`.
- Links: `input` may be a Bilibili/YouTube URL. Downloading needs `yt-dlp`; login-gated sources need `cookies`.
- `detail: "high"` enables local OCR to correct hard-coded subtitles; it is slower. `detail: "low"` keeps the index short.
- On a Raspberry Pi 4 a 90-second clip with 9 cells takes ~15 s; a 90 s clip with ASR ~30 s. Prefer `from/to` windows and 9 cells over 16 on this hardware.

## Fallback (no MCP)

```bash
node "$QODER_PLUGIN_ROOT/bin/qoder-video.mjs" <video-or-url> \
  --cells 9 --out sheet.png --text [--from 60 --to 150] [--concurrency 2]
```

`--text` prints the cell index; the PNG is at `--out`. `bin/asr-check.mjs <video> --from 60 --seconds 12` tests speech-to-text alone.
