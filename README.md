# Qoder 视频理解 MCP

让 Qoder 真正“看过”一段视频，而不是根据文件名编一个剧情。

它把视频压成**一张带编号的宫格分镜图**，并附一份**带时间码的文本清单**（每格起止时间、台词、切点数）。需要细节时，再用 `video_zoom` 放大某一格。全程调用本机 `ffmpeg`；语音转写可选用本机 SenseVoice，不联网、不花钱。

项目由 Qoder CLI 插件（Skill + 斜杠命令 + MCP 服务）和一套可独立运行的 Node CLI 组成，针对 Raspberry Pi 4/5（ARM64）做过实测。

---

## 1. 它能做什么

| 你说的话 | 它会调用的工具 | 结果 |
|---|---|---|
| “这个视频讲了什么？” | `video_storyboard` | 一张宫格图 + 文本清单 |
| “第 3 分钟发生了什么？” | `video_zoom` | 只重新看那一段，格子更大 |
| “这句话在第几分钟？” | `video_locate` | 纯文本搜索转写，返回时间码 |
| “这文件多长、有没有字幕？” | `video_probe` | 只读容器头，不花图片 token |
| “陪我看，到点提醒我” | `video_watch` | 按播放进度一段段解读（Linux MPRIS） |

核心设计：**清单只给原材料，不下结论**。模型拿到的是时间、切点数、台词，判断由模型自己做。

---

## 2. 环境要求

- Raspberry Pi OS 64-bit（aarch64）或任意 Linux；x86 机器也能用，但 `pi/install.sh` 只自动下载 ARM64 版 Node，其他架构请先自备 Node ≥ 20。
- `ffmpeg` / `ffprobe`（必须）
- `python3` + `python3-venv`（本地 ASR 与 OCR 需要）
- Node.js ≥ 20（安装脚本会在需要时装 Node 22 到 `~/.local`）
- Qoder CLI（`qodercli`）
- 磁盘：ASR 虚拟环境 + 模型约 1–1.5 GB；不想装 ASR 可加 `--no-asr`
- 内存：Pi 4 4 GB 实测可用；首轮转写会加载 SenseVoice，峰值约 1 GB

```bash
sudo apt update
sudo apt install -y ffmpeg python3 python3-venv
```

`yt-dlp` 只在使用 http(s) 链接时需要，安装脚本会把它装进独立 venv。

---

## 3. 一键安装

```bash
git clone https://github.com/Xn-Furina/Qoder-MCP.git qoder-video-mcp
cd qoder-video-mcp
bash pi/install.sh
```

安装脚本全部是**用户级**操作，不写系统目录、不需要 `sudo`：

1. 检查 `ffmpeg` / `python3`
2. 需要时把 Node 22 装到 `~/.local/opt`，并软链到 `~/.local/bin`
3. 把 `yt-dlp` 装进 `~/.local/opt/ytdlp-venv`
4. 创建 `~/asr/.venv`，安装 `sherpa-onnx`、`onnxruntime`、`rapidocr_onnxruntime`
5. 从 `hf-mirror.com` 下载 SenseVoice int8 + Silero VAD 到 `~/asr/models`
6. 写 `~/.dsh/asr.json`（首次转写会自动拉起 ASR，空闲 10 分钟后自停）
7. 跑一次 5 秒 ASR 自检
8. 校验并安装 Qoder 插件

只想装分镜、不装语音识别：

```bash
bash pi/install.sh --no-asr
```

> 国内网络默认走 npmmirror / 清华 PyPI / hf-mirror。下载失败可直接重跑脚本，`curl -C -` 会续传。

### 手动安装插件

如果 Qoder CLI 不是通过脚本安装，或想单独更新插件：

```bash
qodercli plugins validate .
qodercli plugins install .
qodercli plugins list | grep qoder-video-mcp
```

安装后重启 Qoder CLI 会话，插件才会加载 MCP 工具。

> 从旧版本升级：旧插件名是 `video-storyboard-pi`，如果它还在，先执行
> `qodercli plugins uninstall video-storyboard-pi`，避免两套视频工具同时出现。
> 本地目录名可以随意，插件名以 `.qoder-plugin/plugin.json` 里的 `name` 为准。

---

## 4. 在 Qoder 里使用

直接用自然语言即可，例如：

```
帮我看看 /home/pi/Videos/demo.mp4 讲了什么
这个链接里第 2 分钟在干什么：https://www.bilibili.com/video/BV...
“所以你连他也要忘记吗”这句话在第几分钟？
```

也可以使用斜杠命令：

```
/video /home/pi/Videos/demo.mp4
```

可用工具参数（节选）：

