"""
app/agents/consult/config.py

기존 case_analysis/config.py + rescue_check/config.py + missing_check/config.py를
그대로 한 파일로 병합한 것. 값/로직 변경 없음 (API 단일화 목적의 이동/병합만 수행).

TODO (팀 확인 필요, 기존 rescue_check/config.py에서 그대로 이관):
1) MEDIAN_INCOME_TABLE: 2025/2026년은 보건복지부 고시 수치 반영 완료.
   매년 8월 1일 신규 고시 -> 연도 갱신 필요 (계속 늘어나면 DB 테이블로 분리 권장)
2) REQUIRED_EVIDENCE_MAP: "법률검토 기준 분류" 표 F열 기준 초안. 팀 리뷰로 최종 확정 필요
3) STATUTE_OF_LIMITATIONS_MAP: 사건유형별 "보편적" 법정기간만 반영한 기본값.
   실제 사건의 기산일 특칙(상사채권 5년, 근로자 퇴직급여 3년 등)은 반영 안 됨
4) CONFIDENCE_THRESHOLD: 실사용 피드백 쌓이면 재조정 필요.
"""

import os
from datetime import date
from typing import Optional

from dotenv import load_dotenv

load_dotenv()  # 프로젝트 루트의 .env 파일을 읽어 os.environ에 채움


def _require_env(key: str) -> str:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(
            f"환경변수 {key}가 설정되지 않았습니다. .env 파일(.env.example 참고)을 확인하세요."
        )
    return value


# ---------------------------------------------------------------------------
# (기존 case_analysis/config.py)
# ---------------------------------------------------------------------------

OPENAI_API_KEY = _require_env("OPENAI_API_KEY")

AWS_REGION = os.environ.get("AWS_REGION", "ap-northeast-2")
S3_BUCKET_NAME = _require_env("S3_BUCKET_NAME")

WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "turbo")


def get_s3_client():
    """boto3 S3 클라이언트. AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY는
    boto3가 환경변수에서 자동으로 읽으므로 별도로 넘기지 않습니다."""
    import boto3

    return boto3.client("s3", region_name=AWS_REGION)


# ---------------------------------------------------------------------------
# (기존 rescue_check/config.py) - LLM 공통 설정
# ---------------------------------------------------------------------------

MODEL_NAME = os.environ.get("KLAC_LLM_MODEL", "gpt-4o-mini")

# 기본값(strict json_schema)은 Optional/List 조합에서
# "'required' must include every key in properties" 류의 400 에러를 낼 수 있어
# function_calling으로 고정.
STRUCTURED_METHOD = "function_calling"


# ---------------------------------------------------------------------------
# (기존 rescue_check/config.py) - 기준중위소득 (소득·재산 기준 판단용)
# ---------------------------------------------------------------------------

# 보건복지부 고시 기준중위소득 (단위: 원/월).
# 출처: 보건복지부 보도자료 "2026년도 기준 중위소득 6.51% 역대 최대로 인상"(2025-07-31 발표)
MEDIAN_INCOME_TABLE: dict[int, dict[int, float]] = {
    2025: {
        1: 2_392_013,
        2: 3_932_658,
        3: 5_025_353,
        4: 6_097_773,
        5: 7_108_192,
        6: 8_064_805,
        7: 8_988_428,
    },
    2026: {
        1: 2_564_238,
        2: 4_199_292,
        3: 5_359_036,
        4: 6_494_738,
        5: 7_556_719,
        6: 8_555_952,
        7: 9_515_150,
    },
}
# 8인 이상: 직전 인원 기준중위소득 + 연도별 증분(2025: 923,623 / 2026: 959,198)
MEDIAN_INCOME_INCREMENT_PER_PERSON = {2025: 923_623, 2026: 959_198}

INCOME_THRESHOLD_RATIO_DEFAULT = 1.25    # 기준중위소득 125% 이하 (일반)
INCOME_THRESHOLD_RATIO_SMALL_BIZ = 1.50  # 기준중위소득 150% 이하 (소상공인 무료법률지원 특례)


# ---------------------------------------------------------------------------
# (기존 rescue_check/config.py) - 필수 소명자료 매핑 (표의 F열 기준 초안 -> 팀 리뷰 필요)
# ---------------------------------------------------------------------------

