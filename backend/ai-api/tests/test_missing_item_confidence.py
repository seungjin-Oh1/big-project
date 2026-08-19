"""누락 항목 검증 노드(app/ai/consult/graph.py validation_node)의 확신도 처리 테스트.

CONFIDENCE_THRESHOLD(0.7)는 절벽이라, 후보 전체가 0.5를 받으면 하나도 남지 않는다.
그러면 화면에는 "누락 자료 없음"으로 떠서, 자료를 다 받은 것인지 이번에 못 찾은
것인지 상담원이 구분할 수 없다. 운영 DB의 상담 4번이 같은 입력으로 한 번은 6건,
한 번은 0건을 냈다(analysis_id 2 / 3).

그래서 전부 걸러진 경우에는 버리지 않고 상위 몇 개를 low_confidence로 강등해 남긴다.
LLM도 네트워크도 쓰지 않는다 — validation_node에 가짜 LLM을 물려 확인한다.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.ai import config  # noqa: E402
from app.ai.consult import graph as G  # noqa: E402
from app.ai.consult.schemas import MissingItemValidated, ValidatedList  # noqa: E402


def _item(name, confidence):
    return MissingItemValidated(
        item=name,
        type="증빙",
        reason=f"{name}이(가) 필요함",
        confidence=confidence,
        evidence_check_note="원문에 제출 언급 없음",
    )


class _FakeLLM:
    def __init__(self, items):
        self._items = items

    async def ainvoke(self, _messages):
        return ValidatedList(validated=self._items)


def _run(items, monkeypatch):
    monkeypatch.setattr(G, "validation_llm", _FakeLLM(items))
    state = {"consult_text": "상담 원문", "candidate_missing_items": []}
    return asyncio.run(G.validation_node(state))["validated_missing_items"]


def test_임계값을_넘은_항목만_있으면_그대로_통과한다(monkeypatch):
    out = _run([_item("가족관계증명서", 0.9), _item("계좌이체 내역", 0.8)], monkeypatch)
    assert [o["item"] for o in out] == ["가족관계증명서", "계좌이체 내역"]
    assert all(o["low_confidence"] is False for o in out)


def test_임계값_미달_항목은_통과분과_섞이지_않는다(monkeypatch):
    out = _run([_item("가족관계증명서", 0.9), _item("애매한 자료", 0.5)], monkeypatch)
    assert [o["item"] for o in out] == ["가족관계증명서"]


def test_전부_걸러지면_버리지_않고_확신낮음으로_남긴다(monkeypatch):
    """예전에는 여기서 빈 목록이 나왔다. 그게 화면의 '누락 자료 없음'이었다."""
    out = _run([_item("갑", 0.5), _item("을", 0.6), _item("병", 0.4)], monkeypatch)
    assert out, "후보가 있었는데 전부 버리면 화면에서 실패가 안 보인다"
    assert all(o["low_confidence"] is True for o in out)
    # 점수 높은 순으로 남는다.
    assert [o["item"] for o in out] == ["을", "갑", "병"]


def test_강등해도_남기는_개수는_상한을_지킨다(monkeypatch):
    items = [_item(f"자료{i}", 0.5) for i in range(10)]
    out = _run(items, monkeypatch)
    assert len(out) == config.MISSING_ITEM_FALLBACK_KEEP


def test_후보가_아예_없으면_빈_목록_그대로다(monkeypatch):
    """진짜로 받을 자료가 없는 상담까지 억지로 채우지는 않는다."""
    assert _run([], monkeypatch) == []
