#!/usr/bin/env bash
# 树莓派（aarch64）用户级一键安装：Node 22 + yt-dlp + 本地 ASR + Qoder 插件。
#
#   bash pi/install.sh            # 全量（推荐）
#   bash pi/install.sh --no-asr   # 只装 Node / yt-dlp / 插件
#
# 设计原则：**不用 sudo、不写系统目录**。唯一需要管理员的是 ffmpeg —— 脚本会检查并给出 apt 命令。
# 所有下载都走国内镜像（npmmirror / 清华 PyPI / hf-mirror），断点重试由 curl --retry 兜底。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME:?}"
BIN="$HOME_DIR/.local/bin"
OPT="$HOME_DIR/.local/opt"
ASR_HOME="$HOME_DIR/asr"
MODELS="$ASR_HOME/models"
NODE_VERSION="${NODE_VERSION:-v22.23.4}"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"
PIP_INDEX="${PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
HF_MIRROR="${HF_MIRROR:-https://hf-mirror.com}"
WITH_ASR=1
[[ "${1:-}" == "--no-asr" ]] && WITH_ASR=0

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

mkdir -p "$BIN" "$OPT"

# ---------------------------------------------------------------- 环境自检
case "$(uname -m)" in
  aarch64|arm64) ;;
  *) warn "当前架构 $(uname -m) 不是 aarch64；脚本按 ARM64 下载 Node，其他架构请自备 node。" ;;
esac

if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  fail "缺少 ffmpeg/ffprobe。先运行：  sudo apt update && sudo apt install -y ffmpeg   然后重跑本脚本。"
fi
command -v python3 >/dev/null || fail "缺少 python3（sudo apt install -y python3 python3-venv）"

# ~/.local/bin 必须在 PATH 里：node/npm/yt-dlp/插件的 MCP 启动器都放这
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) export PATH="$BIN:$PATH" ;;
esac
if ! grep -qs '\.local/bin' "$HOME_DIR/.bashrc"; then
  printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME_DIR/.bashrc"
  say "已把 ~/.local/bin 写进 ~/.bashrc"
fi

# ---------------------------------------------------------------- Node 22
need_node=1
if command -v node >/dev/null; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$major" -ge 22 ]] && need_node=0
fi
if [[ "$need_node" == 1 ]]; then
  say "安装 Node $NODE_VERSION 到 $OPT（用户级，不动系统）"
  tarball="node-$NODE_VERSION-linux-arm64.tar.xz"
  url="$NODE_MIRROR/$NODE_VERSION/$tarball"
  tmp="$(mktemp -d)"
  curl -fL --retry 5 --retry-delay 2 --connect-timeout 15 -o "$tmp/$tarball" "$url" \
    || fail "Node 下载失败：$url"
  tar -xJf "$tmp/$tarball" -C "$OPT"
  ln -sf "$OPT/node-$NODE_VERSION-linux-arm64/bin/node" "$BIN/node"
  ln -sf "$OPT/node-$NODE_VERSION-linux-arm64/bin/npm"  "$BIN/npm"
  ln -sf "$OPT/node-$NODE_VERSION-linux-arm64/bin/npx"  "$BIN/npx"
  rm -rf "$tmp"
  say "node $(node -v)"
else
  say "已有 node $(node -v)"
fi

# ---------------------------------------------------------------- yt-dlp
if command -v yt-dlp >/dev/null; then
  say "已有 yt-dlp $(yt-dlp --version 2>/dev/null | head -1)"
else
  say "安装 yt-dlp 到独立 venv（避开 PEP 668 的 externally-managed 限制）"
  python3 -m venv "$OPT/ytdlp-venv"
  "$OPT/ytdlp-venv/bin/pip" install -q -i "$PIP_INDEX" -U yt-dlp
  ln -sf "$OPT/ytdlp-venv/bin/yt-dlp" "$BIN/yt-dlp"
  say "yt-dlp $(yt-dlp --version | head -1)"
fi

