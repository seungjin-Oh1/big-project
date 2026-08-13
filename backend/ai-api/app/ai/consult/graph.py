"""
app/agents/consult/graph.py

기존 3개 그래프
  - case_analysis.graph.klac_graph      (parse_input -> ... -> combine_output)
  - rescue_check.graph.eligibility_graph (extract_all_signals -> eligibility_rule -> build_checklist)
  - missing_check.graph.missing_data_graph (candidate_generation -> validation -> document_mapping)
를 하나의 StateGraph(ConsultState)로 이어붙인 것. 각 노드의 로직/프롬프트는 그대로이며,
버튼 클릭 1번 = 그래프 1회 실행(run_consult_analysis)으로 끝나는 단일 API 구조를 위해
그래프 조립부만 통합했다.

- 개별 재실행/HITL 중간 재개 기능은 넣지 않음 (요청 범위 밖. 필요해지면 이후 별도 논의).
- 노드 함수 자체는 기존 3개 파일의 것을 그대로 옮겨왔다 (프롬프트/Rule Engine 변경 없음).
"""

import asyncio
import os
from datetime import date, datetime
from typing import List, Literal, Optional
from urllib.parse import urlparse

from dateutil.relativedelta import relativedelta
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

from app.ai import config
from .schemas import (
    CandidateList,
    DocumentMappedList,
    EligibilityRuleResult,
    ExecutabilitySignal,
    IncomePropertySignal,
    ReliefAppropriatenessSignal,
    ReliefReviewChecklist,
    SpecialStatusSignal,
    ValidatedList,
    WinnabilitySignal,
)
from .state import ConsultState


# ---------------------------------------------------------------------------
# 1. case_analysis 단계 전용 구조화 출력 스키마
#    (case_type_list/emergency는 다른 모듈에서 재사용되지 않아 기존처럼 graph.py에 둔다)
# ---------------------------------------------------------------------------

class CaseTypeItem(BaseModel):
    """사건 유형 분류 결과 중 하나의 후보 (참고용 — 최종 확정은 담당자 검토 필요)"""

    case_type: Literal[
        "임금체불", "개인회생", "개인파산", "불법사금융피해",
        "이혼", "상속", "가족관계", "기타",
    ] = Field(
        description="상담 요약/상세 내용/추출 콘텐츠에 기반한 사건 유형 후보"
    )
    case_ratio: float = Field(
        ge=0.0, le=1.0, description="해당 유형에 해당할 것으로 추정되는 비율(0.0~1.0). "
        "case_list 내 모든 case_ratio의 합은 1.0에 근접해야 함"
    )
    case_type_reason: str = Field(
        description="분류 근거를 1~2문장으로 요약. 단정적 표현('~이다', '~에 해당한다') 대신 "
        "'~로 판단됨', '~로 보임' 등 참고용 표현 사용"
    )


class CaseTypeListResult(BaseModel):
    """사건 유형 분류 결과 목록 (참고용 — 최종 확정은 담당자 검토 필요)."""

    case_list: List[CaseTypeItem] = Field(
        min_length=1,
        description="가능성이 높은 순서(case_ratio 내림차순)로 정렬된 사건 유형 후보 목록. "
        "가장 유력한 유형 1개만 있는 경우에도 리스트 형태(길이 1)로 반환",
    )


class EmergencyResult(BaseModel):
    """긴급도 분류 결과 (참고용 — 최종 확정은 담당자 검토 필요)"""

    case_emergency_ratio: float = Field(
        ge=0.0, le=1.0, description="0.0(비긴급)~1.0(매우 긴급) 사이의 긴급도 점수"
    )
    case_emergency_level: Literal["상", "중", "하"] = Field(
        description="긴급도 등급. 상: 생명/신체 위험, 소멸시효 임박, 강제집행 임박 등 즉시 대응 필요 "
        "/ 중: 수일~수주 내 대응 필요 / 하: 특별한 시한 압박 없음"
    )
    reason: str = Field(description="긴급도 판단 근거 1~2문장")


# ---------------------------------------------------------------------------
# 2. LLM 클라이언트 (모듈 로드 시 1회만 생성 -> 요청마다 재생성 안 함)
# ---------------------------------------------------------------------------

_case_llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
case_type_llm = _case_llm.with_structured_output(CaseTypeListResult)
emergency_llm = _case_llm.with_structured_output(EmergencyResult)

_rescue_llm = ChatOpenAI(model=config.MODEL_NAME, temperature=0)
income_signal_llm = _rescue_llm.with_structured_output(IncomePropertySignal, method=config.STRUCTURED_METHOD)
status_signal_llm = _rescue_llm.with_structured_output(SpecialStatusSignal, method=config.STRUCTURED_METHOD)
winnability_llm = _rescue_llm.with_structured_output(WinnabilitySignal, method=config.STRUCTURED_METHOD)
executability_llm = _rescue_llm.with_structured_output(ExecutabilitySignal, method=config.STRUCTURED_METHOD)
appropriateness_llm = _rescue_llm.with_structured_output(ReliefAppropriatenessSignal, method=config.STRUCTURED_METHOD)

