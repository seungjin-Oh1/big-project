"""
Qwen3-ASR streaming transcription hosted on Modal's serverless GPUs.

Setup (one-time):
    pip install modal
    modal setup                 # authenticates this machine with your Modal account

Deploy the service so it stays reachable from other code (e.g. main.py):
    modal deploy modal_asr.py

Run the built-in streaming demo (downloads a sample WAV, streams it over a
websocket to the deployed endpoint in chunks, prints live partial
transcripts to the terminal, same shape as the qwen_asr vLLM streaming
example but running on Modal instead of a local GPU):
    modal run modal_asr.py
    modal run modal_asr.py --step-ms 500 --language English

To call the deployed service from other code (e.g. main.py), open a
websocket to its /ws/transcribe route and stream raw float32 16kHz PCM
frames, one per message. The server replies with a
{"language", "text"} JSON message after each chunk. Send the text message
"stop" to flush the final transcript (one last JSON reply) and end the
call:
    wss://<workspace>--qwen3-asr-streaming-qwen3asrservice-web.modal.run/ws/transcribe?language=Korean
"""

import asyncio
import io
import json
import time
import urllib.request
from typing import Tuple
from urllib.parse import urlencode

import modal
import numpy as np
import soundfile as sf

app = modal.App("qwen3-asr-streaming")

MODEL_PATH = "Qwen/Qwen3-ASR-1.7B"
URL_EN = "https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-ASR-Repo/asr_en.wav"

# Cache HF weights across container restarts instead of re-downloading every cold start.
hf_cache = modal.Volume.from_name("qwen3-asr-hf-cache", create_if_missing=True)

# Cache vLLM's torch.compile/CUDA-graph artifacts across restarts instead of
# recompiling (~35s) and re-capturing CUDA graphs (~8s) on every cold start.
vllm_compile_cache = modal.Volume.from_name("qwen3-asr-vllm-compile-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("build-essential")  # triton needs a C compiler to build CUDA kernels
    .pip_install(
        "qwen-asr[vllm]",
        "numpy",
        "soundfile",
        "hf_transfer",
        "fastapi[standard]",
        "websockets",
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)


@app.cls(
    image=image,
    gpu="A10G",
    scaledown_window=240,
    min_containers=1,
    max_containers=1,  # pin to one container so concurrent calls share the GPU predictably
    volumes={
        "/root/.cache/huggingface": hf_cache,
        "/root/.cache/vllm": vllm_compile_cache,
    },
)
class Qwen3ASRService:
    @modal.enter()
    def load_model(self):
        from qwen_asr import Qwen3ASRModel

        self.asr = Qwen3ASRModel.LLM(
            model=MODEL_PATH,
            gpu_memory_utilization=0.8,
            max_model_len=8192,
            max_new_tokens=32,  # small value for low-latency streaming
        )

    @modal.asgi_app()
    def web(self):
        from fastapi import FastAPI, WebSocket, WebSocketDisconnect

        web_app = FastAPI()

        @web_app.websocket("/ws/transcribe")
        async def ws_transcribe(websocket: WebSocket):
            await websocket.accept()
            language = websocket.query_params.get("language", "Korean")
            state = self.asr.init_streaming_state(
                unfixed_chunk_num=2,
                unfixed_token_num=5,
                chunk_size_sec=3.0,
                language=language,
            )
            try:
                while True:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        return
                    audio_bytes = message.get("bytes")
                    if audio_bytes is not None:
                        wav16k = np.frombuffer(audio_bytes, dtype=np.float32)
                        start = time.monotonic()
                        await asyncio.to_thread(self.asr.streaming_transcribe, wav16k, state)
                        elapsed_ms = (time.monotonic() - start) * 1000
                        print(f"[inference] {elapsed_ms:.1f}ms language={state.language!r} text={state.text!r}")
                        await websocket.send_json({"language": state.language, "text": state.text})
                    elif message.get("text") == "stop":
                        start = time.monotonic()
                        await asyncio.to_thread(self.asr.finish_streaming_transcribe, state)
                        elapsed_ms = (time.monotonic() - start) * 1000
                        print(f"[inference] final {elapsed_ms:.1f}ms language={state.language!r} text={state.text!r}")
                        await websocket.send_json({"language": state.language, "text": state.text})
                        await websocket.close()
                        return
            except WebSocketDisconnect:
                pass

        return web_app


# ---- demo helpers (run locally, on your machine, not on Modal) ----


def _download_audio_bytes(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _read_wav_from_bytes(audio_bytes: bytes) -> Tuple[np.ndarray, int]:
    with io.BytesIO(audio_bytes) as f:
        wav, sr = sf.read(f, dtype="float32", always_2d=False)
    return np.asarray(wav, dtype=np.float32), int(sr)


def _resample_to_16k(wav: np.ndarray, sr: int) -> np.ndarray:
    if sr == 16000:
        return wav.astype(np.float32, copy=False)
    wav = wav.astype(np.float32, copy=False)
    dur = wav.shape[0] / float(sr)
    n16 = int(round(dur * 16000))
    if n16 <= 0:
        return np.zeros((0,), dtype=np.float32)
    x_old = np.linspace(0.0, dur, num=wav.shape[0], endpoint=False)
    x_new = np.linspace(0.0, dur, num=n16, endpoint=False)
    return np.interp(x_new, x_old, wav).astype(np.float32)


async def _stream_demo(ws_url: str, wav16k: np.ndarray, step_ms: int) -> None:
    from websockets.asyncio.client import connect as ws_connect

    sr16 = 16000
    step = int(round(step_ms / 1000.0 * sr16))

    async with ws_connect(ws_url, open_timeout=300) as ws:
        pos = 0
        call_num = 0
        while pos < wav16k.shape[0]:
            seg = wav16k[pos : pos + step]
            pos += seg.shape[0]
            call_num += 1
            await ws.send(seg.astype(np.float32).tobytes())
            result = json.loads(await ws.recv())
            print(f"[call {call_num:03d}] language={result['language']!r} text={result['text']!r}")

        await ws.send("stop")
        final = json.loads(await ws.recv())
        print(f"[final] language={final['language']!r} text={final['text']!r}")


@app.local_entrypoint()
def main(step_ms: int = 1000, language: str = "English"):
    service = Qwen3ASRService()
    web_url = service.web.get_web_url().rstrip("/")
    ws_url = web_url.replace("https://", "wss://") + f"/ws/transcribe?{urlencode({'language': language})}"

    audio_bytes = _download_audio_bytes(URL_EN)
    wav, sr = _read_wav_from_bytes(audio_bytes)
    wav16k = _resample_to_16k(wav, sr)

    print(f"\n===== streaming step = {step_ms} ms =====")
    asyncio.run(_stream_demo(ws_url, wav16k, step_ms))