REQUIRED_EVIDENCE_MAP: dict[str, list[str]] = {
    "기초생활수급자": ["소득증빙", "가족관계증명"],
    "차상위계층": ["소득증빙", "가족관계증명"],
    "월평균소득 기준 이하": ["소득증빙"],
    "소년소녀가장": ["가족관계증명"],
    "모자가정": ["가족관계증명"],
    "장애인": ["장애인 증명"],
    "국내거주 저소득 외국인근로자": ["소득증빙", "그 외"],
    "법원 소송구조결정 피구조자": ["그 외"],
    "국선변호 대상 피의자·피고인": ["그 외"],
}


# ---------------------------------------------------------------------------
# (기존 rescue_check/config.py) - 사건유형별 소멸시효 기본기간(년)
# ---------------------------------------------------------------------------

STATUTE_OF_LIMITATIONS_MAP: dict[str, Optional[float]] = {
    "임금체불": 3.0,
    "개인회생": None,
    "개인파산": None,
    "불법사금융피해": 3.0,
    "이혼": None,
    "상속": None,
    "가족관계": None,
    "기타": 10.0,
}


# ---------------------------------------------------------------------------
# (기존 rescue_check/config.py) - 순수 조회 함수
# ---------------------------------------------------------------------------

def get_median_income(year: int, household_size: int) -> Optional[float]:
    table = MEDIAN_INCOME_TABLE.get(year)
    if table is None:
        return None
    if household_size in table:
        return table[household_size]
    if household_size > 7:
        base = table[7]
        increment = MEDIAN_INCOME_INCREMENT_PER_PERSON.get(year)
        if increment is None:
            return None
        return base + increment * (household_size - 7)
    return None


def get_income_threshold(
    household_size: Optional[int],
    is_small_business: bool = False,
    year: Optional[int] = None,
) -> Optional[float]:
    """가구원수 기준중위소득 * 적용비율(125%/150%). 정보 부족 시 None(판단보류로 이어짐)."""
    if household_size is None:
        return None
    year = year or date.today().year
    median = get_median_income(year, household_size)
    if median is None:
        return None
    ratio = INCOME_THRESHOLD_RATIO_SMALL_BIZ if is_small_business else INCOME_THRESHOLD_RATIO_DEFAULT
    return median * ratio


def map_reasons_to_required_evidence(reasons: list[str]) -> list[str]:
    evidence: set[str] = set()
    for r in reasons:
        evidence.update(REQUIRED_EVIDENCE_MAP.get(r, []))
    return sorted(evidence)


# ---------------------------------------------------------------------------
# (기존 missing_check/config.py) - 검증(validation) 단계 신뢰도 임계치
# ---------------------------------------------------------------------------

# rescue_check.MODEL_NAME과 별도로 이 단계만 모델을 바꿔 실험하고 싶을 수 있어
# KLAC_MISSING_DATA_MODEL 환경변수를 따로 둠 (미설정 시 위 MODEL_NAME과 동일값).
MISSING_DATA_MODEL_NAME = os.environ.get("KLAC_MISSING_DATA_MODEL", MODEL_NAME)

# 검증 노드가 매긴 confidence(0~1)가 이 값 이상인 후보만 '확신 있는' 누락 항목으로 채택.
CONFIDENCE_THRESHOLD: float = 0.7

# 임계값을 넘은 항목이 하나도 없을 때, 후보 중 점수 높은 순으로 몇 개까지 남길지.
#
# 0.7은 절벽이라 0.69와 0.71이 '전부 버림'과 '전부 남김'으로 갈린다. 실제로 같은 상담을
# 두 번 돌렸더니 한 번은 6건, 한 번은 0건이 나왔다(운영 DB 상담 4번, analysis_id 2/3).
# 0건이면 화면에는 "누락 자료 없음"이라고만 떠서, 자료를 다 받은 것인지 이번에 못 찾은
# 것인지 상담원이 구분할 수 없다.
#
# 누락자료는 놓쳤을 때의 손해가 더 냈을 때의 손해보다 크다 — 빠뜨리면 서식이 빈칸으로
# 나가지만, 더 내면 상담원이 보고 넘기면 그만이다. 그래서 전부 걸러진 경우에는 상위
# 몇 개를 low_confidence 표시를 달아 남긴다. 버리지 않고 강등한다.
MISSING_ITEM_FALLBACK_KEEP: int = 3
