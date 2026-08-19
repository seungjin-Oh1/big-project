"""첨부파일 -> 텍스트 변환 (파이프라인 1단계).

파일을 다루는 유일한 층이다. S3 접근도 Whisper 호출도 여기서만 일어나고,
뒤의 analysis/consult 층은 텍스트만 받는다.

이렇게 나눠두면 실시간 STT로 바뀔 때 이 층만 교체하면 되고,
분석·판정 코드는 손대지 않아도 된다.

(원래 app/ai/consult/graph.py의 process_multimodal_content_node에 있던 로직.
 그래프가 파일 다운로드까지 하고 있어서 층 구분이 안 되던 것을 분리했다.)
"""

import os
from urllib.parse import urlparse

from app.ai.stt.multimodal import (
    determine_file_category,
    download_to_temp_from_s3,
    extract_text_from_audio_video,
    extract_text_from_caption,
    extract_text_from_document,
)

# 추출 결과 자리에 들어가는 표식. 실제 내용이 아니므로 프롬프트에 넣을 때는 걸러낸다.
EMPTY_MARK = "내용없음"
ERROR_MARK = "파일 오류"


class ExtractResult:
    """파일별 추출 결과.

    texts   파일별 추출 텍스트 (실패 시 표식 문자열). details와 같은 인덱스
    details 파일별 처리 로그 — 프론트 "첨부파일 추출 처리 상태" 화면이 쓴다
    text    표식을 걸러 이어붙인 문자열. 프롬프트에 바로 넣는 용도
    """

    def __init__(self, texts: list[str], details: list[dict], text: str):
        self.texts = texts
        self.details = details
        self.text = text


def extract_all(file_links: list[str]) -> ExtractResult:
    """S3에 있는 파일들을 받아 텍스트로 변환한다.

    개별 파일 처리 실패가 전체를 막지 않는다 — 실패한 파일은 표식만 남기고 넘어간다.
    상담 하나에 첨부가 여러 개인데 그중 하나가 깨졌다고 분석 전체를 못 하면 안 되기 때문.
    """
    if not file_links:
        return ExtractResult([], [], "")

    texts: list[str] = []
    details: list[dict] = []

    for link in file_links:
        # file_type은 다운로드 전에 확장자만으로 먼저 정해둔다.
        # 다운로드가 실패해도 이 값이 None이면 안 되기 때문 — 응답 스키마의
        # ExtractedContentDetail.file_type이 필수 문자열이라, None이 나가면
        # 파일 하나 실패한 것뿐인데 응답 검증에서 요청 전체가 500이 된다.
        log = {
            "file_link": link,
            "status": "failed",
            "file_type": determine_file_category(link),
            "error": None,
        }
        entry = ERROR_MARK

        try:
            local_path, content_type = download_to_temp_from_s3(link)
            ext = os.path.splitext(urlparse(link).path)[1].lower()
            # 다운로드 후에는 content-type까지 보고 다시 판별한다.
            # (확장자 없는 S3 key는 이때만 제대로 분류된다)
            category = determine_file_category(link, content_type)
            log["file_type"] = category

            if category == "audio_video":
                text = extract_text_from_audio_video(local_path)
            elif category == "caption":
                text = extract_text_from_caption(local_path)
            elif category == "document":
                text = extract_text_from_document(local_path, ext)
            elif category == "unsupported_hwp":
                log["status"] = "unsupported"
                log["error"] = "HWP/HWPX 첨부에서 글자를 뽑는 경로는 아직 없습니다"
                details.append(log)
                texts.append(ERROR_MARK)
                continue
            else:
                log["status"] = "unsupported"
                log["error"] = f"인식할 수 없는 파일 유형 (content-type: {content_type})"
                details.append(log)
                texts.append(ERROR_MARK)
                continue

            if text:
                entry = text
                log["status"] = "success"
            else:
                entry = EMPTY_MARK
                log["status"] = "empty"
                log["error"] = "텍스트 추출 결과가 비어있음"

        except Exception as e:  # noqa: BLE001 - 파일 하나의 실패가 전체를 막지 않게 한다
            log["error"] = str(e)
            entry = ERROR_MARK

        details.append(log)
        texts.append(entry)

    usable = [t for t in texts if t not in (EMPTY_MARK, ERROR_MARK)]
    return ExtractResult(texts, details, "\n\n".join(usable))


def normalize_file_links(value) -> list[str]:
    """요청의 summited_file_link를 리스트로 정규화. 문자열 하나로 오는 경우도 받는다."""
    if isinstance(value, str):
        return [value] if value else []
    if not value:
        return []
    return list(value)