_missing_llm = ChatOpenAI(model=config.MISSING_DATA_MODEL_NAME, temperature=0)
candidate_llm = _missing_llm.with_structured_output(CandidateList, method=config.STRUCTURED_METHOD)
validation_llm = _missing_llm.with_structured_output(ValidatedList, method=config.STRUCTURED_METHOD)
document_mapping_llm = _missing_llm.with_structured_output(DocumentMappedList, method=config.STRUCTURED_METHOD)


# ---------------------------------------------------------------------------
# 3. 프롬프트 - case_analysis 단계
# ---------------------------------------------------------------------------

CASE_TYPE_SYSTEM_PROMPT = """당신은 대한법률구조공단 내부 상담 지원 도구로서, 상담 내용을 바탕으로
사건 유형을 분류하는 보조 역할을 수행합니다.

[중요 원칙]
- 이 분류는 상담원/변호사/공익법무관의 업무를 보조하기 위한 참고 자료일 뿐이며,
  최종 사건 유형 확정 및 법률적 판단은 반드시 사람이 수행합니다.
- "~에 해당한다", "~이다"와 같은 단정적 법률판단 표현을 쓰지 말고,
  "~로 보임", "~가능성이 있음" 등 참고용 표현을 사용하세요.
- 상담 요약/상세 내용뿐 아니라, 첨부파일(녹취록/문서 등)에서 추출된 내용이 함께 제공될 수 있으니
  두 내용을 종합해서 판단하세요.
- 실제 상담 내용은 여러 유형에 걸쳐 있거나 모호한 경우가 많으므로, 하나의 유형으로만 단정하지 말고
  가능성이 있는 유형들을 case_ratio(비율)와 함께 여러 개 제시하세요. 가장 유력한 유형이 명확한
  경우에도 최소 1개 이상의 후보를 case_list 형태로 반환하고, 근거가 약한 유형까지 억지로 채우지는
  마세요(보통 1~3개 정도가 적당).
- case_list의 모든 case_ratio 합은 1.0에 근접해야 하며, case_ratio가 큰 순서대로 정렬해서 반환하세요.

[분류 대상 및 기준]
1. 임금체불: 임금, 급여, 퇴직금, 수당 등을 정당한 사유 없이 지급받지 못한 사례
   예) "3개월째 월급을 못 받았고 사장님이 연락을 피합니다" → 임금체불
2. 개인회생: 정기적 수입은 있으나 과다채무로 정상적인 상환이 어려운 경우
   예) "월급은 받고 있지만 카드빚, 대출이 너무 많아 매달 갚기 힘듭니다" → 개인회생
3. 개인파산: 소득이 없거나 매우 적어 채무 상환 자체가 사실상 불가능한 경우
   예) "실직 상태이고 재산도 없어서 빚을 갚을 방법이 없습니다" → 개인파산
4. 불법사금융피해: 미등록 대부업체 이용, 법정 최고금리 초과, 협박성 채권추심 등 피해 사례
   예) "미등록 사채업자에게 연 200% 이자를 요구받고 폭언과 협박을 당하고 있습니다" → 불법사금융피해
5. 이혼: 이혼 성립 여부/절차, 위자료, 재산분할, 양육비·양육권 등 이혼에 부수한 쟁점 일체
   예) "이혼했는데 전남편이 양육비를 6개월째 안 줍니다" → 이혼
6. 상속: 상속재산분할, 유류분, 상속포기·한정승인, 상속회복청구 등
   예) "아버지가 돌아가셨는데 형제가 유산을 독차지하려 합니다" → 상속
7. 가족관계: 친권·양육권 분쟁(이혼과 무관하게 발생한 경우), 부양료, 친생자관계, 가족관계등록부 정정 등
   위 5(이혼)/6(상속)에 해당하지 않는 가사 사건
   예) "혼인 외 자녀의 친생자 인지를 청구하고 싶습니다" → 가족관계
8. 기타: 위 7개 항목에 명확히 해당하지 않는 경우

각 후보는 위 8개 유형 중 하나여야 합니다."""