| 工具 | 关键参数 | 说明 |
|---|---|---|
| `video_probe` | `input` | 时长、分辨率、帧率、音轨/字幕轨、已分析缓存 |
| `video_storyboard` | `input`, `from`, `to`, `cells`, `sheets`, `detail` | 出分镜；长片用 `from`/`to` 分窗 |
| `video_zoom` | `input`, `cellId` 或 `from`/`to`, `cells`, `minGap` | `cellId` 来自分镜清单；`minGap: 0.4` 拆快切 |
| `video_locate` | `input`, `query` | 在转写里找台词，返回时间码 |
| `video_watch` | `input?`, `cursor`, `segment`, `lead`, `statusOnly`, `stopLoop` | 陪看；`input` 可省略，走系统播放器 |

Pi 4 上建议：90 秒片子 9 格；长片用 `from`/`to` 分段，不要一次 16 格。

---

## 5. 不用 Qoder 也能跑（CLI）

```bash
# 出图 + 文本清单
node bin/qoder-video.mjs film.mp4 --cells 9 --out film.png --text

# 只看 60–150 秒
node bin/qoder-video.mjs film.mp4 --from 60 --to 150 --cells 6 --out part.png --text

# 长片每 5 分钟切一窗，最后生成时间线
node bin/qoder-video.mjs film.mp4 --batch 300 --out film.png

# 链接（需要 yt-dlp）
node bin/qoder-video.mjs "https://www.bilibili.com/video/BV..." --cells 9 --out bili.png --text

# 单独测转写
node bin/asr-check.mjs film.mp4 --from 100 --seconds 12
```

