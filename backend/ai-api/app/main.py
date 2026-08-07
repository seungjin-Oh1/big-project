"""FastAPI 앱 조립 지점.

엔드포인트 정의는 전부 app/routers/ 아래에 두고 여기서는 등록만 한다.
(예전에는 일부 엔드포인트가 이 파일에 직접 있어서, 경로를 찾으려면
main.py와 routers/ 두 곳을 봐야 했다.)

AI 기능 본체는 app/ai/ 아래에 파이프라인 순서대로 나뉘어 있다:
  stt      음성·문서 -> 텍스트
  analysis 상담 구조화 분석 (AI_ANALYSIS 생성)
  consult  판정 파이프라인 (긴급도·구조대상·누락자료)
  forms    서식 추천·초안·검증
"""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.ai.stt.multimodal import get_whisper_model
from app.health.rag import router as rag_health_router
from app.rag_warmup import warm_rag_runtime
from app.routers import consult, consultations, forms, precedents, statutes

app = FastAPI(title="AI API")

# .env(app/ai/config.py의 load_dotenv()가 채워둠)의 CORS_ALLOWED_ORIGINS를 읽는다.
# 운영 배포 전 반드시 이 환경변수를 실제 프론트엔드 도메인으로 교체할 것. 여러 개는 콤마로 구분.
_cors_origins = [
    origin.strip()
    for origin in os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# analysis 층에는 라우터가 없다. 바깥에서 부르는 입구는 /consult/analyze 하나이고,
# 그 안에서 stt -> analysis -> consult 순으로 층을 부른다(routers/consult.py 참고).
# 예전에는 /analysis 라우터가 따로 있었지만 프론트도 core-api도 부르지 않는 상태로 남아 있었고,
# GET 쪽은 상담 id와 무관하게 계약 예시(contracts/ai_analysis_mock.json)를 그대로 돌려줘서
# 실제 분석 결과로 오해할 수 있었다.
app.include_router(rag_health_router)
app.include_router(consult.router)
app.include_router(forms.router)
app.include_router(statutes.router)
app.include_router(precedents.router)
app.include_router(consultations.router)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.on_event("startup")
def preload_models():
    """Whisper 모델을 서버 시작 시점에 미리 로드해서,
    첫 요청에서 모델 로딩 때문에 지연되는 것을 방지."""
    get_whisper_model()
    warm_rag_runtime()