EMERGENCY_SYSTEM_PROMPT = """당신은 대한법률구조공단 내부 상담 지원 도구로서, 상담 내용의 긴급도를
분석하는 보조 역할을 수행합니다.

[중요 원칙]
- 이 분석은 참고용이며, 실제 대응 우선순위 결정은 상담원/변호사가 최종 판단합니다.
- 단정적 표현 대신 참고용 표현을 사용하세요.
- 상담 요약/상세 내용뿐 아니라, 첨부파일에서 추출된 내용이 함께 제공될 수 있으니 종합해서 판단하세요.

[긴급도 판단 기준 (참고 신호)]
- 상 (0.7~1.0): 생명·신체에 대한 위험(폭행/협박 지속 등), 소멸시효·제척기간 임박,
  강제집행(가압류/경매 등) 임박, 형사고소 기한 임박 등 즉시 대응이 필요한 경우
  예) "내일 모레 강제집행이 예정되어 있습니다" → 상, ratio 0.9 내외
- 중 (0.3~0.7 미만): 수일~수 주 내 대응이 필요하나 즉각적 위험은 아닌 경우
  예) "다음 달 소송 기일이 잡혀 있습니다" → 중, ratio 0.5 내외
- 하 (0.0~0.3 미만): 특별한 시한 압박이 없고 정보 제공 목적에 가까운 경우
  예) "제도가 궁금해서 문의드립니다" → 하, ratio 0.1 내외

사건 유형 후보 목록(case_list)과 상담 요약/상세 내용/추출 콘텐츠를 함께 고려하여
case_emergency_ratio(0.0~1.0)와 case_emergency_level(상/중/하)을 산출하세요."""


# ---------------------------------------------------------------------------
# 4. 프롬프트 - rescue_check 단계
# ---------------------------------------------------------------------------

RESCUE_COMMON_PRINCIPLE = """
[공통 원칙]
- 당신은 대한법률구조공단 내부 상담 지원 도구의 정보 추출 보조 역할만 수행합니다.
- 최종 법률적 판단(대상 여부, 승소가능성, 집행가능성, 구조타당성)은 절대 스스로 내리지 말고,
  상담 내용에 드러난 "신호"만 정직하게 추출하세요. 언급이 없으면 반드시 null / 판단 불가로 표기하세요.
- "~에 해당한다", "~이다" 같은 단정적 법률판단 표현을 쓰지 말고, "~로 보임", "~로 언급됨" 형태만 사용하세요.
- 상담 요약/상세/추출된 첨부파일 내용을 종합해서 신호를 추출하세요.
"""

INCOME_PROPERTY_PROMPT = RESCUE_COMMON_PRINCIPLE + """
[추출 대상]
기초생활수급자/차상위계층 여부, 가구원 수, 월평균소득 추정치, 소상공인 사건 맥락 여부,
언급된 소득 관련 소명자료(소득증빙/가족관계증명/장애인 증명 등)를 추출하세요.
"""

SPECIAL_STATUS_PROMPT = RESCUE_COMMON_PRINCIPLE + """
[추출 대상 카테고리]
소년소녀가장, 모자가정, 장애인, 국내거주 저소득 외국인근로자(임금/퇴직금/산재 사건 한정),
법원 소송구조결정 피구조자, 국선변호 대상 피의자·피고인, 그 외.
상담 내용이 위 카테고리 중 어디에도 명확히 해당하지 않으면 "그 외"만 반환하세요.

[같은 뜻인데 말이 다른 경우]
카테고리 이름은 옛 법령 용어라 상담에서 쓰는 말과 다릅니다. 뜻이 같으면
해당 카테고리로 분류하세요 - 글자가 다르다는 이유로 "그 외"로 보내면
구조대상 판정에서 통째로 빠집니다.

- 한부모가정, 한부모가족, 부자가정, 모자가족 -> "모자가정"
  (「한부모가족지원법」 지원대상자가 여기 해당합니다. 아버지가 홀로 키우는
   경우도 같습니다 - 카테고리 이름이 '모자'라고 해서 어머니로 한정하지 마세요.)
- 조손가정에서 미성년자가 실질적으로 가정을 이끄는 경우 -> "소년소녀가장"
- 장애등급·장애정도 판정을 받았다는 언급 -> "장애인"

지원을 "받고 있다"는 말은 그 자격이 확인됐다는 뜻이므로 명시적 언급으로 봅니다.
"""

