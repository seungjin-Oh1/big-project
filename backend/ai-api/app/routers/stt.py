"""음성파일 → 텍스트 변환 (POST /stt/transcribe).

왜 여기에 있는가 —
이 기능은 원래 stt-mask-api(8002)에 있었다. 그 서버를 배포에서 빼기로 하면서
갈 곳을 정해야 했고, 두 후보가 있었다.

    stt-mask-api-modal(9000)  실시간 전사를 맡는 서버. 다만 전사를 스스로 하지 않고
                              Modal(GPU)로 넘긴다 — Modal이 꺼져 있으면 파일 업로드도
                              같이 죽는다.
    ai-api(여기)              분석 1단계에서 이미 같은 일을 한다
                              (app/ai/stt/multimodal.extract_text_from_audio_video).
                              외부 의존이 없다.

파일 업로드는 실시간이 아니고 급하지도 않다. GPU가 필요한 쪽에 묶어 둘 이유가 없어서
whisper가 이미 있는 이쪽으로 옮겼다. 첨부파일 추출과 같은 모델을 쓰므로 결과도 일관된다.

가림(마스킹)은 하지 않는다. 8002의 /transcribe는 전사와 가림을 함께 했지만, 그 조합은
실시간 경로의 사정이었다. 여기서 나온 텍스트는 상담 내용으로 저장되고, 가림은
core-api가 stt-mask-api-modal의 /redact로 따로 건다 — 가리는 곳을 한 군데로 모은다.
"""

import os
import tempfile

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.ai.stt.multimodal import extract_text_from_audio_video

router = APIRouter(prefix="/stt", tags=["stt"])

# core-api SttApiProxyController가 이미 확장자를 거르지만 여기서도 본다 —
# 프록시를 거치지 않고 직접 부르는 경로가 생겨도 같은 규칙이 적용되어야 한다.
ALLOWED_EXTENSIONS = {"mp3", "wav", "m4a", "webm", "ogg", "flac"}


@router.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    filename = file.filename or ""
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"지원하지 않는 형식입니다: .{extension or '(없음)'} "
                   f"(가능: {', '.join(sorted(ALLOWED_EXTENSIONS))})",
        )

    # whisper는 파일 경로를 받는다(내부에서 ffmpeg를 부른다). 메모리로는 못 넘긴다.
    # 확장자를 유지해야 ffmpeg가 컨테이너를 제대로 고른다.
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=f".{extension}") as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name

        text = extract_text_from_audio_video(tmp_path)
        return {"text": text}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        # 무엇이 실패했는지 화면에 남긴다. 빈 문자열을 돌려주면 "말이 없는 녹음"과
        # 구분되지 않아, 상담원이 변환이 안 된 줄 모르고 넘어간다.
        raise HTTPException(status_code=500, detail=f"음성 변환에 실패했습니다: {e}") from e
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
