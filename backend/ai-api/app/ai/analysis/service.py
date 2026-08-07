"""텍스트 -> AI_ANALYSIS 구조화 (파이프라인 2단계).

이 층이 파이프라인의 허브다. 뒤의 consult(판정) / forms(서식) / RAG는
서로를 모른 채 각자 이 결과만 읽는다.

입력은 텍스트뿐이다 — S3도 파일도 모른다(그건 ai/stt/의 일).
그래서 실시간 STT로 바뀌어도 이 층은 손댈 필요가 없고,
테스트할 때도 AWS 자격증명 없이 문자열만 넣으면 된다.
"""

import re
from typing import Optional

from app.ai.analysis.llm_client import analyze_consultation

# 주민등록번호·전화번호는 분석 입력에서 지운다.
#
# 분석은 마스킹본이 아니라 원문을 받는다(core-api buildCombinedInputText). 그래서
# 상담에서 불러준 주민등록번호가 그대로 외부 LLM으로 나가고, 요약에도 실려 DB에
# 저장된다 - 실측에서 요약이 "남편 백승현(870521-1284222)이"로 나왔다.
#
# 더 나쁜 것은 그 번호가 지어낸 값이었다는 점이다. STT가 뭉갠 소리
# ("팔치유공산 2.1을 2글팔 4.2.2")에서 모델이 형식만 완벽한 가짜 주민번호를
# 만들어냈다. 실제로 말한 번호와도 다르다. 법률 서류에 없는 주민번호가 올라가는
# 것은 빈칸보다 위험하고, 형식이 그럴듯해서 사람 눈으로는 걸러지지 않는다.
#
# 마스킹본을 통째로 쓰지 않는 이유: 이름까지 [PRIVATE_PERSON]이 되면 분석이
# 당사자를 못 뽑고, 그러면 서식 초안의 이름칸이 전부 빈다. 서식은 주민번호를
# AI가 채우지 않도록 이미 막혀 있으므로(FIELD_PROMPT 2번), 번호만 지우면
# 잃는 기능이 없다.
#
# 금액은 지우지 않는다. "2억", "200000000"까지 지우면 재산분할·양육비 분석이
# 통째로 무력해진다 - 자릿수만 보고 지우면 안 되는 이유다.
_RRN_RE = re.compile(r"\d{6}\s*[-~]\s*\d{7}")
_PHONE_RE = re.compile(r"0\d{1,2}\s*[-)]\s*\d{3,4}\s*[-]\s*\d{4}")


def scrub_sensitive_numbers(text: str) -> str:
    """주민등록번호·전화번호를 둘 다 지운다. 판정 계층(consult)이 쓴다.

    구조대상 판단과 누락자료 목록에는 어느 쪽 번호도 실릴 이유가 없다.

    구분자가 있는 형태만 지운다. 구분자 없는 긴 숫자를 지우면 금액과 사건번호가
    함께 사라진다."""
    if not text:
        return text
    return _PHONE_RE.sub("[전화번호]", scrub_resident_number(text))


def scrub_resident_number(text: str) -> str:
    """주민등록번호만 지운다. 구조화 분석 입력이 쓴다.

    전화번호는 남긴다 — 서식의 당사자 연락처칸에 들어가야 하는 값이라, 지우면
    분석이 뽑을 수가 없고 상담원이 초안을 받아 손으로 채워야 한다.

    주민등록번호는 계속 지운다. 이유가 전화번호와 다르다:
      · 개인정보 보호법 제24조의2 — 동의가 아니라 법령 근거가 있어야 처리할 수 있어
        애초에 보관하지 않기로 한 값이다. 서식에서도 [직접 기재]로 남긴다.
      · 지어낼 위험이 훨씬 크다. 실측에서 STT가 뭉갠 소리("팔치유공산 2.1을 2글팔
        4.2.2")를 모델이 형식만 완벽한 가짜 주민번호로 채웠고, 그게 요약에 실려
        DB까지 갔다. 형식이 그럴듯해서 사람 눈으로는 걸러지지 않는다.

    전화번호도 같은 위험이 있지만 두 가지가 다르다 — 상담원이 화면에서 눈으로
    확인·수정하는 단계를 거치고, 분석 프롬프트에도 "자릿수가 안 맞으면 null"이라고
    적어 두었다."""
    if not text:
        return text
    return _RRN_RE.sub("[주민등록번호]", text)