WINNABILITY_PROMPT = RESCUE_COMMON_PRINCIPLE + """
[추출 대상]
제출/언급된 자료 종류, 구조대상자의 주관적 사정 요약(원문 인용 금지, 1~2문장 요약만),
소멸시효 기산일 및 적용 가능 시효기간(추출 가능한 경우만), 청구권 존재/부존재 시사, 사실관계 입증 가능성 시사.

[소멸시효 기산일(limitation_start_date) 추출 시 주의]
- 기산일은 "청구권 자체가 발생한 원인이 된 사건의 날짜"가 아니라, "실제로 의무 위반/불이행이
  시작되어 권리를 행사할 수 있게 된 날짜"여야 합니다. 두 날짜가 다른 경우가 많으니 혼동하지 마세요.
  예) "이혼한 지 6개월이 됐는데 전남편이 양육비를 6개월째 안 줍니다"
      -> 기산일은 이혼일이 아니라 "양육비를 지급하지 않기 시작한 날"입니다.
         (이혼일은 양육비 채무가 발생한 원인 사실일 뿐, 불이행은 그 이후 시작됨)
- 양육비/부양료처럼 매달 반복 지급되는 정기금 채무의 경우 회차마다 이행기가 다르므로,
  상담 내용에서 특정할 수 있는 가장 이른 "미지급 시작일"을 기산일로 추출하고,
  정확한 회차별 기산일까지는 특정하기 어렵다는 점을 review_note에 함께 남기세요.
- 상담 내용만으로 기산일을 특정하기 어려우면 추측하지 말고 반드시 null로 두세요.
- limitation_period_years는 참고용으로만 추출하세요. 실제 시효기간 계산은 사건유형별
  기준표(팀이 검토한 값)를 사용하는 Rule Engine이 전담하며, 여기서 추출한 값은
  최종 계산에 반영되지 않습니다.
"""

EXECUTABILITY_PROMPT = RESCUE_COMMON_PRINCIPLE + """
[추출 대상]
상대방(피고)의 재산 상태에 대한 언급 - 무재산자/소재불명/재산 확인 여부.
"""

APPROPRIATENESS_PROMPT = RESCUE_COMMON_PRINCIPLE + """
[추출 대상]
사건 성격(단순 개인간 이해다툼 vs 사회적 약자 보호), 남소 우려/감정적 분쟁 여부,
대안적 권리구제 수단 언급 여부, 소액 사건 여부, 업무범위 외 사유(법인/종중 관련 등).
"""


# ---------------------------------------------------------------------------
# 5. 프롬프트 - missing_check 단계
# ---------------------------------------------------------------------------

MISSING_COMMON_PRINCIPLE = """
[공통 원칙]
- 당신은 대한법률구조공단 내부 상담 지원 도구의 정보 추출 보조 역할만 수행합니다.
- 사건유형 후보(case_list)와 무관하게 동일한 기준으로 판단하세요 (유형별 특칙 적용 금지).
- "~에 해당한다", "~이다" 같은 단정적 법률판단 표현을 쓰지 말고 참고용 표현만 사용하세요.
- 이 결과는 참고자료이며, 최종 판단은 담당 변호사/공익법무관이 수행합니다 (HITL).
"""

CANDIDATE_PROMPT = MISSING_COMMON_PRINCIPLE + """
[추출 목적]
아래 사건 정보를 보고, 이후 단계(서식 작성, 구조검토 4대 기준 판단)에 필요하지만
아직 확보되지 않았거나 확정되지 않은 항목의 후보를 찾으세요.

- 구조검토 4대 기준: 구조대상자 여부 / 승소가능성 / 집행가능성 / 구조타당성
- relief_review_checklist에 이미 드러난 미비 사항(evidence_status, required_evidence,
  각 항목의 review_note)은 최소 기준선으로 삼되, 원본 텍스트를 다시 훑어 그 외에
  빠진 것도 찾으세요.
- 각 후보에는 항목명(item), 종류(증빙/사실관계), 이유(reason)를 함께 답하세요.

[누락자료로 올리면 안 되는 것]
아래 [사건 자료]는 상담을 녹음해 받아쓴 것입니다. 즉 상담 내용 자체는 이미
확보된 자료입니다. 그런데도 "상담 녹취록", "상담 내용", "통화 녹음",
"상담 기록"을 받아야 할 자료로 올리는 일이 있는데, 지금 읽고 있는 그것을
달라는 말이 되어 앞뒤가 맞지 않습니다. 목록에 넣지 마세요.

같은 이유로 아래도 제외합니다.
- 상담원이 작성하는 것 (상담일지, 접수서, 분석 결과)
- 이 시스템이 만들어 주는 것 (서식 초안)

여기 올릴 것은 **내담자가 밖에서 발급받거나 가져와야 하는 자료**입니다
(가족관계증명서, 기본증명서, 사망진단서, 부채증명서, 소득금액증명 등).

[사건유형 후보 (참고용, case_analysis 결과 — 비율 순)]
{case_list_text}

[사건 자료 (요약 + 상세 + 추출된 첨부내용)]
{consult_text}

[구조검토 체크리스트 결과]
{relief_review_checklist}
"""

