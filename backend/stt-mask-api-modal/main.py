import asyncio
import base64
import json
import os
import time
import uuid
from urllib.parse import urlencode

import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from transformers import pipeline
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed, WebSocketException

load_dotenv()

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

DISABLE_ASR = os.environ.get("DISABLE_ASR", "").lower() in ("1", "true", "yes")

# Modal에 배포된 Qwen3-ASR 서비스의 wss:// URL (modal/modal_asr.py 참고).
# `modal deploy modal/modal_asr.py` 실행 시 출력된다.
MODAL_ASR_WS_URL = os.environ.get(
    "MODAL_ASR_WS_URL",
    "wss://<username>--qwen3-asr-streaming-qwen3asrservice-web-dev.modal.run/ws/transcribe",
)

PRIVACY_FILTER_MODEL_ID = "openai/privacy-filter"
privacy_filter = pipeline(
    task="token-classification",
    model=PRIVACY_FILTER_MODEL_ID,
    aggregation_strategy="simple",
    device_map="cpu",  # keep the ASR engine's reserved GPU memory untouched
)

EXTERNAL_AUDIO_WS_URL = os.environ["EXTERNAL_AUDIO_WS_URL"]
EXTERNAL_AUDIO_AUTH_TOKEN = os.environ["EXTERNAL_AUDIO_AUTH_TOKEN"]


MULAW_BYTE_RATE = 8000  # 8비트 mu-law, 8kHz -> 샘플당 1바이트
JITTER_BUFFER_PRIME_SEC = 0.1  # 재생을 시작하기 전에 버퍼링해서 초기 지터를 흡수한다
JITTER_BUFFER_MAX_SEC = 0.5  # 백로그 상한값; 넘으면 지연이 계속 쌓이는 대신 오래된 프레임을 버린다


async def cancel_task(task: asyncio.Task) -> None:
    """task를 취소하고 그로 인한 CancelledError를 삼킨다."""
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def relay_external_audio(external_ws, origin_ws: WebSocket) -> None:
    """외부 ws에서 온 오디오를 작은 지터 버퍼를 거쳐 통화 플랫폼으로 중계한다.
    프레임은 도착하는 대로 큐에 쌓이고, 각자의 실제 재생 길이에 맞춰
    origin_ws로 전달되므로 업스트림의 burst가 그대로 끊김으로 이어지지 않는다.
    백로그에는 상한이 있어 일시적인 지연이 계속 누적되는 것을 막는다.
    """
    queue: asyncio.Queue = asyncio.Queue()
    buffered_sec = 0.0

    async def receiver() -> None:
        nonlocal buffered_sec
        try:
            async for message in external_ws:
                queue.put_nowait(message)
                buffered_sec += len(message) / MULAW_BYTE_RATE
                while buffered_sec > JITTER_BUFFER_MAX_SEC:
                    dropped = queue.get_nowait()
                    buffered_sec -= len(dropped) / MULAW_BYTE_RATE
                    print(f"[relay] jitter buffer backlog exceeded {JITTER_BUFFER_MAX_SEC * 1000:.0f}ms, dropped a frame")
        except ConnectionClosed:
            pass
        finally:
            queue.put_nowait(None)  # 종료를 알리는 sentinel 값

    receiver_task = asyncio.create_task(receiver())

    while buffered_sec < JITTER_BUFFER_PRIME_SEC and not receiver_task.done():
        await asyncio.sleep(0.005)

    try:
        while True:
            message = await queue.get()
            if message is None:
                break
            frame_sec = len(message) / MULAW_BYTE_RATE
            buffered_sec -= frame_sec

            payload = base64.b64encode(message).decode("ascii")
            send_start = time.monotonic()
            await origin_ws.send_json({"event": "media", "media": {"payload": payload}})
            send_sec = time.monotonic() - send_start
            if send_sec > 0.02:  # 살아있는 소켓에 대한 send_json은 거의 즉시 끝나야 한다
                print(f"[relay] slow send_json to origin_ws: {send_sec * 1000:.1f}ms")

            await asyncio.sleep(max(0.0, frame_sec - send_sec))
    finally:
        await cancel_task(receiver_task)


# Twilio 프레임(~20ms)마다 한 번씩 보내는 대신 이만큼 오디오를 모아서 한 번에 전송한다.
# 약간의 지연을 감수하는 대신 Modal과의 왕복 횟수를 약 10배 줄인다.
ASR_BATCH_MS = 200
ASR_BATCH_SAMPLES = int(ASR_BATCH_MS / 1000 * 16000)


