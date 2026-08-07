"""마스킹본이 없을 때 RAG 검색이 무엇을 질의어로 받는지 고정한다.

core-api는 마스킹본이 없으면 anonymized_text에 null을 보낸다
(AiAnalysisService.buildCombinedAnonymizedText → return null). 마스킹본은 실시간 STT
경로에서만 생겨서 수기 상담은 영영 비는데, 실제로 30건 중 28건이 그렇다.

폴백이 없으면 근거가 0건이 되고, 그러면 모든 주장의 유사도가 0.0이 되어 출력 검증이
'환각 위험 높음'을 내린다 — 지어낸 게 아니라 대조할 게 없는 것인데도(상담 45번 실측:
evidence 0.0 / p 1.0 / high_risk). 폴백을 넣은 뒤 같은 상담이 safe·evidence 0.8734가 됐다.
"""
import asyncio
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.ai.consult.schemas import RawInput  # noqa: E402
from app.routers import consult as consult_router  # noqa: E402

RRN = "900101-1234567"
DETAILS = f"의뢰인 강윤서({RRN})는 양육비를 받지 못하고 있습니다."


@pytest.fixture
def captured(monkeypatch):
    """RAG에 실제로 넘어간 content를 잡아 둔다. 무거운 단계는 전부 대체한다."""
    seen = {}

    class _Extracted:
        texts, details, text = [], [], ""

    class _Analysis:
        output = None

        def to_dict(self):
            return {}

    async def fake_graph(_state):
        return {}

    def fake_collect(*, content, top_n):
        seen["content"] = content
        return {"related_statutes": [], "related_precedents": [],
                "related_consultations": []}

    monkeypatch.setattr(consult_router.stt_extract, "normalize_file_links", lambda _: [])
    monkeypatch.setattr(consult_router.stt_extract, "extract_all", lambda _: _Extracted())
    monkeypatch.setattr(consult_router.analysis_service, "analyze", lambda _: _Analysis())
    monkeypatch.setattr(consult_router, "run_consult_analysis", fake_graph)
    monkeypatch.setattr(consult_router, "collect_related_legal_sources", fake_collect)
    monkeypatch.setattr(consult_router, "validate_consultation_output",
                        lambda **_: {"status": "unavailable", "reason": "stubbed"})
    return seen


def post(body):
    """라우터 함수를 직접 부른다 — 응답 모델이 아니라 RAG에 넘어간 값이 관심사다."""
    return asyncio.run(consult_router.analyze_consult(RawInput(**body)))


def test_마스킹본이_없으면_원문으로_검색한다(captured):
    post({"content": {"summary": "양육비", "details": DETAILS, "anonymized_text": None}})

    assert "양육비" in captured["content"]["anonymized_text"]


def test_폴백에서도_주민번호는_지운다(captured):
    # 로컬 검색이라 원문을 넘겨도 되지만, 번호까지 질의어에 실을 이유는 없다.
    post({"content": {"summary": "양육비", "details": DETAILS, "anonymized_text": None}})

    assert RRN not in captured["content"]["anonymized_text"]


def test_마스킹본이_있으면_그것을_쓴다(captured):
    post({"content": {"summary": "양육비", "details": DETAILS,
                      "anonymized_text": "[이름]은 양육비를 받지 못하고 있습니다."}})

    assert captured["content"]["anonymized_text"] == "[이름]은 양육비를 받지 못하고 있습니다."
    assert "강윤서" not in captured["content"]["anonymized_text"]


def test_원문도_없으면_빈_질의어가_된다(captured):
    post({"content": {"summary": "", "details": "", "anonymized_text": None}})

    assert not captured["content"]["anonymized_text"]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
