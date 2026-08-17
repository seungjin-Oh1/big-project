# 법률상담 AI 지원 시스템

상담원이 법률상담을 받는 동안 AI가 옆에서 거드는 시스템이다. 상담 내용을 받아
적고, 개인정보를 가리고, 사건을 분석하고, 관련 법령·판례를 찾아 주고, 필요한
서식의 초안까지 만들어 준다.

**결정은 전부 사람이 한다.** AI가 내놓는 긴급도·자격요건은 판단이 아니라
**후보**이고(행정기본법 제20조), 서식 선택과 발급도 상담원이 한다. 초안에
값이 없으면 비워 두고 `missing_info`로 알릴 뿐 **지어내지 않는다.**

## 전체 흐름

```
상담 접수
  → STT (대면 녹음 / 전화 통화 / 파일 업로드)
  → PII 가림
  → 사건 분석 (Gemini)
  → 법령·판례 검색 (Chroma RAG)
  → 서식 추천 → 초안 생성 (HWPX)
  → 초안 검증 (인명·지명 환각 재검증)
  → 상담원 확인 → 필요 시 변호사 검토
```

라이브 Postgres를 붙인 상태에서 이 경로가 끝까지 돈다.

## 서비스와 포트

독립적으로 뜨는 네 개의 서비스와, 팀이 공유하는 계약 하나로 이루어져 있다.

| | 무엇을 하나 | 포트 | 스택 |
|---|---|---|---|
| `backend/core-api` | 인증, 상담 CRUD, DB, 감사로그, S3, 오디오 WebSocket | 8080 | Spring Boot 4 / Java 17 |
| `backend/ai-api` | 분석 파이프라인, RAG(법령·판례·서식), HWPX 초안, 파일 STT | 8001 | FastAPI / Python 3.12 |
| `backend/stt-mask-api-modal` | 실시간 STT 게이트웨이 + PII 가림, VoIP(Twilio) 수신 | 9000 | FastAPI + Modal GPU |
| `frontend` | 상담원·변호사·관리자 화면 | 5173 | React 19 / Vite 8 |
| Postgres | `bigproject` | 5432 | PostgreSQL 16 |

`contracts/`에 FE·BE·AI가 함께 쓰는 JSON 계약이 있다.
`database/postgres/`에 초기 SQL이 있다.

**브라우저는 STT 서버를 직접 부르지 않는다.** 녹음은 core-api의 WebSocket
(`/ws/audio/in-person`, `/ws/audio/operator`)으로 가고, core-api가 서버끼리
오디오를 넘긴다. `stt-mask-api-modal`에는 인증이 없어서 바깥에 열면 안 된다.

> `backend/stt-mask-api/`(8002)는 예전에 전사와 가림을 함께 하던 서버다.
> 두 기능이 각각 ai-api와 stt-mask-api-modal로 옮겨져 **지금은 쓰지 않는다.**
> 배포에도 올리지 않는다.

## 실행

### 사전 요구사항

- **Python 3.12** — 3.13/3.14는 일부 패키지 설치가 실패한다
- JDK 17+
- Node.js 22+
- PostgreSQL 16 (`createdb bigproject`)

### 1. ai-api

```powershell
cd backend/ai-api
py -3.12 -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt

uvicorn app.main:app --reload --port 8001
```

API 문서: http://localhost:8001/docs

**반드시 이 venv로 띄운다.** 전역 파이썬에는 의존성이 빠져 있어 기동 단계에서
죽는다(`python-multipart`, `accelerate` 등).

`.env`가 필요하다 — `OPENAI_API_KEY`, `GEMINI_API_KEY`, `S3_BUCKET_NAME`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` 등. `app/ai/config.py`가
**import 시점에** `OPENAI_API_KEY`와 `S3_BUCKET_NAME`을 요구하므로 없으면
서버가 아예 뜨지 않는다.

### 2. core-api

```powershell
cd backend/core-api
.\gradlew bootRun
```

http://localhost:8080 · API 문서: [`docs/api.md`](docs/api.md)

환경변수는 `application.yaml`이 `${DB_URL:...}` 형태로 읽고 대부분 기본값이
있어서 로컬은 그대로 뜬다. 단 **`AWS_S3_BUCKET`만 기본값이 없다** — 잘못된
버킷에 첨부파일을 조용히 올리느니 기동을 막는 쪽을 택했다.

`application.yaml`이 `backend/core-api/.env`를 optional로 import하므로 그 파일에
넣어도 된다.

### 3. stt-mask-api-modal (실시간 STT)

GPU가 필요해서 전사 자체는 Modal에 올린 원격 서버가 한다. 로컬에서는 그 앞에
서는 게이트웨이만 띄운다.

```powershell
cd backend/stt-mask-api-modal

# GPU 서버 (비용 발생 — 시간당 약 $1.1)
modal serve ./modal/modal_asr.py