async def transcribe_worker(
    queue: asyncio.Queue,
    call_id,
    on_transcript=None,
    language: str = "Korean",
) -> str:
    """`queue`에서 리샘플링된 오디오 청크를 꺼내 Modal에 호스팅된 Qwen3-ASR
    서비스로 websocket을 통해 전송한다. ASR_BATCH_MS 단위로 묶어서 보내고,
    전송과 수신을 파이프라인으로 동시에 처리한다(보내고 기다렸다가 다시
    보내는 방식이 아님). 그래야 모델 자체 연산 시간(~1ms, modal/modal_asr.py
    참고)보다 청크별 네트워크 왕복 시간이 더 커지는 일을 막을 수 있다.
    ASR 서버로부터 결과를 받을 때마다 `on_transcript(text, is_final)`을 호출한다."""
    ws_url = f"{MODAL_ASR_WS_URL}?{urlencode({'language': language})}"
    final_text = ""
    stop_sent = False

    async with ws_connect(ws_url, open_timeout=180) as asr_ws:

        async def sender() -> None:
            nonlocal stop_sent
            buffer: list[np.ndarray] = []
            buffered_samples = 0

            async def flush(label: str = "") -> None:
                nonlocal buffered_samples
                print(f"[{call_id}] sending {buffered_samples / 16000 * 1000:.0f}ms audio chunk to modal{label}")
                await asr_ws.send(np.concatenate(buffer).astype(np.float32).tobytes())
                buffer.clear()
                buffered_samples = 0

            try:
                while True:
                    chunk = await queue.get()
                    try:
                        if chunk is None:  # 종료를 알리는 sentinel 값
                            if buffer:
                                await flush(" (final)")
                            await asr_ws.send("stop")
                            stop_sent = True
                            return
                        buffer.append(chunk)
                        buffered_samples += chunk.shape[0]
                        if buffered_samples >= ASR_BATCH_SAMPLES:
                            await flush()
                    finally:
                        queue.task_done()
            except ConnectionClosed:
                pass

        async def receiver() -> None:
            nonlocal final_text
            try:
                async for message in asr_ws:
                    data = json.loads(message)
                    final_text = data["text"]
                    prefix = "final " if stop_sent else ""
                    print(f"[{call_id}] {prefix}language={data['language']!r} text={final_text!r}")
                    if on_transcript is not None:
                        await on_transcript(final_text, stop_sent)
            except ConnectionClosed:
                pass

        await asyncio.gather(sender(), receiver())

    return final_text


async def detect_pii(text: str) -> list:
    entities = await asyncio.to_thread(privacy_filter, text)
    return [
        {
            "entity_group": e["entity_group"],
            "word": e["word"],
            "score": float(e["score"]),
            "start": int(e["start"]),
            "end": int(e["end"]),
        }
        for e in entities
    ]


async def mask_text(text: str) -> dict:
    """text에서 탐지된 PII 개체들을 [0], [1], ... 형태의 자리표시자로 치환한
    anonymized_text와, 각 자리표시자에 대응하는 원본 문자열 목록인
    anonymization_map을 만든다."""
    if not text:
        return {"anonymized_text": text, "anonymization_map": []}

    entities = sorted(await detect_pii(text), key=lambda e: e["start"])
    anonymization_map: list[str] = []
    parts = []
    cursor = 0
    for entity in entities:
        start, end = entity["start"], entity["end"]
        if start < cursor:
            continue  # 겹치는 개체는 건너뛴다
        parts.append(text[cursor:start])
        parts.append(f"[{len(anonymization_map)}]")
        anonymization_map.append(text[start:end])
        cursor = end
    parts.append(text[cursor:])
    return {"anonymized_text": "".join(parts), "anonymization_map": anonymization_map}

MULAW_BIAS = 0x84


def _build_ulaw_table():
    table = []
    for i in range(256):
        byte = ~i & 0xFF
        sign = byte & 0x80
        exponent = (byte >> 4) & 0x07
        mantissa = byte & 0x0F
        sample = ((mantissa << 3) + MULAW_BIAS) << exponent
        sample -= MULAW_BIAS
        table.append(-sample if sign else sample)
    return table


ULAW_TO_PCM16 = _build_ulaw_table()


def ulaw_to_pcm16_bytes(ulaw_bytes: bytes) -> bytes:
    samples = [ULAW_TO_PCM16[b] for b in ulaw_bytes]
    return b"".join(s.to_bytes(2, byteorder="little", signed=True) for s in samples)


def pcm16_bytes_to_float32(pcm16_bytes: bytes) -> np.ndarray:
    pcm16 = np.frombuffer(pcm16_bytes, dtype=np.int16)
    return pcm16.astype(np.float32) / 32768.0