VALIDATION_PROMPT = MISSING_COMMON_PRINCIPLE + """
[검증 목적]
아래는 "누락되었다"고 제시된 후보 항목 목록과, 그 사건의 원본 자료입니다.
각 후보에 대해 원본 자료를 다시 확인하여:

1. 정말로 원본 자료 어디에도 해당 정보/자료가 없는지 재검토하세요.
   (이미 원문에 있는데 후보 생성 단계에서 놓친 경우 confidence를 낮게 주세요)
2. confidence(0~1)를 매기세요. 기준은 **"그 자료를 지금 확보하고 있는가"** 하나입니다.

   그 주제가 상담에서 화제에 올랐는지, 필요하다고 명시적으로 말했는지는 기준이
   아닙니다. 누락 후보는 애초에 상담에서 언급된 이야기에서 나오므로, 언급됐다는
   이유로 점수를 깎으면 모든 항목이 중간값에 몰려 하나도 남지 않습니다.
   실제로 그런 일이 있었습니다 — 전 항목이 0.5를 받아 전부 걸러졌습니다.

   - 0.9~1.0: 그 자료를 제출했다거나 이미 갖고 있다는 말이 원문에 없음.
              그 주제를 이야기하기만 한 것은 확보가 아닙니다.
              (예: "남편 예금이 얼마인지 모른다" -> 재산 내역은 확보 안 됨, 1.0)
   - 0.4~0.6: 갖고 있다고는 하나 범위나 최신성이 불확실함
              (예: "문자가 조금 남아 있다")
   - 0.0~0.3: 원문에 이미 제출·확보했다고 나와 있거나, 이 사건과 무관한 항목임
3. evidence_check_note에 재확인 근거를 간단히 남기세요.
   "필요성이 명확히 언급되지 않음"은 근거가 되지 않습니다. 원문의 어느 대목을
   보고 확보 여부를 판단했는지 쓰세요.

[원본 사건 자료]
{consult_text}

[누락 후보 목록]
{candidates}
"""

DOCUMENT_MAPPING_PROMPT = MISSING_COMMON_PRINCIPLE + """
[매핑 목적]
아래는 검증을 통과한 "누락 항목" 목록입니다. 각 항목에 대해, 대한민국에서
실제로 발급/확인 가능한 서류를 1~3개씩 찾아 reference_documents로 제시하세요.

[매핑 규칙]
- doc_name / issuing_authority는 실존하는 서류명·기관명만 사용하세요.
  존재를 확신할 수 없는 서류는 만들어내지 말고, 확실한 것만 제시하세요 (할루시네이션 금지).
- acquisition_type을 반드시 아래 세 가지 중 하나로 분류하세요.
  - "본인발급": 당사자가 정부24/홈택스 등에서 스스로 즉시 발급 가능
  - "제3자발급": 상대방·기관이 보유/신고한 내역을 당사자가 열람·요청해야 함
  - "절차확보": 진정/소송 등 공식 절차(법원 조회명령, 근로감독관 조사 등)를 거쳐야만 확보됨
- online_issuance/online_issuance_channel은 실제 온라인 발급 가능 여부에 맞게 정확히 표기하세요.
  (모르면 online_issuance=false, channel=null)
- 이 서류 목록은 상담원/변호사가 다음 행동을 정하는 데 참고하는 자료이며,
  "반드시 이 서류가 있어야 한다"는 단정적 표현은 피하세요 (참고용 안내).

[검증 통과 누락 항목 목록]
{validated_items}
"""


# ---------------------------------------------------------------------------
# 6. Rule Engine 함수 (기존 rescue_check/graph.py, 로직 변경 없음)
# ---------------------------------------------------------------------------

def apply_eligibility_rules(
    income_signal: IncomePropertySignal,
    status_signal: SpecialStatusSignal,
) -> EligibilityRuleResult:
    reasons: List[str] = []
    income_met: Optional[bool] = None
    applied_ratio: Optional[float] = None

    if income_signal.is_basic_livelihood_recipient_mentioned:
        income_met = True
        reasons.append("기초생활수급자")
    elif income_signal.is_near_poverty_class_mentioned:
        income_met = True
        reasons.append("차상위계층")
    elif income_signal.monthly_income_estimate is not None:
        threshold = config.get_income_threshold(
            income_signal.household_size, income_signal.is_small_business_context
        )
        applied_ratio = (
            config.INCOME_THRESHOLD_RATIO_SMALL_BIZ
            if income_signal.is_small_business_context
            else config.INCOME_THRESHOLD_RATIO_DEFAULT
        )
        if threshold is None:
            income_met = None  # 가구원수 미상 or 해당 연도 고시표 없음 -> 계산 불가
        else:
            income_met = income_signal.monthly_income_estimate <= threshold
            if income_met:
                reasons.append("월평균소득 기준 이하")

    status_categories = status_signal.matched_categories
    only_other = status_categories == ["그 외"]
    status_met = bool(status_categories) and not only_other
    if status_met:
        reasons.extend([c for c in status_categories if c != "그 외"])

    required_evidence = config.map_reasons_to_required_evidence(reasons)
    provided = set(income_signal.income_evidence_mentioned + status_signal.status_evidence_mentioned)
    missing = [e for e in required_evidence if e not in provided]

    if not required_evidence:
        evidence_status = "확인불가"
    elif not missing:
        evidence_status = "충족"
    elif provided:
        evidence_status = "미비"
    else:
        evidence_status = "확인불가"

    if income_met or status_met:
        eligible = "대상"
    elif only_other or (income_met is None and not status_categories):
        eligible = "판단보류"
    else:
        eligible = "비대상"

    reason_text = ", ".join(reasons) if reasons else "해당 사유 없음"
    return EligibilityRuleResult(
        income_criterion_met=income_met,
        status_criterion_met=status_met,
        matched_reasons=reasons,
        required_evidence=required_evidence,
        evidence_status=evidence_status,
        eligible=eligible,
        applied_income_threshold_ratio=applied_ratio,
        judgment_note=f"{reason_text}을(를) 근거로 {eligible}로 보임",
    )


