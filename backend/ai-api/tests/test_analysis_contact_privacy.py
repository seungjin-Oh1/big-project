"""구조화 분석 계층의 연락처 취급(app/ai/analysis/service.py) 테스트.

세 가지를 확인한다.
 - 주민등록번호는 어느 경로로도 남지 않는다(저장하지 않기로 한 값이다).
 - 전화번호는 구조화 분석 입력에는 남는다. 서식의 연락처칸에 들어가야 하는 값이라
   여기서 지우면 뽑아낼 값이 입력에 없어진다.
 - 출력 검증에 넘기는 사본에서는 서식용 연락처 키를 뺀다. 검증 스키마가
   extracted_json을 네 키로 못박아 두어서, 그대로 넘기면 모든 분석이 형식 오류가 된다.

네트워크도 LLM도 쓰지 않는다.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.ai.analysis import service as S  # noqa: E402

RRN = "901231-1234567"
PHONE = "010-2345-6789"
ADDR = "경기도 수원시 팔달구 인계로 178 삼성아파트 302동 1104호"


# ── 지우는 범위가 계층마다 다르다 ──

def test_판정계층_입력은_주민번호와_전화번호를_모두_지운다():
    out = S.scrub_sensitive_numbers(f"내담자 {RRN}, 연락처 {PHONE}")
    assert RRN not in out
    assert PHONE not in out


def test_구조화분석_입력은_전화번호를_남긴다():
    # 지우면 extracted_json의 전화번호칸에 넣을 값이 입력에 없어진다.
    out = S.scrub_resident_number(f"내담자 {RRN}, 연락처 {PHONE}")
    assert RRN not in out
    assert PHONE in out


# ── 요약에는 연락처가 남지 않는다 ──
# 요약은 변호사 검토와 구조대상 판단에 함께 쓰인다. 필요 없는 개인정보가 그 경로로
# 퍼지면 안 된다.

def test_요약에서_주소와_전화번호를_지운다():
    extracted = {"주소": ADDR, "전화번호": PHONE}
    summary = f"청구인은 {ADDR}에 거주하며 연락처는 {PHONE}입니다."
    out = S.strip_contact_from_summary(summary, extracted)
    assert ADDR not in out
    assert PHONE not in out


def test_연락처_얘기뿐인_문장은_통째로_버린다():
    # 값만 지우면 "내담자 주소는 이며 연락처는 입니다"가 남았다(실측).
    extracted = {"주소": ADDR, "전화번호": PHONE}
    summary = (f"청구인은 양육비 미지급으로 상담을 요청하였습니다. "
               f"내담자 주소는 {ADDR}이며 연락처는 {PHONE}입니다.")
    out = S.strip_contact_from_summary(summary, extracted)

    assert out == "청구인은 양육비 미지급으로 상담을 요청하였습니다."


def test_같은_문장의_다른_사실은_살린다():
    # 소득은 구조대상 판단에 쓰인다. 주소가 섞였다고 함께 버리면 안 된다.
    extracted = {"주소": ADDR}
    summary = f"청구인은 {ADDR}에 거주하며 마트에서 월 160만 원의 소득을 얻고 있습니다."
    out = S.strip_contact_from_summary(summary, extracted)

    assert ADDR not in out
    assert "월 160만 원의 소득" in out
    assert "[주소]" in out          # 값을 지우면 "청구인은 에 거주하며"가 된다


def test_괄호로_덧붙인_연락처도_문장째_버린다():
    extracted = {"주소": ADDR, "전화번호": PHONE}
    summary = (f"청구인은 본인의 주소({ADDR})와 연락처({PHONE})를 제공하였습니다. "
               f"미지급 양육비는 1,360만 원입니다.")
    out = S.strip_contact_from_summary(summary, extracted)

    assert out == "미지급 양육비는 1,360만 원입니다."


def test_추출값이_없으면_요약을_건드리지_않는다():
    summary = "청구인은 상속포기를 원합니다."
    assert S.strip_contact_from_summary(summary, None) == summary
    assert S.strip_contact_from_summary(summary, {}) == summary


# ── 한 문장에 알맹이와 연락처가 같이 있는 경우 ──
# 문장 단위로만 보면 아래 문장은 앞절 때문에 통째로 살아남아, 요약이 계속 연락처
# 얘기를 하게 된다(실측 — 재분석할 때마다 나왔다). 뒷절만 떼고 어미를 되살린다.

def test_뒤에_붙은_연락처_절만_떼어낸다():
    extracted = {"주소": ADDR, "전화번호": PHONE}
    summary = (f"소득·재산 및 증빙자료에 대한 구체적 언급은 없었으나, 서식 작성을 위해 "
               f"본인 주소 {ADDR}와 연락처 {PHONE}를 제공하고 개인정보 수집·이용에 동의하였음.")
    out = S.strip_contact_from_summary(summary, extracted)

    assert out == "소득·재산 및 증빙자료에 대한 구체적 언급은 없었음."


def test_절을_떼면_연결어미를_종결형으로_되돌린다():
    extracted = {"주소": ADDR}
    summary = f"청구인은 기초생활수급자이며, 주소 {ADDR}를 알려주었음."
    out = S.strip_contact_from_summary(summary, extracted)

    assert out == "청구인은 기초생활수급자임."


def test_어미를_되돌릴_수_없으면_문장을_건드리지_않는다():
    # 어설프게 잘라 부스러기를 남기느니 그대로 두는 편이 낫다.
    extracted = {"주소": ADDR}
    summary = f"청구인의 사정은 딱하다, 주소 {ADDR}를 제공하였다."
    out = S.strip_contact_from_summary(summary, extracted)

    assert out == "청구인의 사정은 딱하다, 주소 [주소]를 제공하였다."


def test_동의가_알맹이인_절은_남긴다():
    # '동의'는 연락처 상투어지만, 협의이혼 동의는 쟁점이다.
    extracted = {"주소": ADDR}
    summary = f"상대방은 협의이혼에 동의하였으며, 주소 {ADDR}를 알려주었음."
    out = S.strip_contact_from_summary(summary, extracted)

    assert "협의이혼에 동의" in out


# ── 출력 검증에 넘기는 사본 ──
# aioutputvalidation/schema/ai_analysis.schema.json이 extracted_json을
# required 4키 + additionalProperties:false로 두고 있어서, 아래 셋을 그대로
# 넘기면 "Additional properties are not allowed"가 난다.

def analysis_output(**extra):
    return {
        "summary": "요약",
        "case_type": "가사소송",
        "extracted_json": {
            "당사자": [{"역할": "채권자", "이름": "강윤서"}],
            "금액": 13600000,
            "날짜": [{"항목": "이혼", "값": "2024-03"}],
            "사건개요": "양육비 미지급",
            **extra,
        },
    }


def test_검증_사본에서_연락처_키를_뺀다():
    out = analysis_output(주소=ADDR, 전화번호=PHONE, 개인정보동의=True)
    clean = S.without_draft_contact(out)

    assert set(clean["extracted_json"]) == {"당사자", "금액", "날짜", "사건개요"}


def test_원본은_그대로_둔다():
    # 동의 화면이 이 값으로 주소·전화칸을 미리 채운다. 원본까지 지우면 안 된다.
    out = analysis_output(주소=ADDR, 전화번호=PHONE, 개인정보동의=True)
    S.without_draft_contact(out)

    assert out["extracted_json"]["주소"] == ADDR
    assert out["extracted_json"]["전화번호"] == PHONE


def test_스키마가_모르는_키는_전부_뺀다():
    # 허용리스트다. 연락처만이 아니라 화면 부산물(aiAnalysisResponse 등)까지 빠져야
    # extracted_json의 additionalProperties: false를 통과한다.
    out = analysis_output(주소=ADDR, 사건번호="2026느단1234", aiAnalysisResponse={})
    clean = S.without_draft_contact(out)

    assert set(clean["extracted_json"]) == {"당사자", "금액", "날짜", "사건개요"}
    assert clean["summary"] == "요약"
    assert clean["case_type"] == "가사소송"


def test_뺄_것이_없으면_그대로_돌려준다():
    out = analysis_output()
    assert S.without_draft_contact(out) is out


def test_모양이_다르면_건드리지_않는다():
    assert S.without_draft_contact(None) is None
    assert S.without_draft_contact({"extracted_json": "문자열"}) == {"extracted_json": "문자열"}


def test_이름_뒤_괄호에_붙은_연락처는_괄호째_지운다():
    # "신청인 강윤서(주소: …, 연락처: …)는 …" — 절로 잘리지 않아 절 단위 제거가 못 잡는다.
    extracted = {"주소": ADDR, "전화번호": PHONE}
    summary = (f"신청인 강윤서(주소: {ADDR}, 연락처: {PHONE})는 2024년 3월 "
               f"협의이혼하면서 양육비를 매월 80만 원씩 지급하기로 함.")
    out = S.strip_contact_from_summary(summary, extracted)

    assert out == ("신청인 강윤서는 2024년 3월 협의이혼하면서 "
                   "양육비를 매월 80만 원씩 지급하기로 함.")


def test_알맹이가_있는_괄호는_남긴다():
    extracted = {"주소": ADDR}
    summary = f"청구인({ADDR})의 자녀(초등학교 4학년, 11세)가 있음."
    out = S.strip_contact_from_summary(summary, extracted)

    assert out == "청구인의 자녀(초등학교 4학년, 11세)가 있음."


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
