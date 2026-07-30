"""
app/agents/consult/schemas.py

기존 rescue_check/modal.py + missing_check/modal.py에 흩어져 있던 pydantic 스키마를
한 파일로 병합. 스키마 정의/검증 로직은 변경하지 않음 (API 단일화를 위한 이동/병합만 수행).

- LangGraph State(ConsultState)는 state.py로 분리.
- FastAPI 요청/응답 모델도 여기 유지 (기존과 동일하게 modal.py 역할).
"""

from typing import Optional, Literal, List, Union, get_origin, get_args

from pydantic import BaseModel, Field, model_validator
from pydantic_core import PydanticUndefined


# ---------------------------------------------------------------------------
# 공통 베이스 (기존 rescue_check/modal.py)
# ---------------------------------------------------------------------------

class LLMSignalBase(BaseModel):
    """LLM 구조화 출력 스키마 공통 베이스: Optional이 아닌 필드에 None -> 기본값 자동 보정.

    method="function_calling" 사용 시 모델이 값을 채우지 못하고 null을 반환하는
    경우가 있어(리스트 필드뿐 아니라 bool 등도 마찬가지), 검증 전(pre-validation)
    단계에서 "이 필드는 원래 None을 허용하지 않는데 None이 왔다"를 감지해
    pydantic에 정의된 기본값(default / default_factory)으로 치환한다.
    """

    @model_validator(mode="before")
    @classmethod
    def _coerce_none_to_default(cls, data):
        if not isinstance(data, dict):
            return data
        for name, field in cls.model_fields.items():
            if name not in data or data.get(name) is not None:
                continue
            annotation = field.annotation
            origin = get_origin(annotation)
            if origin is Union and type(None) in get_args(annotation):
                continue  # Optional[...] 필드는 None이 정상값이므로 그대로 둠
            default = field.get_default(call_default_factory=True)
            if default is not PydanticUndefined:
                data[name] = default
        return data


# ---------------------------------------------------------------------------
# 구조대상자 여부 - 신호 추출용 (판단 아님, Rule Engine 입력용 원자료만)
# (기존 rescue_check/modal.py)
# ---------------------------------------------------------------------------

class IncomePropertySignal(LLMSignalBase):
    """소득·재산 관련 언급 추출 (판단 아님, 신호만 추출 — 최종 판단은 Rule Engine)"""
    is_basic_livelihood_recipient_mentioned: Optional[bool] = Field(
        None, description="기초생활수급자라는 언급/암시가 상담 내용에 있는지"
    )
    is_near_poverty_class_mentioned: Optional[bool] = Field(
        None, description="차상위계층 언급 여부"
    )
    household_size: Optional[int] = Field(
        None, description="가구원 수. 언급 없으면 null (기준중위소득표 조회에 필요)"
    )
    monthly_income_estimate: Optional[float] = Field(
        None, description="상담 내용에서 추정 가능한 월평균소득(원). 언급 없으면 null"
    )
    is_small_business_context: bool = Field(
        False, description="소상공인 관련 사건 맥락인지 (150% 특례 적용 여부 판단용)"
    )
    income_evidence_mentioned: List[str] = Field(
        default_factory=list,
        description="소득증빙, 가족관계증명, 장애인 증명 등 언급/제공된 자료 목록"
    )
    # 기본값 "불명확": 모델이 이 키를 아예 빼고 {} 를 돌려주는 경우가 있다.
    # (상담 내용이 짧거나 첨부 추출이 실패해서 넣을 근거가 없을 때)
    # 필수로 두면 신호 하나 못 뽑은 것 때문에 그래프 전체가 죽는다.
    # 못 뽑았으면 "불명확"이 사실에 맞는 값이기도 하다 — 아래 신호들도 같은 이유.
    extraction_confidence: Literal["명시적", "추정", "불명확"] = Field(
        "불명확", description="위 정보가 상담 내용에 직접 언급됐는지, 정황상 추정인지"
    )


class SpecialStatusSignal(LLMSignalBase):
    """특정 신분 요건 관련 언급 추출"""
    matched_categories: List[Literal[
        "소년소녀가장", "모자가정", "장애인",
        "국내거주 저소득 외국인근로자",
        "법원 소송구조결정 피구조자",
        "국선변호 대상 피의자·피고인", "그 외"
    ]] = Field(default_factory=list)
    category_reasons: List[str] = Field(
        default_factory=list,
        description="카테고리별 판단 근거. '카테고리명: 근거 1문장' 형식 문자열 목록"
    )
    status_evidence_mentioned: List[str] = Field(default_factory=list)
    extraction_confidence: Literal["명시적", "추정", "불명확"] = "불명확"


# ---------------------------------------------------------------------------
# 승소가능성 / 집행가능성 / 구조타당성 - 체크리스트 신호 추출용 (결론 없음)
# (기존 rescue_check/modal.py)
# ---------------------------------------------------------------------------