def compute_statute_of_limitations(
    signal: WinnabilitySignal, case_type: Optional[str] = None
) -> WinnabilitySignal:
    """소멸시효 완성 여부 계산. 시효 "기간"은 반드시 config.STATUTE_OF_LIMITATIONS_MAP에서만 가져온다."""
    period = config.STATUTE_OF_LIMITATIONS_MAP.get(case_type) if case_type is not None else None

    if not signal.limitation_start_date or period is None:
        signal.statute_of_limitations_flag = "계산 불가"
        return signal
    try:
        start = datetime.strptime(signal.limitation_start_date, "%Y-%m-%d").date()
    except ValueError:
        signal.statute_of_limitations_flag = "계산 불가"
        return signal

    years = int(period)
    months = int(round((period - years) * 12))
    expiry = start + relativedelta(years=years, months=months)

    signal.statute_of_limitations_flag = "완성 명백" if date.today() > expiry else "미완성"
    return signal


# ---------------------------------------------------------------------------
# 7. 헬퍼
# ---------------------------------------------------------------------------

def _build_context_text(state: ConsultState) -> str:
    """case_analysis 단계(사건유형/긴급도 분류) 프롬프트용 텍스트 조합."""
    parts = [
        f"[상담 요약]\n{state.get('summary', '')}",
        f"[상세 내용]\n{state.get('details', '')}",
    ]
    extracted_list = state.get("extracted_content") or []
    usable_texts = [t for t in extracted_list if t not in ("내용없음", "파일 오류")]
    if usable_texts:
        parts.append("[첨부파일에서 추출된 내용]\n" + "\n\n".join(usable_texts))
    return "\n\n".join(parts)


def _consult_text(state: ConsultState) -> str:
    """rescue_check/missing_check 단계 프롬프트용 텍스트 조합.
    (기존 rescue_check.graph._consult_text / missing_check.graph._consult_text와 동일 포맷.
    extracted_content_text는 build_extracted_text 단계에서 미리 걸러 이어붙인 문자열)"""
    summary = state.get("summary", "")
    details = state.get("details", "")
    extracted = state.get("extracted_content_text", "")
    return f"[요약]\n{summary}\n\n[상세]\n{details}\n\n[추출된 첨부내용]\n{extracted}"


def _case_list_text(state: ConsultState) -> str:
    case_list = state.get("case_list") or []
    if not case_list:
        return "(사건유형 후보 정보 없음)"
    return ", ".join(
        f"{c.get('case_type')}({c.get('case_ratio', 0):.0%})" for c in case_list
    )


def _primary_case_type(state: ConsultState) -> Optional[str]:
    """case_list에서 case_ratio가 가장 높은 유형 1개를 고른다 (코드 레벨 조회 전용 헬퍼)."""
    case_list = state.get("case_list") or []
    if not case_list:
        return None
    top = max(case_list, key=lambda c: c.get("case_ratio", 0.0))
    return top.get("case_type")


# ---------------------------------------------------------------------------
# 8. LangGraph 노드 - case_analysis 단계
# ---------------------------------------------------------------------------

def parse_input_node(state: ConsultState) -> dict:
    """Input 노드: 원본 {"content": {...}} 구조를 State 필드로 펼침.

    첨부파일 텍스트(extracted_*)는 이 그래프가 만들지 않는다.
    앞단 stt 층(app/ai/stt/extract.py)이 이미 뽑아서 넘겨준 값을 그대로 받는다.
    이 그래프는 파일도 S3도 모르고 텍스트만 다룬다.
    """
    raw = state["raw_input"]
    content = raw["content"]
    extracted = raw.get("extracted") or {}

    return {
        "summary": content.get("summary", ""),
        "details": content.get("details", ""),
        "consult_day": content.get("consult_day", ""),
        "extracted_content": extracted.get("texts", []),
        "extracted_content_detail": extracted.get("details", []),
        "extracted_content_text": extracted.get("text", ""),
    }


