# AI_ANALYSIS JSON 계약서 (v0.1)

FE / BE / AI 모델 팀이 공유하는 **데이터 형식 약속**입니다.
이 형식은 각자 임의로 바꾸지 않고, 변경이 필요하면 통합·조율 담당에게 알려 전원 공지 후 버전을 올립니다.

샘플 파일: `ai_analysis_mock.json`

---

## 1. 필드별 담당 (누가 이 값을 채우는가)

| 필드 | 설명 | 생성 주체 |
|---|---|---|
| analysis_id | AI 분석 ID | 시스템(BE) |
| consultation_id | 상담 ID (FK) | 시스템(BE) |
| summary | 상담 요약 | LLM 구조화 분석 |
| case_type | 사건유형 | LLM 구조화 분석 |
| urgency_level | 긴급도 **후보** (확정 아님) | LLM 구조화 분석 |
| eligibility | 법률구조 대상 **후보** (확정 아님) | LLM 구조화 분석 |
| extracted_json | 핵심 필드(당사자·금액·날짜 등) | LLM 구조화 분석 |
| missing_info_json | 누락 자료 목록 | LLM 구조화 분석 |
| checklist_json | 구조검토 체크리스트 | LLM 구조화 분석 |
| timeline_json | 사실관계 타임라인 | LLM 구조화 분석 |
| recommendation_json | 추천 법령·판례·유사사례 | Embedding/RAG 검색 |
| cluster_result_json | 유사 사건 집단화 결과 | Embedding 검색 |
| estimated_time | 예상 처리시간 | 규칙 기반(유형별 통계 룩업) — 통계 확보 전까지 null |
| created_at | 분석일 | 시스템(BE) |

---

## 2. 저장 방식 (BE 참고)

- 테이블: PostgreSQL `AI_ANALYSIS`
- `_json` 으로 끝나는 필드 → **JSONB 컬럼** (구조가 사건마다 달라지므로 컬럼을 쪼개지 않음)
- 그 외(summary, case_type, urgency_level, eligibility) → 일반 문자열 컬럼
- API 응답은 이 테이블 1행을 위 JSON 형태로 그대로 직렬화

---

## 3. 월요일 회의에서 정할 것 (3개)

이 3개가 정해져야 계약서가 확정되고, AI 모델 프롬프트도 완성됩니다.

**(1) case_type 카테고리 목록**
- 현재 정의서에는 "공단 사건유형 분류 체계"라고만 되어 있고 실제 목록이 없음
- 예: 임금체불 / 임대차 / 대여금 / 손해배상 / 이혼·가사 / 상속 / 형사 / 기타
- → 목록을 고정해야 LLM 분류 프롬프트와 평가(Classification F1)가 가능

**(2) urgency_level / eligibility 값 표기**
- urgency_level: `상 / 중 / 하` (제안)
- eligibility: `대상후보 / 비대상후보 / 확인필요` (제안)
- ※ 행정기본법 제20조 이슈로 "대상/비대상" 확정 표현은 피하고 **후보 제시** 표현 유지

**(3) checklist_json 항목**
- 구조검토 체크리스트에 실제로 무엇을 점검할지 목록화
- 예: 소득·재산 요건 / 관할 확인 / 소멸시효 도과 여부
- 각 항목의 결과값: `충족 / 미충족 / 확인필요` (제안)

---

## 4. extracted_json 은 왜 구조를 고정하지 않는가

서식 2,146종은 각각 필요한 필드가 다릅니다. 그래서 extracted_json은
**특정 서식용이 아니라 사건 단위 공통 추출 결과(원재료 창고)** 로 둡니다.

```
구조화 분석 → extracted_json (유연 key-value)
        → 서식 추천 (사건유형 기반)
        → Kordoc parse_form 으로 해당 서식의 필드 목록 추출
        → extracted_json 값을 서식 필드에 매핑 (fill_form)
```

서식별로 다른 필드는 **매핑 단계**가 감당합니다.
값이 없는 필드는 임의로 채우지 않고 빈칸 + `missing_info_json` 안내로 처리합니다.

권장(가능하면 채우는) 키: `당사자`, `금액`, `날짜`, `사건개요`

`금액`은 숫자 하나가 아니라 **항목별 목록**입니다. 상담 하나에 성격이 다른 금액이
여러 개 나오는데(상속재산 / 상속채무 / 특별수익 …), 한 칸에 담으면 모델이 합쳐버려서
실제로는 존재하지 않는 금액이 서식에 들어갑니다. 서식마다 필요한 금액이 다르므로
(상속재산분할협의서는 상속재산, 한정승인 심판청구서는 상속채무) 항목명으로 구분합니다.
정기적으로 지급되는 돈은 항목에 주기를 밝힙니다(예: `월 양육비`).

```json
"금액": [
  { "항목": "상속재산(상가)", "값": 100000000 },
  { "항목": "상속채무", "값": 80000000 }
]
```

---

## 5. Mock API (BE / FE 개발 시작용)

모델이 아직 없어도 아래를 띄우면 FE·BE가 바로 붙어서 개발할 수 있습니다.
모델이 완성되면 `return` 안의 고정 JSON 자리에 실제 모델 호출을 끼우면 됩니다. (주소·형식 그대로 → FE 수정 불필요)

```python
# mock_api.py
# 실행: uvicorn mock_api:app --reload
import json
from pathlib import Path
from fastapi import FastAPI

app = FastAPI(title="AI_ANALYSIS Mock API")

SAMPLE = json.loads(Path("ai_analysis_mock.json").read_text(encoding="utf-8"))


@app.get("/analysis/{consultation_id}")
def get_analysis(consultation_id: str):
    """분석 결과 조회 (현재는 고정 샘플 반환)"""
    data = dict(SAMPLE)
    data["consultation_id"] = consultation_id
    return data


@app.post("/analysis")
def create_analysis(payload: dict):
    """상담 텍스트 → 분석 요청 (현재는 고정 샘플 반환)
    TODO: 여기에 실제 구조화 분석 모델 호출을 연결
    """
    return SAMPLE
```

---

## 버전 기록

- v0.1 (2026-07-20) 최초 작성. 미정 3개 항목 회의 대기.