class WinnabilitySignal(LLMSignalBase):
    """승소가능성 검토 보조 신호 (참고용 — 최종 판단은 조사담당변호사)"""
    submitted_evidence_types: List[str] = Field(default_factory=list)
    subjective_circumstances_summary: Optional[str] = Field(
        None, description="구조대상자의 주관적 사정 요약 (원문 인용 금지)"
    )
    statute_of_limitations_flag: Optional[Literal["완성 명백", "미완성", "계산 불가"]] = Field(
        None, description="Rule Engine이 계산 후 채워 넣는 필드 (LLM은 기산일만 추출)"
    )
    limitation_start_date: Optional[str] = Field(
        None, description="시효 기산일 (YYYY-MM-DD). 추출 불가하면 null"
    )
    limitation_period_years: Optional[float] = Field(
        None, description="적용 가능 시효기간(년). 명시적 언급/추정 가능하면 채움. 없으면 "
        "사건유형별 기본값(config.STATUTE_OF_LIMITATIONS_MAP)을 Rule Engine이 사용"
    )
    claim_existence_hint: Optional[Literal["청구권 존재 언급", "청구권 부존재 시사", "판단 불가"]] = None
    fact_provability_hint: Optional[Literal["입증 가능 시사", "입증 곤란 시사", "판단 불가"]] = None
    extraction_confidence: Literal["명시적", "추정", "불명확"] = "불명확"
    review_note: str = Field("", description="단정 표현 금지. '~로 보임' 형태만 사용")


class ExecutabilitySignal(LLMSignalBase):
    """집행가능성 검토 보조 신호"""
    debtor_asset_status: Optional[Literal["무재산자 언급", "소재불명 언급", "재산 확인 언급", "판단 불가"]] = None
    extraction_confidence: Literal["명시적", "추정", "불명확"] = "불명확"
    review_note: str = ""


class ReliefAppropriatenessSignal(LLMSignalBase):
    """구조타당성 검토 보조 신호"""
    case_nature: Optional[Literal["단순 개인간 이해다툼", "사회적 약자 보호", "판단보류"]] = None
    personal_motive_flags: List[Literal["남소 우려", "감정적 분쟁"]] = Field(default_factory=list)
    alternative_relief_mentioned: Optional[bool] = None
    low_value_claim_mentioned: Optional[bool] = None
    out_of_scope_flags: List[Literal["법인 관련 사건", "종중 관련 사건", "그 외"]] = Field(default_factory=list)
    extraction_confidence: Literal["명시적", "추정", "불명확"] = "불명확"
    review_note: str = ""


# ---------------------------------------------------------------------------
# Rule Engine 산출 스키마 (LLM 미개입, 우리 코드가 직접 채움)
# (기존 rescue_check/modal.py)
# ---------------------------------------------------------------------------

class EligibilityRuleResult(BaseModel):
    """법률구조법 대상 여부 - Rule Engine 최종 산출 (LLM 미개입, 유일하게 결론을 내는 항목)"""
    income_criterion_met: Optional[bool]
    status_criterion_met: bool
    matched_reasons: List[str]
    required_evidence: List[str]
    evidence_status: Literal["충족", "미비", "확인불가"]
    eligible: Literal["대상", "비대상", "판단보류"]
    applied_income_threshold_ratio: Optional[float] = None
    judgment_note: str = Field(
        description="'~로 보임' 등 참고용 표현. 단정적 법률판단 표현 금지"
    )


class ReliefReviewChecklist(BaseModel):
    """4대 평가기준 통합 체크리스트 (변호사 검토 화면용)"""
    eligibility: EligibilityRuleResult
    winnability: WinnabilitySignal
    executability: ExecutabilitySignal
    appropriateness: ReliefAppropriatenessSignal
    requires_lawyer_review: Literal[True] = True
    checklist_summary_for_lawyer: str


# ---------------------------------------------------------------------------
# 누락 항목 스키마 (기존 missing_check/modal.py)
# ---------------------------------------------------------------------------

MissingItemType = Literal["증빙", "사실관계"]

# 서류를 확보하는 방식 - document_mapping 단계에서 상담원/변호사 안내 문구 분기용으로 사용.
AcquisitionType = Literal["본인발급", "제3자발급", "절차확보"]


class ReferenceDocument(BaseModel):
    """missing_item 하나에 대응하는, 한국 내 실제 확인 가능 서류 1건."""
    doc_name: str = Field(description="서류의 정식 명칭 (예: 폐업사실증명원)")
    issuing_authority: str = Field(description="발급/작성 기관 (예: 관할 세무서, 근로복지공단)")
    acquisition_type: AcquisitionType = Field(
        description="본인발급 / 제3자발급 / 절차확보 중 하나"
    )
    acquisition_type_desc: str = Field(
        description="acquisition_type에 대한 1문장 부연 설명 (누가, 어떤 방식으로 확보하는지)"
    )
    online_issuance: bool = Field(description="온라인으로 즉시 발급 가능한지 여부")
    online_issuance_channel: Optional[str] = Field(
        default=None, description="온라인 발급 채널명 (예: 정부24, 홈택스). 불가 시 null"
    )
    related_law: Optional[str] = Field(
        default=None, description="근거 법령명 (해당되는 경우만, 없으면 null)"
    )
    notes: Optional[str] = Field(
        default=None, description="발급 제한사항, 소요기간, 대체 서류 등 실무 유의사항"
    )