class ConsultAnalysis:
    """AI_ANALYSIS 계약 형태의 구조화 결과.

    case_type은 이 층 것을 쓴다. 대상 사건 범위가 "서식이 실제로 있는 대분류"로
    확정됐고, 그 목록이 이 모델의 분류체계와 같기 때문이다.

        app/schemas/analysis.py  CaseType     = 친족/상속/가사소송/가족관계등록
        app/ai/forms/recommender MVP_CATEGORIES = 친족/상속/가사소송/가족관계등록

    consult 층 classify_case_type의 8개 유형(임금체불·개인회생 등)은 서식이 없어
    초안 생성까지 이어지지 못한다. 또 대분류와 소분류를 서로 다른 모델이 만들면
    둘이 어긋날 수 있는데(예: 대분류 임금체불 + 소분류 상속재산분할), 한 모델이
    같이 만들면 그 문제가 없다.

    consult 층 노드는 그대로 둔다 — case_list(프론트 표시)와 소멸시효 계산이
    아직 그 8개 유형 이름에 묶여 있다.
    """

    def __init__(
        self,
        summary: Optional[str] = None,
        case_type: Optional[str] = None,
        case_subtype: Optional[str] = None,
        extracted: Optional[dict] = None,
        timeline: Optional[list] = None,
        output: Optional[dict] = None,
    ):
        self.summary = summary
        self.case_type = case_type
        self.case_subtype = case_subtype
        self.extracted = extracted
        self.timeline = timeline
        self.output = output

    def to_dict(self) -> dict:
        return {
            "consult_summary": self.summary,
            "consult_case_type": self.case_type,
            "consult_case_subtype": self.case_subtype,
            "consult_extracted": self.extracted,
            "consult_timeline": self.timeline,
        }


def build_consult_text(summary: str, details: str, extracted_text: str) -> str:
    """구조화 분석에 넣을 입력 텍스트 조합.

    상담원이 입력한 요약·상세에 첨부파일에서 뽑은 텍스트를 이어 붙인다.
    녹취록을 올린 경우 그 내용까지 요약·추출 대상이 되어야 하므로
    stt 단계 결과(extracted_text)가 반드시 포함되어야 한다.
    """
    # 주민등록번호만 지운다. 전화번호는 서식의 연락처칸에 들어가야 해서 남긴다
    # (scrub_resident_number 주석 참고).
    return scrub_resident_number(
        f"[요약]\n{summary or ''}\n\n"
        f"[상세]\n{details or ''}\n\n"
        f"[추출된 첨부내용]\n{extracted_text or ''}"
    )


def analyze(consult_text: str) -> ConsultAnalysis:
    """상담 텍스트를 AI_ANALYSIS 형태로 구조화한다.

    실패해도 예외를 올리지 않고 빈 결과를 돌려준다.
    이 단계가 실패했다고 뒤의 판정까지 막히면 안 되기 때문 —
    실제로 모델 과부하(503)나 스키마 검증 실패가 종종 발생한다.
    """
    if not consult_text or not consult_text.strip():
        return ConsultAnalysis()

    try:
        result = analyze_consultation(consult_text)
    except Exception as e:  # noqa: BLE001 - 이 단계 실패가 전체 파이프라인을 막지 않게 한다
        print(f"[ai.analysis] 구조화 분석 실패, 이 단계 없이 진행: {e}")
        return ConsultAnalysis()

    # 하위 필드가 Pydantic 모델이라 그대로 응답에 실으면 직렬화에서 막힌다.
    # model_dump()로 중첩까지 한 번에 dict/list로 바꾼다.
    data = result.model_dump()
    extracted = data.get("extracted_json")
    return ConsultAnalysis(
        summary=strip_contact_from_summary(data.get("summary"), extracted) or None,
        case_type=data.get("case_type"),
        case_subtype=data.get("case_subtype"),
        extracted=extracted,
        timeline=data.get("timeline_json"),
        output=data,
    )