# 게이트웨이 (다른 터미널에서)
uvicorn main:app --host 0.0.0.0 --port 9000
```

`modal serve`가 출력한 주소를 `.env`의 `MODAL_ASR_WS_URL`에 넣는다.
**`serve`로 받은 `-dev` 주소는 그 터미널을 닫으면 사라진다.** 오래 쓸 거면
`modal deploy`를 쓴다.

**끝나면 반드시 내린다** — 이 프로젝트에서 가장 비싼 자원이다.

```powershell
modal app list          # 뭐가 떠 있는지
modal app stop <이름>
```

전화 상담까지 하려면 Twilio(Clawops) 번호의 Webhook을 게이트웨이의 `/webhook`
으로 연결해야 한다. 로컬이면 ngrok 같은 프록시가 필요하다. 자세한 것은
[`backend/stt-mask-api-modal/README.md`](backend/stt-mask-api-modal/README.md).

### 4. frontend

```powershell
cd frontend
npm install
npm run dev
```

http://localhost:5173

**마이크는 `localhost` 또는 HTTPS에서만 열린다.** 브라우저 정책이라 우회가
없다. 공인 IP에 HTTP로 올린 배포본에서는 녹음 버튼이 동작하지 않는다.

## 데이터 (git에 없는 것들)

용량 때문에 저장소에 넣지 않는다. S3의 `deploy-assets/`에 있고, 없으면 검색이
조용히 빈 결과를 내므로 **먼저 받아야 한다.**

| | 무엇 | 어디 |
|---|---|---|
| Chroma 색인 | 법령 2,289 · 판례 3,480 · 서식 1,264 청크 | `backend/ai-api/storage/chroma` |
| HWPX 서식 | 291개 (helplaw24) | `backend/ai-api/서식_hwpx/` |

```powershell
cd backend/ai-api
.\venv\Scripts\python.exe -m scripts.deploy_assets pull
```

색인을 직접 다시 만들려면:

```powershell
.\venv\Scripts\python.exe -m rag.build_statute_index
.\venv\Scripts\python.exe -m rag.build_precedent_index
.\venv\Scripts\python.exe -m rag.build_index
```

**ai-api가 떠 있는 동안 다른 프로세스가 Chroma를 열면 안 된다.** 핸들이 깨져서
ai-api를 재시작할 때까지 검색이 조용히 빈 결과만 돌려준다.

### 서식이 HWPX인 이유

원본 HWP는 한컴 비공개 바이너리라 오픈소스 도구로는 표 안에 값을 넣을 수
없다. HWPX는 공개 표준(KS X 6101)이라 `python-hwpx`로 표 셀까지 채울 수 있다.
새 서식을 넣으려면 한컴오피스가 깔린 PC에서 `backend/ai-api/convert_all.py`로
한 번 변환한다.

## 테스트

```powershell
# ai-api — 64개 파일, 324개 테스트
cd backend/ai-api
.\venv\Scripts\python.exe -m pytest tests/

# core-api — 실제 Postgres에 붙는다
cd backend/core-api
.\gradlew test

# frontend — 테스트 없음. 화면에서 확인한다
cd frontend
npm run lint
```

아래 넷은 살아 있는 색인이나 외부 API를 쳐서 느리고 외부 사정에 흔들린다.
빠른 확인만 할 때는 `--ignore`로 뺀다.

```
tests/test_form_retrieval_quality.py
tests/test_form_search_accuracy.py
tests/test_evaluate_precedent_retrieval.py
tests/test_forms_api_integration.py
```

## AI_ANALYSIS 계약

FE·BE·AI 세 팀이 **하나의 JSON 모양**으로 맞춘다. 이게 유일한 기준이므로
필드 이름을 새로 만들지 않는다.

- 문서: [`contracts/README_ai_analysis_contract.md`](contracts/README_ai_analysis_contract.md)
- 예시: [`contracts/ai_analysis_mock.json`](contracts/ai_analysis_mock.json)

몇 가지 주의할 점이 있다.

- `recommendation_json`에 **두 가지가 함께** 들어간다 — 서식 추천(`recommendations`)과
  담은 자료(`adopted`). 쓸 때 합쳐야 하고 통째로 덮으면 안 된다.
- `extracted_json`은 일부러 구조를 안 정했다. 서식 2,146종이 저마다 다른 필드를
  요구해서 "원재료 창고"로 둔다.
- `urgency_level` / `eligibility`는 **후보**다. 화면 문구에서도 그 성격을 지운다.

## 아직 안 된 것

숨기지 않고 적어 둔다.

- **HTTPS 없음.** JWT와 상담 원문이 평문으로 오간다. 브라우저 마이크도 이것 때문에
  배포본에서 안 열린다.
- **Twilio 서명 검증 없음.** `/webhook`을 주소만 알면 아무나 부를 수 있다.
- 위 둘은 **실제 상담 데이터를 넣기 전에 반드시** 붙여야 한다.
- 검색 실패와 결과 없음이 화면에서 구분되지 않는다. RAG·분석의 예외를 삼키고
  빈 값을 돌려주기 때문이다.
- 인메모리 상태(통화 세션, 캡차, 로그인 잠금)와 로컬 Chroma 파일 때문에
  **서버를 여러 대로 늘릴 수 없다.** 늘리려면 그 상태들을 먼저 밖으로 빼야 한다.