class MissingItemCandidate(LLMSignalBase):
    """후보 생성(candidate_generation) 단계 출력 - 아직 검증 전"""
    item: str = Field(description="누락된 것으로 보이는 구체적 항목명")
    type: MissingItemType = Field(description="증빙자료 부족인지, 사실관계 미확정인지")
    reason: str = Field(description="왜 이 항목이 필요한지, 어떤 판단/서식 작성에 영향을 주는지")


class MissingItemValidated(MissingItemCandidate):
    """검증(validation) 단계 출력 - 신뢰도 점수 포함"""
    confidence: float = Field(
        ge=0.0, le=1.0,
        description="이 항목이 '실제로 원본 자료에 없다'는 판단에 대한 확신도 (0~1)",
    )
    evidence_check_note: str = Field(
        description="원본 텍스트를 재확인한 근거 요약 (왜 이 confidence를 매겼는지)"
    )


class MissingItemWithDocuments(MissingItemValidated):
    """서류 매핑(document_mapping) 단계 출력 - 실제 확인 가능 서류 목록 포함.
    최종 API 응답(missing_items)은 이 스키마 기준."""
    reference_documents: List[ReferenceDocument] = Field(
        default_factory=list,
        description="이 누락 항목을 확인/보완할 수 있는 한국 내 실제 서류 목록 (1~3개 권장)",
    )


class CandidateList(BaseModel):
    candidates: List[MissingItemCandidate] = Field(default_factory=list)


class ValidatedList(BaseModel):
    validated: List[MissingItemValidated] = Field(default_factory=list)


class DocumentMappedList(BaseModel):
    items: List[MissingItemWithDocuments] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# FastAPI 요청/응답 모델
# ---------------------------------------------------------------------------
#
# 기존에는 /case-analysis -> /eligibility/analyze -> /missing-data/analyze로
# 응답을 그대로 다시 받아 넘기는 3단계 요청 모델(RawInput/EligibilityCheckRequest/
# MissingDataCheckRequest)이 있었으나, 단일 API에서는 최초 입력 1개만 받으면 되므로
# RawInput/RawInputContent만 남기고 나머지 두 요청 모델은 쓰지 않는다.

class RawInputContent(BaseModel):
    summary: str
    details: str
    summited_file_link: List[str] = Field(default_factory=list)
    consult_day: Optional[str] = None


class RawInput(BaseModel):
    content: RawInputContent


class ExtractedContentDetail(BaseModel):
    file_link: str
    status: str
    file_type: str
    error: Optional[str] = None


class CaseTypeItemPayload(BaseModel):
    case_ratio: float = Field(ge=0.0, le=1.0)
    case_type: str
    case_type_reason: str


class CaseAnalysisPayload(BaseModel):
    """case_analysis 단계 산출 블록 (기존과 동일 구조)."""
    extracted_content: List[str] = Field(default_factory=list)
    extracted_content_detail: List[ExtractedContentDetail] = Field(default_factory=list)
    case_list: List[CaseTypeItemPayload] = Field(default_factory=list)
    case_emergency_ratio: Optional[float] = None
    case_emergency_level: Optional[str] = None
    case_emergency_reason: Optional[str] = None


class ConsultAnalyzeResponse(BaseModel):
    """단일화된 /consult/analyze 응답. 기존 3개 엔드포인트 응답을 하나로 합친 것."""
    raw_input: dict
    # app/ai/analysis 구조화 분석 결과. 생성에 실패하거나 상담 내용이 비어 있으면 None.
    # Optional로 둬서 core-api가 아직 이 필드를 안 읽는 상태로 배포돼도 문제없게 한다.
    consult_summary: Optional[str] = None
    # 화면 기본 표시용 두 값. consult_summary(원재료)와 함께 보내고, 대체하지 않는다.
    # 상담원·변호사 화면은 이 한 문장과 키워드를 먼저 보여주고, 전체 요약은 펼쳐서 본다.
    consult_summary_headline: Optional[str] = None
    consult_summary_keywords: Optional[List[str]] = None
    # 대상 사건 범위가 "서식이 실제로 있는 대분류"(친족/상속/가사소송/가족관계등록)로
    # 확정돼서, 사건유형도 이 층 값을 쓴다. case_analysis.case_list의 8개 유형은
    # 프론트 표시와 소멸시효 계산 때문에 그대로 남는다.
    consult_case_type: Optional[str] = None
    consult_case_subtype: Optional[str] = None
    consult_extracted: Optional[dict] = None
    consult_timeline: Optional[list] = None
    case_analysis: CaseAnalysisPayload
    relief_review_checklist: ReliefReviewChecklist
    missing_items: List[MissingItemWithDocuments]