# 서식 작성용으로 뽑는 키들.
#
# 계약(contracts/README_ai_analysis_contract.md 4절)은 extracted_json을 '유연
# key-value'로 두고 당사자·금액·날짜·사건개요를 '권장' 키로만 적어 두었는데,
# 출력 검증 스키마(aioutputvalidation/schema/ai_analysis.schema.json)는 그 넷을
# required + additionalProperties:false로 못박아 두었다. 그래서 아래 셋을 그대로
# 넘기면 "Additional properties are not allowed"로 모든 분석이 형식 오류가 된다
# (실측 1건). 스키마를 계약대로 완화하는 게 맞지만 그건 검증 모델 쪽 결정이라,
# 그때까지 검증기에 넘기는 사본에서만 뺀다.
#
# 저장·화면에 쓰는 원본은 건드리지 않는다 — 동의 화면이 이 값으로 주소·전화칸을
# 미리 채운다(DraftContactConsent).
DRAFT_CONTACT_KEYS = ("주소", "전화번호", "개인정보동의")


# 검증 스키마가 extracted_json에 허용하는 키. 계약(README_ai_analysis_contract.md
# 4절)이 '권장 키'로 적어 둔 넷과 같다.
#
# 실제 저장된 extracted_json에는 이 넷 말고도 화면 부산물이 잔뜩 들어간다 —
# aiAnalysisResponse(분석 응답 전체를 다시 넣은 것), extracted_content(STT 원문),
# case_list, case_emergency_*, attachment_links, submitted_file_link, 그리고
# output_validation(검증 결과가 검증 대상 안에 저장되어 있다). 전부 화면이 쓰는
# 값이지 검증할 주장이 아니다.
#
# 빼는 쪽이 아니라 남기는 쪽을 적는다. 목록에 없는 키가 새로 생겨도 검증이
# 저절로 깨지지 않는다 — 지금 겪은 문제가 정확히 그것이었다.
VALIDATED_EXTRACTED_KEYS = ("당사자", "금액", "날짜", "사건개요")


def without_draft_contact(output: dict) -> dict:
    """출력 검증에 넘길 사본을 만든다. 원본은 그대로 둔다.

    extracted_json에서 계약이 정한 네 키만 남긴다. 나머지는 화면 부산물이라
    검증 스키마(additionalProperties: false)에 걸려 형식 오류가 되는데, 스키마
    오류가 하나라도 있으면 검증기가 환각 위험을 무조건 '높음'으로 내린다
    (validator.validate: if errors or probability >= threshold). 그래서 멀쩡한
    분석이 빨간 칩으로 표시됐다.

    스키마를 고치지 않고 입력을 맞추는 이유: schema_error는 MLP의 학습 특징이라
    (observation_builder.py) 스키마를 완화하면 이미 학습·보정된 모델의 전제가
    함께 흔들린다.

    검증이 extracted_json에서 실제로 읽는 것은 사건개요 하나뿐이라
    (integration.extract_claims), 나머지를 빼도 주장은 달라지지 않는다."""
    if not isinstance(output, dict):
        return output
    extracted = output.get("extracted_json")
    if not isinstance(extracted, dict):
        return output
    kept = {k: v for k, v in extracted.items() if k in VALIDATED_EXTRACTED_KEYS}
    if len(kept) == len(extracted):
        return output
    return {**output, "extracted_json": kept}


# "주소(서울시 …)"처럼 괄호로 덧붙인 모양. 값을 지우면 빈 괄호가 남으므로 괄호째 지운다.
_CONTACT_PAREN_RE = "[(（][^)）]*{}[^)）]*[)）]"

