"""
app/agents/consult/multimodal.py

submitted_file_link(S3 key 배열)에 담긴 파일들을 다운로드하고
STT/문서 텍스트 추출을 수행하는 모듈. (기존 case_analysis/multimodal.py를 그대로 이동,
로직 변경 없음 - API 단일화를 위한 위치 이동만 수행)
"""
import os
import re
import tempfile
from urllib.parse import urlparse

from app.ai.config import S3_BUCKET_NAME, WHISPER_MODEL_SIZE, get_s3_client

s3 = get_s3_client()

AUDIO_VIDEO_EXTS = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".mp4", ".mov", ".avi", ".webm", ".mkv"}
CAPTION_EXTS = {".vtt", ".srt"}
DOCUMENT_EXTS = {".pdf", ".docx", ".txt", ".md"}
UNSUPPORTED_DOC_EXTS = {".hwp", ".hwpx"}  # kordoc 파이프라인 연동 필요 (이번 백본 범위 밖)

_whisper_model = None


def get_whisper_model():
    """Whisper 모델은 프로세스당 최초 1회만 로드해서 재사용.
    FastAPI에서는 요청마다 호출하지 말고 서버 startup 시점에 한 번 미리 불러둘 것."""
    global _whisper_model
    if _whisper_model is None:
        import whisper

        print(f"[whisper] '{WHISPER_MODEL_SIZE}' 모델 로딩 중... (최초 1회, 다소 시간 소요)")
        _whisper_model = whisper.load_model(WHISPER_MODEL_SIZE)
    return _whisper_model


def determine_file_category(url: str, content_type: str = "") -> str:
    """확장자 우선 판별 -> 실패 시 Content-Type 보조 판별"""
    ext = os.path.splitext(urlparse(url).path)[1].lower()

    if ext in AUDIO_VIDEO_EXTS:
        return "audio_video"
    if ext in CAPTION_EXTS:
        return "caption"
    if ext in DOCUMENT_EXTS:
        return "document"
    if ext in UNSUPPORTED_DOC_EXTS:
        return "unsupported_hwp"

    ct = (content_type or "").lower()
    if ct.startswith("audio/") or ct.startswith("video/"):
        return "audio_video"
    if "vtt" in ct or "srt" in ct or ct.startswith("text/vtt"):
        return "caption"
    if ct == "application/pdf":
        return "document"
    if "wordprocessingml" in ct:  # docx
        return "document"
    if ct.startswith("text/"):
        return "document"

    return "unsupported"


class UntrustedFileLinkError(ValueError):
    """요청이 지정한 위치가 우리 버킷 밖일 때 올린다."""


def parse_s3_key(link: str) -> tuple:
    """첨부 링크를 (bucket, key)로 바꾼다. 버킷은 항상 S3_BUCKET_NAME이다.

    예전에는 "s3://bucket/key" 형태가 오면 그 bucket을 그대로 썼다. 그런데 이 값은
    /consult/analyze 요청 본문(content.summited_file_link)에 실려 오고 ai-api에는 인증이
    없다 - 즉 누구든 "s3://다른-버킷/키"를 넣어 ai-api의 자격증명이 닿는 아무 버킷이나
    읽어서 그 내용을 분석 결과 텍스트로 돌려받을 수 있었다.
    (시큐어 코딩 가이드 "신뢰되지 않은 URL 주소로 자동접속 연결"에 해당한다.)

    정당한 호출자는 그 형태를 쓰지 않는다. core-api는 Attachment.storageKey를 그대로
    보내고(AiAnalysisService.buildRawInput), 그건 버킷 없는 평범한 key다. 그래서 버킷을
    바깥에서 정하는 길 자체를 닫는다 - s3:// 형태는 우리 버킷일 때만 받는다.

    http(s) 주소도 거절한다. S3가 아닌 곳으로 요청을 내보내는 통로가 되고,
    사내망 주소나 클라우드 메타데이터 주소를 찔러보는 데 쓰일 수 있다.
    """
    if not isinstance(link, str) or not link.strip():
        raise UntrustedFileLinkError("빈 파일 링크")

    link = link.strip()
    lowered = link.lower()

    if lowered.startswith(("http://", "https://", "ftp://", "file://")):
        raise UntrustedFileLinkError(f"S3 키가 아닌 주소는 받지 않는다: {link}")

    if lowered.startswith("s3://"):
        parsed = urlparse(link)
        bucket = parsed.netloc
        key = parsed.path.lstrip("/")
        if bucket != S3_BUCKET_NAME:
            raise UntrustedFileLinkError(
                f"허용되지 않은 버킷: {bucket}"
            )
        return S3_BUCKET_NAME, _validated_key(key)

    return S3_BUCKET_NAME, _validated_key(link)


def _validated_key(key: str) -> str:
    """버킷 안에서도 엉뚱한 경로를 가리키지 못하게 막는다.

    S3는 디렉터리가 없어서 ".."가 상위로 올라가지는 않지만, 이 값이 나중에
    로컬 경로나 URL로 조립되는 자리로 흘러가면 의미가 생긴다. 애초에 정상 key에는
    들어갈 이유가 없으므로 여기서 거른다.
    """
    key = (key or "").lstrip("/")
    if not key:
        raise UntrustedFileLinkError("빈 S3 키")
    if ".." in key.split("/"):
        raise UntrustedFileLinkError(f"허용되지 않은 키: {key}")
    return key


def download_to_temp_from_s3(link: str) -> tuple:
    """S3 key(또는 s3:// URI)를 받아 임시 파일로 다운로드. 반환: (로컬경로, content_type)"""
    bucket, key = parse_s3_key(link)
    obj = s3.get_object(Bucket=bucket, Key=key)
    content_type = obj.get("ContentType", "")

    suffix = os.path.splitext(key)[1] or ""
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(obj["Body"].read())

    return tmp_path, content_type


def extract_text_from_audio_video(local_path: str) -> str:
    model = get_whisper_model()
    result = model.transcribe(local_path, language="ko")
    return result.get("text", "").strip()


def extract_text_from_caption(local_path: str) -> str:
    """VTT/SRT의 타임스탬프, 큐 번호, WEBVTT 헤더를 제거하고 텍스트 줄만 추출"""
    with open(local_path, "r", encoding="utf-8", errors="ignore") as f:
        raw = f.read()

    lines = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.upper().startswith("WEBVTT"):
            continue
        if re.match(r"^\d+$", line):  # 큐 번호
            continue
        if "-->" in line:  # 타임스탬프 라인
            continue
        lines.append(line)
    return " ".join(lines).strip()


def extract_text_from_document(local_path: str, ext: str) -> str:
    if ext == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(local_path)
        return "\n".join((page.extract_text() or "") for page in reader.pages).strip()
    elif ext == ".docx":
        import docx

        d = docx.Document(local_path)
        return "\n".join(p.text for p in d.paragraphs).strip()
    elif ext in (".txt", ".md"):
        with open(local_path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read().strip()
    return ""
