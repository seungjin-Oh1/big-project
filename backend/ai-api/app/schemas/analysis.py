from typing import List, Literal, Optional
from pydantic import BaseModel, Field, model_validator

CaseType = Literal["친족", "상속", "가사소송", "가족관계등록"]

CaseSubtype = Literal[
    "약혼", "혼인의 성립, 무효, 취소", "협의이혼", "재판상이혼 등",
    "이혼 및 위자료", "이혼 및 재산분할청구권", "양육비", "면접교섭권",
    "입양, 파양, 친양자", "친권", "후견인", "부양",
    "상속일반", "상속분", "상속재산분할", "유언", "유류분",
    "가사소송일반", "가,나,다류 가사소송", "라,마류 가사비송",
    "양육비직접지급명령", "이행명령", "과태료와 감치", "기타",
    "신고", "국적의 취득과 상실", "성본창설과 개명",
    "가족관계등록창설", "가족관계등록부정정",
]

CASE_TYPE_SUBTYPE_MAP = {
    "친족": [
        "약혼", "혼인의 성립, 무효, 취소", "협의이혼", "재판상이혼 등",
        "이혼 및 위자료", "이혼 및 재산분할청구권", "양육비", "면접교섭권",
        "입양, 파양, 친양자", "친권", "후견인", "부양",
    ],
    "상속": ["상속일반", "상속분", "상속재산분할", "유언", "유류분"],
    "가사소송": [
        "가사소송일반", "가,나,다류 가사소송", "라,마류 가사비송",
        "양육비직접지급명령", "이행명령", "과태료와 감치", "기타",
    ],
    "가족관계등록": [
        "신고", "국적의 취득과 상실", "성본창설과 개명",
        "가족관계등록창설", "가족관계등록부정정",
    ],
}


class Party(BaseModel):
    역할: str = Field(description="당사자의 역할 (예: 청구인, 상대방, 신청인, 피상속인 등)")
    이름: str = Field(description="당사자 성명. 상담에서 확인 불가능하면 '미상'")
    model_config = {"extra": "forbid"}


class DateEntry(BaseModel):
    항목: str = Field(description="날짜의 의미 (예: '혼인', '별거_시작', '사망')")
    값: str = Field(description="날짜 또는 시점 (예: '2020-03', '약 3년 전')")
    model_config = {"extra": "forbid"}


class AmountEntry(BaseModel):
    항목: str = Field(description="금액의 성격 (예: '상속재산', '상속채무', '위자료 청구액', '월 양육비')")
    값: int = Field(description="금액(원). 단위 없이 숫자만")
    model_config = {"extra": "forbid"}


class ExtractedInfo(BaseModel):
    당사자: List[Party]
    # 예전엔 Optional[int] 한 칸이었다. 상담 하나에 금액이 여러 개 나오는데 담을 데가
    # 없으니 모델이 합쳐버렸다 (상속재산 1억 + 채무 8천만 -> 1억 8천만).
    # 그 숫자가 서식에 들어가면 존재하지 않는 금액이 문서에 박힌다.
    # 항목별로 나눠 담으면 서식이 필요한 것만 골라 쓸 수 있다
    # (상속재산분할협의서는 상속재산, 한정승인 심판청구서는 상속채무).
    금액: List[AmountEntry] = Field(description="언급된 금액 목록. 없으면 빈 배열")
    날짜: List[DateEntry] = Field(description="주요 날짜 목록. 없으면 빈 배열")
    사건개요: str = Field(description="상담 내용 기반 1~2문장 핵심 사건 요약")
    model_config = {"extra": "forbid"}


class ChecklistItem(BaseModel):
    항목: str
    결과: Literal["충족", "미충족", "확인필요"]
    model_config = {"extra": "forbid"}


class TimelineItem(BaseModel):
    날짜: str
    내용: str
    model_config = {"extra": "forbid"}


class AIAnalysisSchema(BaseModel):
    # ── 요약은 두 겹이다 ──
    # summary(원재료): 서식 추천·초안 작성·구조대상 판단이 읽는다. 분량을 못 박지 않는다.
    #   문장 수를 정해두면 소득·신분·증빙 같은 판단 재료가 먼저 잘려나간다.
    # summary_headline / summary_keywords(화면용): 상담원·변호사가 목록과 카드에서 훑어볼 값.
    #   사람은 개요조차 길다고 느끼기 때문에, 화면 기본 표시는 한 문장과 키워드로 한다.
    #   summary를 지우고 이걸로 대체하는 게 아니다 — 원재료가 사라지면 서식을 채울 수 없다.
    summary: str = Field(
        description="상담 내용 요약(원재료, 서식 작성·구조대상 판단용). 줄글이 아니라 개요 형식 — "
                    "[사실관계]/[쟁점]/[내담자 요구]/[구조대상 판단 재료] 제목 아래 "
                    "'- '로 시작하는 항목을 줄바꿈으로 나열. 상담에 없는 제목은 생략. "
                    "소득·재산·신분·증빙 등 법률구조 대상 판단에 필요한 언급을 빠뜨리지 말 것"
    )
    summary_headline: str = Field(
        description="화면에 기본으로 보여줄 한 문장. 이 사건이 무엇인지 한 줄로. "
                    "60자 이내, 마침표 없이 명사형으로 끝낸다"
    )
    summary_keywords: List[str] = Field(
        description="화면에 칩으로 보여줄 키워드 3~6개. 사건 성격·쟁점·특이사항을 짧은 명사구로. "
                    "한 키워드는 12자 이내"
    )
    case_type: CaseType
    case_subtype: CaseSubtype
    urgency_level: Literal["상", "중", "하"]
    eligibility: Literal["대상후보", "비대상후보", "확인필요"]
    extracted_json: ExtractedInfo
    missing_info_json: List[str] = Field(description="누락 자료 목록. 없으면 빈 배열")
    checklist_json: List[ChecklistItem]
    timeline_json: List[TimelineItem] = Field(description="사실관계 타임라인. 없으면 빈 배열")

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def validate_subtype_matches_type(self):
        allowed = CASE_TYPE_SUBTYPE_MAP.get(self.case_type, [])
        if self.case_subtype not in allowed:
            raise ValueError(
                f"case_subtype '{self.case_subtype}'은(는) case_type '{self.case_type}'에 속하지 않습니다."
            )
        return self