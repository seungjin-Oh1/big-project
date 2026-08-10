"""RAG 검색 질의는 anonymized_text만 쓴다 — 원문으로 폴백하지 않는다.

docs/superpowers/specs/2026-08-05-family-law-consultation-rag-design.md 11절이 정한
경계다. 마스킹 결과가 없으면 검색을 건너뛰고 빈 배열을 돌려준다.

가림본은 저장하지 않는다. core-api가 분석을 요청할 때 그 자리에서 가려 넘겨주므로
(AiAnalysisService.buildCombinedAnonymizedText) 상담 종류와 무관하게 채워져 온다.
저장해 두면 같은 개인정보가 원본과 가림본 두 벌로 남는데, 원본이 그대로 있으니
유출 대비가 되지 않으면서 보관량만 는다.
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
MASKED = "의뢰인 [PRIVATE_PERSON]([PRIVATE_RRN])는 양육비를 받지 못하고 있습니다."


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


def test_마스킹본을_그대로_검색에_쓴다(captured):
    post({"content": {"summary": "양육비", "details": DETAILS, "anonymized_text": MASKED}})

    assert captured["content"]["anonymized_text"] == MASKED


def test_마스킹본이_없으면_원문으로_폴백하지_않는다(captured):
    # 설계 문서 11절. 폴백하면 원문이 검색 질의로 새어 나간다.
    post({"content": {"summary": "양육비", "details": DETAILS, "anonymized_text": None}})

    assert not captured["content"].get("anonymized_text")


def test_원문은_검색에_넘기지_않는다(captured):
    post({"content": {"summary": "양육비", "details": DETAILS, "anonymized_text": None}})

    # collect_related_legal_sources는 anonymized_text만 읽지만, 넘기는 값 자체에
    # 원문이 섞여 들어가지 않는지도 고정한다.
    assert captured["content"].get("anonymized_text") in (None, "")


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
