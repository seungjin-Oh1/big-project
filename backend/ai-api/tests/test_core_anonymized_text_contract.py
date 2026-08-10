"""core-api가 ai-api에 넘기는 anonymized_text의 계약.

RAG 검색 질의는 anonymized_text만 쓰고 원문으로 폴백하지 않는다
(docs/superpowers/specs/2026-08-05-family-law-consultation-rag-design.md 11절).
그래서 core-api가 이 값을 반드시 채워 보내야 검색이 돈다.

예전에는 저장해 둔 가림본 배열(call/inperson_input_texts_masked)에서 읽었다. 그러면
같은 개인정보가 원본과 가림본 두 벌로 남는데, 원본이 그대로 있으니 유출 대비가 되지
않으면서 보관량만 늘었다. 이제는 분석을 요청하는 그 자리에서 가려 넘기고 버린다.
"""
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[2]

RAW_INPUT_PATH = (BACKEND_DIR / "core-api" / "src" / "main" / "java" / "com" / "aivle"
                  / "bigproject" / "analysis" / "client" / "RawInputRequest.java")

SERVICE_PATH = (BACKEND_DIR / "core-api" / "src" / "main" / "java" / "com" / "aivle"
                / "bigproject" / "analysis" / "AiAnalysisService.java")

CONSULTATION_PATH = (BACKEND_DIR / "core-api" / "src" / "main" / "java" / "com" / "aivle"
                     / "bigproject" / "consultation" / "Consultation.java")


def test_core_raw_input_has_anonymized_text_field():
    source = RAW_INPUT_PATH.read_text(encoding="utf-8-sig")

    assert "String anonymizedText" in source


def test_core_masks_at_request_time_not_from_storage():
    source = SERVICE_PATH.read_text(encoding="utf-8-sig")

    start = source.index("private String buildCombinedAnonymizedText")
    end = source.index("private static List<String> nullSafe", start)
    method = source[start:end]

    # 요청 시점에 가린다.
    assert "sttMaskClient.redactText" in method
    # 저장된 가림본을 읽지 않는다 — 그 컬럼은 이제 존재하지도 않는다.
    assert "Masked" not in method


def test_consultation_no_longer_stores_masked_copies():
    source = CONSULTATION_PATH.read_text(encoding="utf-8-sig")

    assert "call_input_texts_masked" not in source
    assert "inperson_input_texts_masked" not in source
    # 원본은 그대로 보관한다 — 상담원이 정확한 내용을 봐야 한다.
    assert "call_input_texts" in source
    assert "inperson_input_texts" in source


def test_masking_failure_falls_back_to_null_not_raw():
    # 가림에 실패하면 null을 넘긴다. ai-api는 익명화 텍스트가 없으면 검색을 건너뛰므로
    # 원문이 검색 질의로 새지 않는다.
    source = SERVICE_PATH.read_text(encoding="utf-8-sig")

    start = source.index("private String buildCombinedAnonymizedText")
    end = source.index("private static List<String> nullSafe", start)
    method = source[start:end]

    assert "isBlank() ? null" in method
