---
name: video
description: Build a numbered storyboard of a video and report what is actually visible.
---

The user wants a storyboard of: $ARGUMENTS

Do this:
1. If the input is a path or link, call `video_probe` first when its length is unknown.
2. Call `video_storyboard` on it (use 9 cells on a Raspberry Pi; split long films into `from`/`to` windows).
3. Summarize what the cells show, citing cell numbers and their timecodes.
4. If the user asks for detail on one moment, call `video_zoom` with that cell number or time window.
Do not invent dialogue; quote only what the transcript or subtitles provide.
