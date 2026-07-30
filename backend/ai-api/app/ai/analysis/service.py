"""텍스트 -> AI_ANALYSIS 구조화 (파이프라인 2단계).

이 층이 파이프라인의 허브다. 뒤의 consult(판정) / forms(서식) / RAG는
서로를 모른 채 각자 이 결과만 읽는다.

입력은 텍스트뿐이다 — S3도 파일도 모른다(그건 ai/stt/의 일).
그래서 실시간 STT로 바뀌어도 이 층은 손댈 필요가 없고,
테스트할 때도 AWS 자격증명 없이 문자열만 넣으면 된다.
"""

from typing import Optional

from app.ai.analysis.llm_client import analyze_consultation


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
        summary_headline: Optional[str] = None,
        summary_keywords: Optional[list] = None,
        case_type: Optional[str] = None,
        case_subtype: Optional[str] = None,
        extracted: Optional[dict] = None,
        timeline: Optional[list] = None,
    ):
        self.summary = summary
        # 화면 기본 표시용. summary(원재료)를 대체하는 게 아니라 그 위에 얹는 값이다.
        self.summary_headline = summary_headline
        self.summary_keywords = summary_keywords
        self.case_type = case_type
        self.case_subtype = case_subtype
        self.extracted = extracted
        self.timeline = timeline

    def to_dict(self) -> dict:
        return {
            "consult_summary": self.summary,
            "consult_summary_headline": self.summary_headline,
            "consult_summary_keywords": self.summary_keywords,
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
    return (
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
    return ConsultAnalysis(
        summary=(data.get("summary") or "").strip() or None,
        summary_headline=(data.get("summary_headline") or "").strip() or None,
        summary_keywords=data.get("summary_keywords") or [],
        case_type=data.get("case_type"),
        case_subtype=data.get("case_subtype"),
        extracted=data.get("extracted_json"),
        timeline=data.get("timeline_json"),
    )