常用参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--cells` | 自动 | 格数；不给就按运动/文字密度/响度推 |
| `--from` / `--to` | 全片 | 只看这一段 |
| `--sheets` | 1 | 拆成几张图 |
| `--pick` | `sharp` | 取帧策略：`sharp` / `mid` / `thumb` |
| `--burn` | `index` | 把格号烧进画面；`none` 关闭 |
| `--min-gap` | 1.2 | 格子最小间隔；快切用 0.4 |
| `--detail` | `med` | 每格台词预算：`low` / `med` / `high` |
| `--transcript` | `auto` | `auto` / `off` |
| `--transcript-file` | — | 直接给 SRT/VTT/JSON，跳过 ASR |
| `--concurrency` | 自动 | Pi 4 建议 2 |
| `--plan` | — | 只算分段，不渲染 |

输出是一张 PNG + 一段可直接读的文本索引。分镜同时会写 `cells.json`，`video_zoom({ cellId })` 靠它定位；zoom 自己的小窗口**不会**覆盖全片格表。

---

## 6. 本地语音转写（ASR）

安装脚本会写 `~/.dsh/asr.json`：

```json
{
  "baseUrl": "http://127.0.0.1:8000/v1",
  "model": "sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
  "language": "zh",
  "manage": {
    "start": ["/home/pi/asr/.venv/bin/python", "/home/pi/qoder-video-mcp/pi/asr-server.py"],
    "idleMs": 600000,
    "waitMs": 120000
  }
}
```

- `~/asr/.venv` 是脚本创建的路径；换机器或换用户名后，把 `start` 里的两条绝对路径改成实际位置。
- `manage.start` 只在端点不通时拉起服务；最后一次转写结束后空闲 `idleMs` 毫秒，服务自行退出。
- 服务默认监听 `127.0.0.1:8000`，本机地址不需要 API key。
- 服务同时提供 OpenAI 兼容接口：`GET /health`、`GET /v1/models`、`POST /v1/audio/transcriptions`、`POST /shutdown`。协议细节见 [docs/asr-contract.md](docs/asr-contract.md)。

不想用本机服务，也可以填任何 OpenAI 兼容的云端 ASR（需要 key）：

```json
{
  "baseUrl": "https://api.siliconflow.cn/v1",
  "key": "sk-...",
  "model": "FunAudioLLM/SenseVoiceSmall",
  "language": "zh"
}
```

环境变量优先级更高：`DSH_ASR_BASE_URL`、`DSH_ASR_MODEL`、`DSH_ASR_LANG`、`DSH_ASR_KEY`（沿用历史命名，未改名）。已有字幕时，优先用 `transcriptFile`，零 ASR 成本、也最准。

---

## 7. 链接下载与登录态

`input` 可以是 B 站 / YouTube 等 http(s) 链接，下载走 `yt-dlp`：

- 普通视频匿名即可解析。
- 1080P、会员视频或遇到 `HTTP 567` / `Sign in to confirm` 时，需要 cookies。

导出 Netscape 格式的 `cookies.txt` 后，任选一种方式：

```json
// ~/.dsh/video.json
{ "cookies": "/home/pi/cookies/bili-cookies.txt" }
```

```bash
export DSH_VIDEO_COOKIES=/home/pi/cookies/bili-cookies.txt
```

或调用时传 `cookies` 参数。

> `cookies.txt` 里的 `SESSDATA` 等同于登录凭证。**不要提交到仓库、不要发到群里**。`.gitignore` 已经忽略 `cookies.txt`、`video.json`、`asr.json`。
>
> 不想配 cookies，就把视频下载到本地再喂路径，效果一样，还更快。

---

## 8. 陪看（`video_watch`）

Linux 上通过 **MPRIS** 读播放器进度（VLC、mpv、Firefox/Chromium 等），不需要装播放器插件。

```js
video_watch({ input: "/home/pi/Videos/movie.mp4" })
video_watch({ statusOnly: true })   // 看当前进度、可信度、为什么没说话
video_watch({ stopLoop: true })     // 停止后台循环
```

`input` 可以省略：它会从系统媒体会话里找正在播放的源。

进度读不到时（暂停、缓冲、切页），它**不会猜**，而是请你用 `cursor: 750` 或 `"12:30"` 自报；`statusOnly` 会说明原因。

---

## 9. 树莓派实测

| 场景 | 耗时 |
|---|---|
| 90 秒片子，9 格分镜 | 约 15 秒 |
| 90 秒片子 + 本地 ASR | 约 30 秒 |
| 仅探测容器头 | < 1 秒 |
| 硬字幕 OCR（`detail: high`） | 明显更慢，按需开启 |

建议：长片先 `video_probe`，再按 5–10 分钟窗口跑；Pi 4 上用 9 格而不是 16 格；并发保持 2。

---

## 10. 目录结构

```
.qoder-plugin/plugin.json     Qoder 插件清单
.mcp.json                     MCP 服务注册（stdio）
bin/qoder-video-mcp           MCP 启动器（自动找 Node）
bin/qoder-video.mjs           独立 CLI
mcp/server.mjs                MCP JSON-RPC 适配层
skills/video-understanding/   模型使用说明（Skill）
commands/video.md             /video 斜杠命令
src/                          扫描、切点、分格、取帧、ASR、OCR、缓存
pi/install.sh                 Pi 一键安装
pi/asr-server.py              本地 OpenAI 兼容 ASR 服务
test/                         node --test
```

自检：

```bash
node --test
node scripts/check-syntax.mjs
```

---

## 11. 排错

| 现象 | 处理 |
|---|---|
| 启动器报 `node >= 20 not found` | 设置 `QODER_VIDEO_NODE=/path/to/node`，或确认 `~/.local/bin` 在 PATH |
| `ffmpeg` 找不到 | `sudo apt install -y ffmpeg`，确认 `ffmpeg -version` 可用 |
| Qoder 里看不到五个工具 | `qodercli plugins validate .` 后重新 `install`，重启会话；`qodercli plugins list` 确认名字是 `qoder-video-mcp` |
| 升级后出现两套视频工具 | 卸载旧插件：`qodercli plugins uninstall video-storyboard-pi` |
| 清单里没有台词 | 看 `/tmp/asr-selftest.log`；确认 `~/.dsh/asr.json` 的 `manage.start` 路径存在；8000 端口被占用时先 `curl -X POST http://127.0.0.1:8000/shutdown` |
| 链接报 567 / 要登录 | 配 cookies，或先下载成本地文件 |
| `video_zoom({ cellId })` 报没有格表 | 先用 `video_storyboard` 对全片跑一次；zoom 的小窗口本身不写全片格表 |
| 想跳过 OCR | 用 `detail: low/med`；OCR 只在 `high` 时抽样开启 |
| ASR 占用内存 | 把 `idleMs` 调小（如 `5000`），服务会更快退出 |

---

## 12. 隐私与安全

- 仓库内**不包含**任何 API key、cookies、模型权重或用户视频。
- `cookies.txt`、`asr.json`、`video.json`、生成的 PNG/manifest 已被 `.gitignore` 排除。
- 本地 ASR 只监听 `127.0.0.1`；云端 ASR 是可选项，key 只在你自己的配置里。
- 插件只在本机调用 `ffmpeg`/`ffprobe`/`yt-dlp`，不上传视频。

---

## 13. 许可与致谢

MIT。本项目源自 `dsh-video-storyboard` 的架构与算法，并在其基础上增加了 Qoder MCP 适配、树莓派安装脚本、本地 SenseVoice 服务与 Linux MPRIS 支持。第三方致谢见 [CREDITS.md](CREDITS.md)，完整许可见 [LICENSE](LICENSE)。