def resample_8k_to_16k(wav8k: np.ndarray) -> np.ndarray:
    """선형 보간으로 8kHz 오디오 청크를 16kHz로 리샘플링한다."""
    if wav8k.shape[0] == 0:
        return wav8k
    dur = wav8k.shape[0] / 8000.0
    n16 = int(round(dur * 16000))
    x_old = np.linspace(0.0, dur, num=wav8k.shape[0], endpoint=False)
    x_new = np.linspace(0.0, dur, num=n16, endpoint=False)
    return np.interp(x_new, x_old, wav8k).astype(np.float32)

DEBUG_CALL_ID = "fastapi-debug-call"
DEBUG_ECHO_RETRY_SEC = 3


async def debug_echo_loop() -> None:
    """서버 부팅 시 고정된 디버그 콜 ID로 external audio ws 서버에 접속해서
    받은 데이터를 그대로(base64 왕복을 거쳐) 되돌려 보낸다. 실제 통화 없이도
    external ws 연동을 테스트할 수 있게 해준다. 연결에 실패하거나 끊기면
    DEBUG_ECHO_RETRY_SEC초 후 재연결을 시도한다."""
    debug_url = f"{EXTERNAL_AUDIO_WS_URL}?{urlencode({'callId': DEBUG_CALL_ID})}"
    while True:
        try:
            async with ws_connect(
                debug_url,
                additional_headers={
                    "Authorization": f"Bearer {EXTERNAL_AUDIO_AUTH_TOKEN}"
                },
            ) as debug_ws:
                async for message in debug_ws:
                    payload = base64.b64encode(message).decode("ascii")
                    await debug_ws.send(base64.b64decode(payload))
        except ConnectionClosed:
            pass
        except (OSError, WebSocketException) as exc:
            print(f"[{DEBUG_CALL_ID}] external audio ws unavailable at {debug_url}: {exc}")
        await asyncio.sleep(DEBUG_ECHO_RETRY_SEC)


@app.on_event("startup")
async def start_debug_echo() -> None:
    asyncio.create_task(debug_echo_loop())


# Twilio가 통화 오디오를 스트리밍할 이 서버의 공개 wss:// 주소(예: ngrok 터널).
# 터널을 새로 열 때마다 바뀌므로 기기/세션마다 .env에서 설정한다.
STREAM_CALLBACK_URL = os.environ["STREAM_CALLBACK_URL"]

XML_RESPONSE = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ko">안녕하세요. 상담 내용을 말씀해주세요.</Say>
  <Connect>
    <Stream url="{STREAM_CALLBACK_URL}" track="inbound">
    </Stream>
  </Connect>