# 값을 통째로 지우면 한국어는 조사에 붙어 있어 문장이 깨진다 — "내담자 주소는 이며
# 연락처는 입니다", "청구인은 에 거주하며"가 실제로 나왔다. 자리표시자로 바꾸면
# 문장이 성립하고, 같은 문장에 있던 다른 사실(소득·거주 형태 등)도 살아남는다.
# scrub_sensitive_numbers가 [주민등록번호]·[전화번호]를 쓰는 것과 같은 방식이다.
_CONTACT_TOKEN = {"주소": "[주소]", "전화번호": "[연락처]"}

# 연락처 얘기밖에 없는 문장인지 판정한다. 자리표시자·라벨·상투어를 걷어내고
# 남는 게 없으면 그 문장은 검토에 아무것도 보태지 않으므로 통째로 버린다.
# 연락처를 받았다는 사실 자체는 동의 기록(Consultation.privacyConsent)에 남는다.
_CONTACT_ONLY_NOISE_RE = re.compile(
    r"\[주소\]|\[연락처\]"
    r"|주\s*소|연\s*락\s*처|전\s*화\s*번\s*호|전\s*화|휴\s*대\s*폰"
    r"|내담자|청구인|신청인|본인|상담자"
    # '알려주었음'의 '주었'처럼 보조용언이 남으면 절이 안 비워진다. 주소보다 뒤에
    # 두어야 '주소'가 먼저 잡힌다(정규식 대안은 앞에 적은 것이 이긴다).
    r"|제공|알려|기재|확인|수집|말씀|안내|받았|받은|밝혔|전달|주었|주고|주며|줌"
    # 동의 문구를 이루는 상투어. 이것들만 남은 절은 "연락처를 받아 적었다"는
    # 절차 서술이지 검토 재료가 아니다 — 동의 사실은 Consultation.privacyConsent에 남는다.
    # 절 전체가 이 목록만으로 이루어졌을 때만 버려지므로, "상대방은 협의이혼에
    # 동의하였음"처럼 알맹이가 있는 절은 그대로 남는다.
    r"|서식|작성|위해|목적|개인정보|동의|이용|활용|처리"
    r"|[()（）\[\]:：;]"
    # 조사·어미만 남은 것은 알맹이가 아니다. "입니다"의 '입'처럼 하나라도 빠지면
    # 연락처뿐인 문장이 살아남으므로 종결어미 글자를 함께 넣는다.
    r"|[은는이가을를와과의로으에서도며고다요임입니습하였되됩있없함음,.·\s]"
)


def _is_contact_only(sentence: str) -> bool:
    """이 문장이 연락처 얘기만 담고 있는지."""
    return not _CONTACT_ONLY_NOISE_RE.sub("", sentence).strip()


# 한 문장에 알맹이와 연락처가 같이 들어 있는 경우가 있다(실측):
#   "소득·재산 및 증빙자료에 대한 구체적 언급은 없었으나, 서식 작성을 위해 본인
#    주소 [주소]와 연락처 [연락처]를 제공하고 개인정보 수집·이용에 동의하였음."
# 앞절은 구조대상 판단 재료라 살려야 하고 뒷절만 버려야 하는데, 문장 단위로 보는
# _is_contact_only로는 통째로 통과한다.
#
# 뒷절을 떼면 앞절이 연결어미로 끝나 "…없었으나,"가 된다. 아래 표로 종결형을
# 복원하되, 표에 없는 어미면 자르지 않고 문장을 그대로 둔다 — 어설프게 손대서
# 부스러기를 남기느니(이 함수가 이미 한 번 그래서 되돌렸다) 놔두는 편이 낫다.
_CONNECTIVE_END = (
    ("으나", "음"), ("았으나", "았음"), ("었으나", "었음"),
    ("지만", "음"), ("하지만", "함"),
    ("으며", "음"), ("하며", "함"), ("이며", "임"), ("되며", "됨"),
    ("하고", "함"), ("이고", "임"),
)