# ---------------------------------------------------------------- 本地 ASR
if [[ "$WITH_ASR" == 1 ]]; then
  say "准备本地 ASR（sherpa-onnx + SenseVoice int8 + Silero VAD）"
  [[ -x "$ASR_HOME/.venv/bin/python" ]] || python3 -m venv "$ASR_HOME/.venv"
  "$ASR_HOME/.venv/bin/pip" install -q -i "$PIP_INDEX" -U pip
  "$ASR_HOME/.venv/bin/pip" install -q -i "$PIP_INDEX" sherpa-onnx rapidocr_onnxruntime onnxruntime || \
    fail "Python 依赖安装失败。可重试：  $ASR_HOME/.venv/bin/pip install -i $PIP_INDEX sherpa-onnx rapidocr_onnxruntime onnxruntime"

  mkdir -p "$MODELS/sense-voice"
  fetch() {  # fetch <url> <dest>
    [[ -s "$2" ]] && { say "已存在 $(basename "$2") ($(du -h "$2" | cut -f1))"; return 0; }
    say "下载 $(basename "$2")"
    curl -fL --retry 6 --retry-delay 3 --connect-timeout 15 -C - -o "$2.part" "$1" || {
      rm -f "$2.part"; fail "下载失败：$1（hf-mirror 偶尔 429，重跑本脚本即可续传）"; }
    mv "$2.part" "$2"
  }
  SV="$HF_MIRROR/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"
  fetch "$SV/model.int8.onnx" "$MODELS/sense-voice/model.int8.onnx"
  fetch "$SV/tokens.txt"      "$MODELS/sense-voice/tokens.txt"
  fetch "$HF_MIRROR/csukuangfj/sherpa-onnx-silero-vad/resolve/main/silero_vad.onnx" "$MODELS/silero_vad.onnx"

  cfg="$HOME_DIR/.dsh/asr.json"
  if [[ ! -f "$cfg" ]]; then
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" <<EOF
{
  "baseUrl": "http://127.0.0.1:8000/v1",
  "model": "sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
  "language": "zh",
  "manage": {
    "start": ["$ASR_HOME/.venv/bin/python", "$ROOT/pi/asr-server.py"],
    "idleMs": 600000,
    "waitMs": 120000
  }
}
EOF
    say "已写入 $cfg（首次转写会自动拉起服务，空闲 10 分钟后自停）"
  else
    warn "$cfg 已存在，未覆盖。若路径不同请手动改 manage.start。"
  fi

  say "自检：本地 ASR 试转写 5 秒"
  "$ASR_HOME/.venv/bin/python" "$ROOT/pi/asr-server.py" --idle-exit 20 >/tmp/asr-selftest.log 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do curl -fsS --max-time 1 http://127.0.0.1:8000/health >/dev/null 2>&1 && break; sleep 1; done
  if curl -fsS --max-time 1 http://127.0.0.1:8000/health >/dev/null 2>&1; then
    say "ASR 就绪（日志：/tmp/asr-selftest.log），已请求它自行退出"
    curl -fsS -X POST --max-time 3 http://127.0.0.1:8000/shutdown >/dev/null 2>&1 || kill "$pid" 2>/dev/null || true
  else
    warn "ASR 自检超时，看 /tmp/asr-selftest.log。转写会失败，但分镜/OCR 不受影响。"
    kill "$pid" 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------- Qoder 插件
if command -v qodercli >/dev/null; then
  say "校验并安装 Qoder 插件"
  qodercli plugins validate "$ROOT" >/dev/null
  qodercli plugins install "$ROOT" >/dev/null
  qodercli plugins list | grep -q qoder-video-mcp && say "插件 qoder-video-mcp（Qoder 视频理解 MCP）已安装"
else
  warn "未找到 qodercli，跳过插件安装。装好后运行：  qodercli plugins install \"$ROOT\""
fi

say "完成。验证："
cat <<EOF
  node "$ROOT/bin/qoder-video.mjs" /path/to/video.mp4 --cells 9 --out sheet.png --text
  node "$ROOT/bin/asr-check.mjs" /path/to/video.mp4 --from 10 --seconds 12
  qodercli                                  # 在会话里说：帮我看一下这个视频的分镜
EOF
