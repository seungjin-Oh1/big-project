"""출력 검증에 넘기기 전 단계 두 가지의 회귀 테스트.

validator는 스키마 오류가 하나만 있어도 근거 점수와 무관하게 '환각 위험 높음'을
강제하고(if errors or probability >= threshold), 근거가 0건이면 유사도가 전부 0.0이
되어 같은 결론에 이른다. 둘 다 '지어냈다'가 아닌데 화면에는 그렇게 뜬다.

- normalize_for_schema: 저장 형식과 검증 스키마의 모양 차이를 흡수한다.
- validate_consultation_output: 대조할 근거가 없으면 아예 판정하지 않는다.
"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.ai.output_validation.service import (  # noqa: E402
    normalize_for_schema,
    validate_consultation_output,
)

SCHEMA_PATH = ROOT.parents[1] / "aioutputvalidation" / "schema" / "ai_analysis.schema.json"


def stored(**over):
    """상담 45번이 실제로 DB에 갖고 있던 모양."""
    out = {
        "summary": "청구인은 양육비를 받지 못하고 있다.",
        "case_type": "가사소송",
        "case_subtype": "양육비직접지급명령",
        "urgency_level": "상",
        "eligibility": "검토 필요",
        "extracted_json": {
            "당사자": [{"역할": "청구인", "이름": "강윤서"}],
            "금액": 13600000,
            "날짜": [{"항목": "이혼", "값": "2024-03"}],
            "사건개요": "양육비 미지급",
            "주소": "경기도 수원시…",
            "전화번호": "010-8765-4321",
            "aiAnalysisResponse": {"status": "DRAFTED"},
        },
        "missing_info_json": ["소득증명서류"],
        "checklist_json": {
            "eligibility": {"eligible": "대상", "evidence_status": "미비"},
            "winnability": {"review_note": "정기금 채무"},
            "executability": {"debtor_asset_status": "판단 불가"},
            "appropriateness": {"case_nature": "사회적 약자 보호"},
            "requires_lawyer_review": True,
        },
        "timeline_json": [{"date": "2024년 3월", "text": "협의이혼 성립"}],
    }
    out.update(over)
    return out


def test_저장된_모양이_스키마를_통과한다():
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema = pytest.importorskip("jsonschema")

    errors = list(jsonschema.Draft202012Validator(schema).iter_errors(
        normalize_for_schema(stored())))

    assert errors == [], [e.message for e in errors]


def test_원본은_건드리지_않는다():
    out = stored()
    normalize_for_schema(out)

    assert out["eligibility"] == "검토 필요"
    assert isinstance(out["checklist_json"], dict)
    assert out["timeline_json"][0] == {"date": "2024년 3월", "text": "협의이혼 성립"}
    assert "주소" in out["extracted_json"]


@pytest.mark.parametrize("label,expected", [
    ("검토 필요", "확인필요"), ("구조 가능", "대상후보"), ("부적합", "비대상후보"),
    ("대상후보", "대상후보"), ("확인필요", "확인필요"),
])
def test_화면_라벨을_스키마_값으로_옮긴다(label, expected):
    assert normalize_for_schema(stored(eligibility=label))["eligibility"] == expected


def test_모르는_구조대상_값은_확인필요로_둔다():
    # 근거 없이 '대상후보'라고 말하지 않는 쪽이 안전하다.
    assert normalize_for_schema(stored(eligibility="???"))["eligibility"] == "확인필요"


def test_심사_4요건을_배열로_편다():
    checklist = normalize_for_schema(stored())["checklist_json"]

    assert [x["항목"] for x in checklist] == [
        "구조대상자 여부", "승소가능성", "집행가능성", "구조타당성"]
    # 판정 필드(eligible)를 가진 건 구조대상자 여부뿐. 나머지는 판단을 지어내지 않는다.
    assert [x["결과"] for x in checklist] == ["충족", "확인필요", "확인필요", "확인필요"]


def test_구조대상_판정을_그대로_옮긴다():
    out = stored()
    out["checklist_json"]["eligibility"]["eligible"] = "비대상"

    assert normalize_for_schema(out)["checklist_json"][0]["결과"] == "미충족"


def test_이미_배열이면_그대로_둔다():
    rows = [{"항목": "구조대상자 여부", "결과": "충족"}]

    assert normalize_for_schema(stored(checklist_json=rows))["checklist_json"] == rows


def test_연표_키를_한글로_옮긴다():
    assert normalize_for_schema(stored())["timeline_json"] == [
        {"날짜": "2024년 3월", "내용": "협의이혼 성립"}]


def test_연표가_이미_한글이면_유지한다():
    rows = [{"날짜": "2025-03", "내용": "미지급 시작"}]

    assert normalize_for_schema(stored(timeline_json=rows))["timeline_json"] == rows


def test_추출정보는_네_항목만_남긴다():
    extracted = normalize_for_schema(stored())["extracted_json"]

    assert set(extracted) == {"당사자", "금액", "날짜", "사건개요"}
    assert extracted["금액"] == 13600000


def test_빠진_항목은_빈_값으로_채운다():
    # 스키마 required라 빠지면 오류가 되는데, 없는 값을 지어내면 안 되므로 빈 값이다.
    extracted = normalize_for_schema(stored(extracted_json={"금액": 100}))["extracted_json"]

    assert extracted == {"당사자": [], "금액": 100, "날짜": [], "사건개요": ""}


@pytest.mark.parametrize("raw,expected", [("1,360만", 1360), ("13600000", 13600000), ("미상", None)])
def test_금액이_문자열이면_숫자만_읽는다(raw, expected):
    assert normalize_for_schema(stored(
        extracted_json={"금액": raw}))["extracted_json"]["금액"] == expected


def test_항목별_군더더기_키를_뺀다():
    out = stored()
    out["extracted_json"]["당사자"] = [{"역할": "청구인", "이름": "강윤서", "비고": "메모"}]

    assert normalize_for_schema(out)["extracted_json"]["당사자"] == [
        {"역할": "청구인", "이름": "강윤서"}]


def test_스키마가_모르는_최상위_키를_뺀다():
    assert "aiAnalysisResponse" not in normalize_for_schema(stored(aiAnalysisResponse={}))


def test_모양이_다르면_건드리지_않는다():
    assert normalize_for_schema(None) is None
    assert normalize_for_schema("문자열") == "문자열"


# ── 근거가 없을 때 ──────────────────────────────────────────────────────────
# 대조할 법령·판례가 0건이면 모든 유사도가 0.0이 되어 환각 확률이 1.0으로 찍힌다.
# '지어냈다'가 아니라 '비교할 게 없다'인데 화면에는 '환각 위험 높음'으로 뜬다.
# 상담 45번이 실제로 그랬다(마스킹본 0건 → anonymized_text null → 근거 0건, 실측).


@pytest.mark.parametrize("sources", [
    None, {}, {"related_statutes": [], "related_precedents": []},
    {"related_consultations": [{"content": "다른 상담"}]},   # 상담은 법적 근거가 아니다
])
def test_근거가_없으면_검증하지_않는다(sources):
    result = validate_consultation_output(analysis_output=stored(), legal_sources=sources)

    assert result["status"] == "unavailable"
    assert result["reason"] == "no_legal_sources"
    assert "decision" not in result      # 환각 위험을 단정하지 않는다


def test_분석결과가_없으면_검증하지_않는다():
    result = validate_consultation_output(
        analysis_output=None, legal_sources={"related_statutes": [{"content": "민법"}]})

    assert result == {"status": "unavailable", "reason": "analysis_output_missing"}


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