</Response>"""


@app.post("/webhook")
async def webhook(request: Request):
    form = await request.form()
    if form.get("CallStatus") != "in-progress":
        return Response(status_code=204)
    return Response(content=XML_RESPONSE, media_type="application/xml")


@app.websocket("/webhook")
async def media_stream(websocket: WebSocket):
    await websocket.accept()
    call_id = None
    external_audio_ws = None
    relay_task = None
    external_audio_connect_task = None
    audio_queue = None
    transcribe_task = None

    async def connect_external_audio(call_id_: str) -> None:
        # 별도 task로 실행해서, external ws 연결이 느리거나 불가능해도
        # 아래 receive 루프가 "media" 이벤트를 audio_queue에 넣는 것을 막지 않는다.
        nonlocal external_audio_ws, relay_task
        external_audio_url = f"{EXTERNAL_AUDIO_WS_URL}?{urlencode({'callId': call_id_})}"
        try:
            ws = await ws_connect(
                external_audio_url,
                additional_headers={
                    "Authorization": f"Bearer {EXTERNAL_AUDIO_AUTH_TOKEN}"
                },
            )
        except (OSError, WebSocketException) as exc:
            print(f"[{call_id_}] external audio ws unavailable at {external_audio_url}: {exc}")
            return
        external_audio_ws = ws
        relay_task = asyncio.create_task(relay_external_audio(ws, websocket))

    async def send_transcript_to_external(text: str, is_final: bool) -> None:
        # external ws가 아직 연결되지 않았거나 끊어졌으면 조용히 무시한다.
        # 전송 중 연결이 끊기는 경우(예: 서버 쪽 문제)에도 여기서 흡수해서
        # media_stream 루프나 오디오 릴레이에 영향이 가지 않게 한다.
        if external_audio_ws is None:
            return
        mask_result = await mask_text(text)
        try:
            await external_audio_ws.send(
                json.dumps({
                    "type": "transcript",
                    "text": text,
                    "anonymized_text": mask_result["anonymized_text"],
                    "anonymization_map": mask_result["anonymization_map"],
                    "isFinal": is_final,
                })
            )
        except ConnectionClosed as exc:
            print(f"[{call_id}] failed to send transcript to external ws: {exc}")

    try:
        while True:
            data = await websocket.receive_json()
            event = data.get("event")

            if event == "start":
                call_id = data["start"]["callId"]
                if not DISABLE_ASR:
                    audio_queue = asyncio.Queue()
                    transcribe_task = asyncio.create_task(
                        transcribe_worker(audio_queue, call_id, on_transcript=send_transcript_to_external)
                    )
                external_audio_connect_task = asyncio.create_task(
                    connect_external_audio(call_id)
                )

            elif event == "media":
                payload = data["media"]["payload"]
                ulaw_bytes = base64.b64decode(payload)
                if external_audio_ws is not None:
                    try:
                        await external_audio_ws.send(ulaw_bytes)
                    except ConnectionClosed as exc:
                        print(f"[{call_id}] external audio ws closed: {exc}")
                        external_audio_ws = None

                if audio_queue is not None:
                    pcm16_bytes = ulaw_to_pcm16_bytes(ulaw_bytes)
                    wav16k = resample_8k_to_16k(pcm16_bytes_to_float32(pcm16_bytes))
                    if wav16k.shape[0] > 0:
                        audio_queue.put_nowait(wav16k)

            elif event == "stop":
                break
    except WebSocketDisconnect:
        pass
    finally:
        if external_audio_connect_task is not None:
            await cancel_task(external_audio_connect_task)
        if relay_task is not None:
            await cancel_task(relay_task)

        # external ws는 아직 닫지 않는다: 최종 transcript(마스킹 포함)를
        # 보내야 하므로, 그 결과를 전송할 때까지 연결을 유지한다.
        if transcribe_task is not None:
            audio_queue.put_nowait(None)
            final_text = await transcribe_task
            print(f"[{call_id}] final text={final_text!r}")

        if external_audio_ws is not None:
            await external_audio_ws.close()


@app.websocket("/ws/transcribe/external")
async def external_transcribe(websocket: WebSocket):
    """외부 클라이언트가 raw float32 mono 16kHz PCM 오디오를 binary 프레임으로
    보내면(청크 길이는 자유), transcribe_worker를 통해 Modal ASR로 중계하고
    마스킹을 거친 transcript를 같은 연결로 JSON({"type": "transcript", "text",
    "anonymized_text", "anonymization_map", "isFinal"}) 형태로 돌려준다.
    텍스트 메시지 "stop"을 받거나 연결이 끊기면 종료한다."""
    if DISABLE_ASR:
        await websocket.close(code=1013, reason="ASR disabled")
        return

    await websocket.accept()
    language = websocket.query_params.get("language", "Korean")
    call_id = f"external-stt-{uuid.uuid4().hex[:8]}"
    audio_queue: asyncio.Queue = asyncio.Queue()

    async def send_transcript(text: str, is_final: bool) -> None:
        mask_result = await mask_text(text)
        try:
            await websocket.send_json({
                "type": "transcript",
                "text": text,
                "anonymized_text": mask_result["anonymized_text"],
                "anonymization_map": mask_result["anonymization_map"],
                "isFinal": is_final,
            })
        except (WebSocketDisconnect, RuntimeError) as exc:
            print(f"[{call_id}] failed to send transcript to external client: {exc}")

    transcribe_task = asyncio.create_task(
        transcribe_worker(audio_queue, call_id, on_transcript=send_transcript, language=language)
    )

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break

            audio_bytes = message.get("bytes")
            if audio_bytes is not None:
                if len(audio_bytes) % 4 != 0:
                    print(f"[{call_id}] dropping malformed frame ({len(audio_bytes)} bytes, not float32-aligned)")
                    continue
                print(f"[{call_id}] received audio frame ({len(audio_bytes)} bytes, {len(audio_bytes) / 4 / 16000 * 1000:.0f}ms)")
                wav16k = np.frombuffer(audio_bytes, dtype=np.float32)
                if wav16k.shape[0] > 0:
                    audio_queue.put_nowait(wav16k)
            elif message.get("text") == "stop":
                break
    except WebSocketDisconnect:
        pass
    finally:
        audio_queue.put_nowait(None)
        final_text = await transcribe_task
        print(f"[{call_id}] final text={final_text!r}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=9000)