def classify_case_type_node(state: ConsultState) -> dict:
    user_msg = f"[상담일] {state.get('consult_day', '')}\n\n" + _build_context_text(state)
    result: CaseTypeListResult = case_type_llm.invoke(
        [SystemMessage(content=CASE_TYPE_SYSTEM_PROMPT), HumanMessage(content=user_msg)]
    )
    case_list = [
        {
            "case_ratio": item.case_ratio,
            "case_type": item.case_type,
            "case_type_reason": item.case_type_reason,
        }
        for item in sorted(result.case_list, key=lambda x: x.case_ratio, reverse=True)
    ]
    return {"case_list": case_list}


def classify_emergency_node(state: ConsultState) -> dict:
    case_list = state.get("case_list") or []
    case_list_text = ", ".join(
        f"{item['case_type']}({item['case_ratio']:.0%})" for item in case_list
    )
    user_msg = f"[사건 유형 후보(참고용 분류 결과)] {case_list_text}\n\n" + _build_context_text(state)
    result: EmergencyResult = emergency_llm.invoke(
        [SystemMessage(content=EMERGENCY_SYSTEM_PROMPT), HumanMessage(content=user_msg)]
    )
    return {
        "case_emergency_ratio": result.case_emergency_ratio,
        "case_emergency_level": result.case_emergency_level,
        "case_emergency_reason": result.reason,
    }


def combine_case_analysis_node(state: ConsultState) -> dict:
    """case_analysis 응답 블록으로 결합 (기존 case_analysis.graph.combine_output_node와 동일)."""
    case_analysis = {
        "extracted_content": state.get("extracted_content", []),
        "extracted_content_detail": state.get("extracted_content_detail", []),
        "case_list": state.get("case_list", []),
        "case_emergency_ratio": state.get("case_emergency_ratio"),
        "case_emergency_level": state.get("case_emergency_level"),
        "case_emergency_reason": state.get("case_emergency_reason"),
    }
    return {"case_analysis": case_analysis}


# ---------------------------------------------------------------------------
# 9. LangGraph 노드 - rescue_check 단계
# ---------------------------------------------------------------------------

async def extract_all_signals_node(state: ConsultState) -> dict:
    """5개 신호 추출 LLM 호출을 asyncio.gather로 동시에 실행 (지연시간 단축)."""
    text = _consult_text(state)
    (
        income_signal,
        status_signal,
        winnability_signal,
        executability_signal,
        appropriateness_signal,
    ) = await asyncio.gather(
        income_signal_llm.ainvoke([SystemMessage(content=INCOME_PROPERTY_PROMPT), HumanMessage(content=text)]),
        status_signal_llm.ainvoke([SystemMessage(content=SPECIAL_STATUS_PROMPT), HumanMessage(content=text)]),
        winnability_llm.ainvoke([SystemMessage(content=WINNABILITY_PROMPT), HumanMessage(content=text)]),
        executability_llm.ainvoke([SystemMessage(content=EXECUTABILITY_PROMPT), HumanMessage(content=text)]),
        appropriateness_llm.ainvoke([SystemMessage(content=APPROPRIATENESS_PROMPT), HumanMessage(content=text)]),
    )

    winnability_signal = compute_statute_of_limitations(winnability_signal, _primary_case_type(state))

    return {
        "income_property_signal": income_signal.model_dump(),
        "special_status_signal": status_signal.model_dump(),
        "winnability_signal": winnability_signal.model_dump(),
        "executability_signal": executability_signal.model_dump(),
        "appropriateness_signal": appropriateness_signal.model_dump(),
    }


def eligibility_rule_node(state: ConsultState) -> dict:
    income_signal = IncomePropertySignal(**state["income_property_signal"])
    status_signal = SpecialStatusSignal(**state["special_status_signal"])
    result = apply_eligibility_rules(income_signal, status_signal)
    return {"eligibility_result": result.model_dump()}


def build_checklist_node(state: ConsultState) -> dict:
    checklist = ReliefReviewChecklist(
        eligibility=EligibilityRuleResult(**state["eligibility_result"]),
        winnability=WinnabilitySignal(**state["winnability_signal"]),
        executability=ExecutabilitySignal(**state["executability_signal"]),
        appropriateness=ReliefAppropriatenessSignal(**state["appropriateness_signal"]),
        checklist_summary_for_lawyer=(
            f"[구조대상자 여부] {state['eligibility_result']['eligible']} "
            f"({state['eligibility_result']['judgment_note']})\n"
            f"[승소가능성] {state['winnability_signal']['review_note']}\n"
            f"[집행가능성] {state['executability_signal']['review_note']}\n"
            f"[구조타당성] {state['appropriateness_signal']['review_note']}\n"
            f"※ 위 내용은 AI 참고 자료이며, 최종 확정은 조사담당변호사가 수행합니다."
        ),
    )
    return {"relief_review_checklist": checklist.model_dump()}