def _close_clause(text: str) -> str | None:
    """연결어미로 끝나는 절을 종결형으로 바꾼다. 못 바꾸면 None."""
    stripped = text.rstrip().rstrip(",")
    # 긴 어미부터 봐야 "었으나"가 "으나"로 잘못 잡히지 않는다.
    for ending, closing in sorted(_CONNECTIVE_END, key=lambda x: -len(x[0])):
        if stripped.endswith(ending):
            return stripped[: -len(ending)] + closing + "."
    return None


def _drop_contact_parens(text: str) -> str:
    """괄호 안이 연락처 얘기뿐이면 괄호째 걷어낸다.

    "신청인 강윤서(주소: [주소], 연락처: [연락처])는 …"처럼 이름 뒤에 괄호로 붙는 모양은
    절로 잘리지 않아 _drop_contact_clause가 못 잡는다(실측). "(초등학교 4학년, 11세)"처럼
    알맹이가 있는 괄호는 그대로 둔다.
    """
    return re.sub(
        r"\s*[(（]([^()（）]*)[)）]",
        lambda m: "" if _is_contact_only(m.group(1)) else m.group(0),
        text,
    )


def _drop_contact_clause(sentence: str) -> str:
    """문장 끝에 붙은 연락처 절만 떼어 낸다."""
    if "," not in sentence:
        return sentence
    clauses = sentence.split(",")
    kept = list(clauses)
    while len(kept) > 1 and _is_contact_only(kept[-1]):
        kept.pop()
    if len(kept) == len(clauses):
        return sentence                      # 뗄 절이 없다
    closed = _close_clause(",".join(kept))
    return closed if closed else sentence    # 어미를 못 고치면 손대지 않는다


def strip_contact_from_summary(summary: str, extracted: dict | None) -> str:
    """요약에서 주소·전화번호를 지운다.

    이 값들은 extracted_json의 전용 칸에 이미 들어가 있다. 요약에까지 실리면 같은
    개인정보가 두 군데에 쌓이고, 그 요약은 변호사 검토 화면에 그대로 뜬다. 연락처는
    사실관계도 쟁점도 아니라 검토에 쓸모도 없다.

    프롬프트에도 "요약에 쓰지 말라"고 적어 두었지만 지켜지지 않는다(실측: 두 번 연속
    "청구인은 본인의 주소(서울특별시 …)와 연락처(010-…)를 제공하였습니다"가 나왔다).
    이 파일이 여러 번 택한 방식대로, 프롬프트로 못 막는 것은 코드로 막는다.

    값만 지우면 "내담자 주소는 이며 연락처는 입니다"처럼 라벨과 어미만 남는다(실측).
    읽는 사람에게는 값이 지워졌다는 것도, 원래 무슨 값이었는지도 알려주지 않는
    부스러기라 절째로 걷어낸다. 연락처를 받았다는 사실 자체는 동의 기록
    (Consultation.privacyConsent)에 남으므로 요약이 떠안을 이유가 없다."""
    text = (summary or "").strip()
    if not text or not isinstance(extracted, dict):
        return text

    replaced = False
    for key, token in _CONTACT_TOKEN.items():
        value = str(extracted.get(key) or "").strip()
        if len(value) < 4 or value not in text:
            continue
        text = text.replace(value, token)
        replaced = True

    if not replaced:
        return text

    # 연락처 얘기만 하던 문장은 버린다. 나머지는 자리표시자를 남긴 채 둔다 —
    # "청구인은 [주소]에 거주하며 월 160만 원의 소득을 얻고 있습니다"처럼
    # 구조대상 판단에 필요한 사실이 같은 문장에 붙어 있는 경우가 있다.
    text = _drop_contact_parens(text)
    kept = [_drop_contact_clause(s) for s in re.split(r"(?<=[.!?])\s+", text)
            if s.strip() and not _is_contact_only(s)]
    text = " ".join(kept)

    # 괄호 안이 통째로 자리표시자면 괄호가 군더더기다 — "주소([주소])".
    text = re.sub(r"\s*[(（]\s*(\[주소\]|\[연락처\])\s*[)）]", r" \1", text)
    text = re.sub(r"\s{2,}", " ", text)
    return re.sub(r"\s+([,.·])", r"\1", text).strip()
