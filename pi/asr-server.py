#!/usr/bin/env python3
"""OpenAI-compatible local ASR endpoint backed by sherpa-onnx (SenseVoice + Silero VAD).

Implemented for the Raspberry Pi port of qoder-video-mcp. Speaks the same
contract as docs/asr-contract.md:

    GET  /health                     -> 200
    GET  /v1/models                  -> OpenAI-style model list
    POST /v1/audio/transcriptions    -> verbose_json {text, segments:[{start,end,text}]}
    POST /shutdown                   -> respond, then exit

Segments are cut by VAD, so timestamps refer to the uploaded audio (the plugin
adds its own window offset). A request that contains no detectable speech returns
an empty segment list, not an error.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import signal
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

TAG_RE = re.compile(r"<\|[^|]*\|>")
SAMPLE_RATE = 16000
STARTED_AT = time.time()
LAST_REQUEST = time.time()
DECODE_LOCK = threading.Lock()
SHUTDOWN = threading.Event()


def log(*parts: object) -> None:
    print("[asr]", *parts, file=sys.stderr, flush=True)


def clean_text(text: str) -> str:
    text = TAG_RE.sub("", text or "")
    return re.sub(r"\s+", " ", text).strip()


class Recognizer:
    def __init__(self, model_dir: str, vad_model: str, threads: int) -> None:
        model = os.path.join(model_dir, "model.int8.onnx")
        if not os.path.exists(model):
            model = os.path.join(model_dir, "model.onnx")
        tokens = os.path.join(model_dir, "tokens.txt")
        for path in (model, tokens, vad_model):
            if not os.path.exists(path):
                raise SystemExit(f"missing model file: {path}")

        t0 = time.time()
        self.model_name = os.path.basename(model_dir)
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=model,
            tokens=tokens,
            num_threads=threads,
            use_itn=True,
            debug=False,
            provider="cpu",
        )

        self.vad_config = sherpa_onnx.VadModelConfig()
        self.vad_config.silero_vad.model = vad_model
        self.vad_config.silero_vad.min_silence_duration = 0.35
        self.vad_config.silero_vad.min_speech_duration = 0.2
        self.vad_config.silero_vad.max_speech_duration = 30
        self.vad_config.sample_rate = SAMPLE_RATE
        self.vad_config.num_threads = 1
        self.vad_config.provider = "cpu"
        self.vad_window = int(self.vad_config.silero_vad.window_size or 512)
        log(f"loaded {self.model_name} in {time.time() - t0:.2f}s (threads={threads})")

    def _decode(self, samples: np.ndarray) -> str:
        stream = self.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        self.recognizer.decode_stream(stream)
        return clean_text(stream.result.text)

    def transcribe(self, samples: np.ndarray) -> list[dict]:
        if samples.size == 0:
            return []
        vad = sherpa_onnx.VoiceActivityDetector(self.vad_config, buffer_size_in_seconds=60)
        for offset in range(0, samples.size, self.vad_window):
            chunk = samples[offset:offset + self.vad_window]
            if chunk.size:
                vad.accept_waveform(chunk)
        vad.flush()

        raw: list[tuple[float, float, np.ndarray]] = []
        while not vad.empty():
            seg = vad.front
            start = seg.start / SAMPLE_RATE
            audio = np.asarray(seg.samples, dtype=np.float32)
            vad.pop()
            if audio.size / SAMPLE_RATE >= 0.2:
                raw.append((start, start + audio.size / SAMPLE_RATE, audio))

        if not raw:
            # No VAD hit: fall back to one whole-file segment so quiet speech still lands
            # somewhere instead of being silently dropped.
            text = self._decode(samples)
            return [{"start": 0.0, "end": round(samples.size / SAMPLE_RATE, 3), "text": text}] if text else []

        segments: list[dict] = []
        for start, end, audio in raw:
            with DECODE_LOCK:
                text = self._decode(audio)
            if not text or not re.search(r"[\w\u3400-\u9fff]", text):
                continue
            segments.append({
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
            })
        return segments


def read_wav(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data), "rb") as wav:
        rate = wav.getframerate()
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        frames = wav.readframes(wav.getnframes())
    if width != 2:
        raise ValueError(f"expected 16-bit PCM, got {width * 8}-bit")
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE:
        # The plugin always sends 16 kHz; resample by linear interpolation just in case.
        duration = samples.size / rate
        target = max(1, int(duration * SAMPLE_RATE))
        samples = np.interp(
            np.linspace(0, samples.size - 1, target, dtype=np.float32),
            np.arange(samples.size, dtype=np.float32),
            samples,
        ).astype(np.float32)
    return np.ascontiguousarray(samples, dtype=np.float32)


def parse_multipart(body: bytes, boundary: bytes) -> tuple[dict[str, str], dict[str, bytes]]:
    fields: dict[str, str] = {}
    files: dict[str, bytes] = {}
    for part in body.split(b"--" + boundary):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        head, sep, data = part.partition(b"\r\n\r\n")
        if not sep:
            continue
        if data.endswith(b"\r\n"):
            data = data[:-2]
        headers: dict[str, str] = {}
        for line in head.split(b"\r\n"):
            key, _, value = line.partition(b":")
            headers[key.strip().lower().decode("latin-1")] = value.strip().decode("utf-8", "replace")
        disposition = headers.get("content-disposition", "")
        name = re.search(r'name="([^"]*)"', disposition)
        if not name:
            continue
        if "filename=" in disposition:
            files[name.group(1)] = data
        else:
            fields[name.group(1)] = data.decode("utf-8", "replace")
    return fields, files


def srt_timestamp(seconds: float) -> str:
    ms = int(round(max(0.0, seconds) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def render_segments(fmt: str, segments: list[dict], full_text: str) -> tuple[str, str]:
    if fmt == "text":
        return "text/plain; charset=utf-8", full_text + "\n"
    if fmt == "srt":
        lines = []
        for i, seg in enumerate(segments, 1):
            lines += [str(i), f"{srt_timestamp(seg['start'])} --> {srt_timestamp(seg['end'])}", seg["text"], ""]
        return "application/x-subrip; charset=utf-8", "\n".join(lines)
    if fmt in ("srt", "vtt"):
        pass
    return "application/json; charset=utf-8", ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "qoder-video-mcp-asr"

    def log_message(self, fmt: str, *args: object) -> None:  # silence default request log
        pass

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802
        global LAST_REQUEST
        LAST_REQUEST = time.time()
        if self.path in ("/health", "/healthz"):
            return self._json(200, {"status": "ok", "model": self.server.recognizer.model_name,
                                    "uptime": round(time.time() - STARTED_AT, 1)})
        if self.path == "/v1/models":
            return self._json(200, {"object": "list", "data": [{
                "id": self.server.recognizer.model_name, "object": "model", "owned_by": "sherpa-onnx",
            }]})
        return self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        global LAST_REQUEST
        LAST_REQUEST = time.time()
        if self.path == "/shutdown":
            self._json(200, {"status": "shutting down"})
            threading.Timer(0.1, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
            return
        if self.path not in ("/v1/audio/transcriptions", "/audio/transcriptions"):
            return self._json(404, {"error": "not found"})

        ctype = self.headers.get("Content-Type", "")
        m = re.search(r"boundary=([^;]+)", ctype)
        if not m:
            return self._json(400, {"error": "expected multipart/form-data"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 128 * 1024 * 1024:
            return self._json(400, {"error": f"bad content length {length}"})
        body = self.rfile.read(length)
        try:
            fields, files = parse_multipart(body, m.group(1).strip('"').encode("latin-1"))
        except Exception as error:  # malformed multipart is a client error
            return self._json(400, {"error": f"multipart parse failed: {error}"})

        blob = files.get("file")
        if not blob:
            return self._json(400, {"error": "missing file field"})
        try:
            samples = read_wav(blob)
        except Exception as error:
            return self._json(400, {"error": f"cannot read wav: {error}"})

        try:
            began = time.time()
            segments = self.server.recognizer.transcribe(samples)
            took = time.time() - began
        except Exception as error:  # keep the process alive; the plugin will retry later
            log("transcribe failed:", error)
            return self._json(500, {"error": str(error)})

        full_text = "".join(seg["text"] for seg in segments)
        fmt = fields.get("response_format", "json")
        log(f"{samples.size / SAMPLE_RATE:.1f}s audio -> {len(segments)} segs in {took:.2f}s")

        if fmt != "verbose_json":
            ctype_out, rendered = render_segments(fmt, segments, full_text)
            if fmt in ("json", ""):
                return self._json(200, {"text": full_text, "model": self.server.recognizer.model_name})
            return self._send(200, rendered.encode("utf-8"), ctype_out)

        return self._json(200, {
            "text": full_text,
            "model": self.server.recognizer.model_name,
            "language": fields.get("language") or "zh",
            "duration": round(samples.size / SAMPLE_RATE, 3),
            "segments": [{"id": i, **seg} for i, seg in enumerate(segments)],
        })


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    home = os.path.expanduser("~")
    parser = argparse.ArgumentParser(description="OpenAI-compatible sherpa-onnx ASR server")
    parser.add_argument("--model-dir", default=os.environ.get(
        "SHERPA_MODEL_DIR", os.path.join(home, "asr", "models", "sense-voice")))
    parser.add_argument("--vad-model", default=os.environ.get(
        "SHERPA_VAD_MODEL", os.path.join(home, "asr", "models", "silero_vad.onnx")))
    parser.add_argument("--host", default=os.environ.get("SHERPA_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("SHERPA_PORT", "8000")))
    parser.add_argument("--threads", type=int, default=int(os.environ.get(
        "SHERPA_THREADS", str(max(1, min(2, (os.cpu_count() or 2) - 1))))))
    parser.add_argument("--idle-exit", type=int, default=int(os.environ.get("SHERPA_IDLE_EXIT", "1800")),
                        help="exit after this many idle seconds (0 disables)")
    args = parser.parse_args()

    recognizer = Recognizer(args.model_dir, args.vad_model, args.threads)
    httpd = Server((args.host, args.port), Handler)
    httpd.recognizer = recognizer  # type: ignore[attr-defined]

    def stop(*_: object) -> None:
        if SHUTDOWN.is_set():
            return
        SHUTDOWN.set()
        log("shutting down")
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    if args.idle_exit > 0:
        def watchdog() -> None:
            while not SHUTDOWN.wait(15):
                if time.time() - LAST_REQUEST > args.idle_exit:
                    log(f"idle for {args.idle_exit}s, exiting")
                    stop()
                    return
        threading.Thread(target=watchdog, daemon=True).start()

    log(f"listening on http://{args.host}:{args.port}  model={recognizer.model_name}  pid={os.getpid()}")
    try:
        httpd.serve_forever(poll_interval=0.2)
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