# ---------------------------------------------------------------------------
# 10. LangGraph 노드 - missing_check 단계
# ---------------------------------------------------------------------------

async def candidate_generation_node(state: ConsultState) -> dict:
    text = _consult_text(state)
    prompt = CANDIDATE_PROMPT.format(
        case_list_text=_case_list_text(state),
        consult_text=text,
        relief_review_checklist=state.get("relief_review_checklist", {}),
    )
    result: CandidateList = await candidate_llm.ainvoke(
        [SystemMessage(content=prompt), HumanMessage(content=text)]
    )
    return {"candidate_missing_items": [c.model_dump() for c in result.candidates]}


async def validation_node(state: ConsultState) -> dict:
    text = _consult_text(state)
    prompt = VALIDATION_PROMPT.format(
        consult_text=text,
        candidates=state.get("candidate_missing_items", []),
    )
    result: ValidatedList = await validation_llm.ainvoke(
        [SystemMessage(content=prompt), HumanMessage(content=text)]
    )

    final_items: List[dict] = [
        v.model_dump()
        for v in result.validated
        if v.confidence >= config.CONFIDENCE_THRESHOLD
    ]
    return {"validated_missing_items": final_items}


async def document_mapping_node(state: ConsultState) -> dict:
    validated_items = state.get("validated_missing_items", [])

    if not validated_items:
        return {"missing_items": []}

    prompt = DOCUMENT_MAPPING_PROMPT.format(validated_items=validated_items)
    result: DocumentMappedList = await document_mapping_llm.ainvoke(
        [SystemMessage(content=prompt), HumanMessage(content=str(validated_items))]
    )

    mapped_by_item = {m.item: m for m in result.items}
    final_items: List[dict] = []
    for validated in validated_items:
        mapped = mapped_by_item.get(validated.get("item"))
        if mapped is not None:
            final_items.append(mapped.model_dump())
        else:
            final_items.append({**validated, "reference_documents": []})

    return {"missing_items": final_items}


# ---------------------------------------------------------------------------
# 11. 그래프 조립 (단일 순차 그래프, 모듈 로드 시 1회만 컴파일)
# ---------------------------------------------------------------------------

_graph_builder = StateGraph(ConsultState)

_graph_builder.add_node("parse_input", parse_input_node)
_graph_builder.add_node("classify_case_type", classify_case_type_node)
_graph_builder.add_node("classify_emergency", classify_emergency_node)
_graph_builder.add_node("combine_case_analysis", combine_case_analysis_node)
_graph_builder.add_node("extract_all_signals", extract_all_signals_node)
_graph_builder.add_node("eligibility_rule", eligibility_rule_node)
_graph_builder.add_node("build_checklist", build_checklist_node)
_graph_builder.add_node("candidate_generation", candidate_generation_node)
_graph_builder.add_node("validation", validation_node)
_graph_builder.add_node("document_mapping", document_mapping_node)

_graph_builder.add_edge(START, "parse_input")
_graph_builder.add_edge("parse_input", "classify_case_type")
_graph_builder.add_edge("classify_case_type", "classify_emergency")
_graph_builder.add_edge("classify_emergency", "combine_case_analysis")
_graph_builder.add_edge("combine_case_analysis", "extract_all_signals")
_graph_builder.add_edge("extract_all_signals", "eligibility_rule")
_graph_builder.add_edge("eligibility_rule", "build_checklist")
_graph_builder.add_edge("build_checklist", "candidate_generation")
_graph_builder.add_edge("candidate_generation", "validation")
_graph_builder.add_edge("validation", "document_mapping")
_graph_builder.add_edge("document_mapping", END)

consult_graph = _graph_builder.compile()


# ---------------------------------------------------------------------------
# 12. FastAPI 핸들러 진입점
# ---------------------------------------------------------------------------

async def run_consult_analysis(input_data: dict) -> dict:
    """FastAPI 핸들러에서 호출하는 단일 진입점.

    버튼 클릭 1번 = 이 함수 1회 호출 = 그래프 전체(11개 노드) 1회 실행.
    기존 3개 엔드포인트(/case-analysis, /eligibility/analyze, /missing-data/analyze)가
    프론트/Spring을 거쳐 순서대로 재호출되던 것을, 이 함수 안에서 한 번에 모두 실행하고
    최종 결과만 반환한다.

    외부(FastAPI 응답)에 나가는 값은 raw_input + case_analysis + relief_review_checklist +
    missing_items 네 필드로만 구성한다 (그래프 내부 State의 나머지 flat 필드는 구현 디테일).
    """
    final_state = await consult_graph.ainvoke({"raw_input": input_data})
    return {
        "raw_input": final_state.get("raw_input"),
        "case_analysis": final_state.get("case_analysis"),
        "relief_review_checklist": final_state.get("relief_review_checklist"),
        "missing_items": final_state.get("missing_items", []),
    }
