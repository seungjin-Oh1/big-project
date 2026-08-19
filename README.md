# 법률상담 AI 지원 시스템

대한법률구조공단 상담 창구를 염두에 두고 만든, **상담원 옆에 붙는 보조 도구**다.
상담이 진행되는 동안 말을 받아 적고, 개인정보를 가리고, 사건을 분석하고, 관련
법령·판례를 찾고, 필요한 서식의 초안까지 만들어 상담원 화면에 올려 준다.

## 이 시스템이 푸는 문제

무료 법률구조 상담 한 건은 대체로 이렇게 흘러간다. 상담자가 자기 사정을 이야기하고,
상담원이 그걸 받아 적고, 어떤 사건인지 가리고, 구조 대상이 되는지 따지고, 어떤
서식을 써야 하는지 찾고, 그 서식의 빈칸을 채운다. 마지막 두 단계가 특히 무겁다 —
서식은 2천 종이 넘고, 사건마다 요구하는 칸이 다르다.

이 시스템은 **그 사이의 옮겨 적는 일**을 대신한다. 상담원이 들은 것을 다시 타이핑해
분류하고 검색하는 대신, 말이 끝나면 후보가 이미 화면에 올라와 있다.

## 사람이 결정한다

**AI가 내놓는 것은 전부 후보다.** 긴급도도 구조 대상 여부도 "이렇게 보인다"까지이고,
결정은 상담원과 변호사가 한다. 행정기본법 제20조가 자동화된 처분을 제한하기도 하지만,
그 이전에 틀렸을 때 그 값을 감당하는 쪽이 사람이기 때문이다.

그래서 몇 가지를 일부러 지켰다.

- **지어내지 않는다.** 상담에서 확인되지 않은 값은 서식에 채우지 않고 빈칸으로 두면서
  `missing_info_json`에 "이 자료가 더 필요하다"고 적는다. 그럴듯하게 채운 서류는
  비어 있는 서류보다 나쁘다.
- **단정하지 않는다.** 화면 문구도 "대상 후보", "확인 필요"처럼 후보임이 드러나는
  말을 쓴다. "구조 가능"처럼 결론으로 읽히는 표기는 쓰지 않는다.
- **개인정보는 한 벌만 둔다.** 가림본을 따로 저장하지 않는다. 화면에 필요할 때
  그 자리에서 가려 보여주고 버린다. 원본과 가림본을 둘 다 보관하면 유출 대비는
  안 되면서 보관하는 개인정보만 두 배가 된다.
- **주민등록번호는 아예 남기지 않는다.** 상담에서 말했더라도 분석 결과에 넣지 않는다.
  법령에 근거가 있어야 다룰 수 있는 값이라 이 시스템은 보관하지 않는다.

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

라이브 Postgres를 붙인 상태에서 이 경로가 끝까지 돈다. 어떤 기능이 없을 거라고
넘겨짚기보다 코드를 먼저 읽는 편이 빠르다 — 465개 커밋, 기여자 8명이 쌓은 것이다.

### 세 갈래로 들어오는 상담

| | 어떻게 들어오나 | 상태 |
|---|---|---|
| 대면 | 상담원 PC 마이크 → core-api WebSocket → 실시간 자막 | 동작 |
| 전화 | 통신사 Media Stream → 게이트웨이 `/webhook` → 실시간 자막 | 코드는 완성, 회선 미계약 |
| 파일 | 녹음 파일 업로드 → ai-api가 전사 | 동작 |

전화는 8kHz μ-law를 받아 16kHz로 변환해 같은 파이프라인에 밀어 넣는 어댑터까지
`backend/stt-mask-api-modal/main.py`에 들어 있다. **번호를 계약하고 Webhook 주소만
걸면 도는 상태**이고, 지금은 그 계약이 없다.

## 서비스와 포트

독립적으로 뜨는 네 개의 서비스와, 팀이 공유하는 계약 하나로 이루어져 있다.

| | 무엇을 하나 | 포트 | 스택 |
|---|---|---|---|
| `backend/core-api` | 인증, 상담 CRUD, DB, 감사로그, S3, 오디오 WebSocket | 8080 | Spring Boot 4 / Java 17 |
| `backend/ai-api` | 분석 파이프라인, RAG(법령·판례·서식), HWPX 초안, 파일 STT | 8001 | FastAPI / Python 3.12 |
| `backend/stt-mask-api-modal` | 실시간 STT 게이트웨이 + PII 가림, 전화 통화 수신 | 9000 | FastAPI + Modal GPU |
| `frontend` | 상담원·변호사·관리자 화면 | 5173 | React 19 / Vite 8 |
| Postgres | `bigproject` | 5432 | PostgreSQL 16 |

`contracts/`에 FE·BE·AI가 함께 쓰는 JSON 계약이 있다.
`database/postgres/`에 초기 SQL이 있다.
`deploy/`에 배포 구성이 있다.

**브라우저는 STT 서버를 직접 부르지 않는다.** 녹음은 core-api의 WebSocket
(`/ws/audio/in-person`, `/ws/audio/operator`)으로 가고, core-api가 서버끼리
오디오를 넘긴다. `stt-mask-api-modal`에는 인증이 없어서 바깥에 열면 안 된다.

> `backend/stt-mask-api/`(8002)는 예전에 전사와 가림을 함께 하던 서버다.
> 두 기능이 각각 ai-api와 stt-mask-api-modal로 옮겨져 **지금은 쓰지 않는다.**
> core-api의 기본값도 9000을 가리키고, 배포 구성에도 올라가지 않는다.

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

여기 있는 `package.json`은 무시한다. 지금은 쓰지 않는 예전 흔적이고
`npm install`도 필요 없다.

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
넣어도 된다. Spring 자체는 `.env`를 읽지 않으니 헷갈리지 않도록 주의한다.

S3 버킷은 **ai-api와 같은 값**이어야 한다. core-api가 첨부파일을 올리고 ai-api가
같은 버킷에서 내려받는다.

### 3. stt-mask-api-modal (실시간 STT)

GPU가 필요해서 전사 자체는 Modal에 올린 원격 서버가 한다. 로컬에서는 그 앞에
서는 게이트웨이만 띄운다.

```powershell
cd backend/stt-mask-api-modal

# GPU 서버 (비용 발생 — A10G 시간당 약 $1.1)
modal serve ./modal/modal_asr.py

# 게이트웨이 (다른 터미널에서)
uvicorn main:app --host 0.0.0.0 --port 9000
```

`modal serve`가 출력한 주소를 `.env`의 `MODAL_ASR_WS_URL`에 넣는다.
**`serve`로 받은 `-dev` 주소는 그 터미널을 닫으면 사라진다.** 오래 쓸 거면
`modal deploy`를 쓴다.

컨테이너는 마지막 요청 후 4분(`scaledown_window`) 지나면 0대로 내려가고, 그때는
비용이 발생하지 않는다. 대신 **다시 부르면 콜드 스타트에 1분 남짓 걸린다.**
시연 직전에 한 번 깨워 두면 그 대기를 피할 수 있다.

```powershell
modal app list          # 뭐가 떠 있는지
modal app stop <이름>
```

전화 상담까지 붙이려면 통신사 번호의 Webhook을 게이트웨이의 `/webhook`으로
연결한다. 로컬이면 ngrok 같은 프록시가 필요하다. 자세한 것은
[`backend/stt-mask-api-modal/README.md`](backend/stt-mask-api-modal/README.md).

### 4. frontend

```powershell
cd frontend
npm install
npm run dev
```

http://localhost:5173

**마이크는 `localhost` 또는 HTTPS에서만 열린다.** 브라우저 정책이라 우회가 없다.
공인 IP에 HTTP로 올린 화면에서는 녹음 버튼이 동작하지 않는다.

## 데이터 (git에 없는 것들)

용량 때문에 저장소에 넣지 않는다. S3의 `deploy-assets/`에 있고, 없으면 검색이
조용히 빈 결과를 내므로 **먼저 받아야 한다.**

| | 무엇 | 어디 |
|---|---|---|
| Chroma 색인 | 법령 2,289 · 판례 3,480 · 서식 1,264 청크 | `backend/ai-api/storage/chroma` |
| HWPX 서식 | 291개, 대분류 4갈래(가사소송·가족관계등록·상속·친족) | `backend/ai-api/서식_hwpx/` |
| 파싱 결과 | 273개 JSON | `backend/ai-api/parsed/` |

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

서식 291종은 전체 2,146종 중 가사·상속 계열만 추린 것이다. 이 규모에서는 RAG의
이점이 크지 않지만, 나중에 범위를 넓힐 것을 전제로 검색 경로를 그대로 둔다.

### 서식이 HWPX인 이유

원본 HWP는 한컴 비공개 바이너리라 오픈소스 도구로는 표 안에 값을 넣을 수 없다.
HWPX는 공개 표준(KS X 6101)이라 `python-hwpx`로 표 셀까지 채울 수 있다. 새 서식을
넣으려면 한컴오피스가 깔린 PC에서 `backend/ai-api/convert_all.py`로 한 번 변환한다.

## AI_ANALYSIS 계약

FE·BE·AI 세 팀이 **하나의 JSON 모양**으로 맞춘다. 이게 유일한 기준이므로 필드
이름을 새로 만들지 않는다.

- 문서: [`contracts/README_ai_analysis_contract.md`](contracts/README_ai_analysis_contract.md)
- 예시: [`contracts/ai_analysis_mock.json`](contracts/ai_analysis_mock.json)

Postgres의 `ai_analysis` 테이블 하나가 이 모양을 그대로 받는다. `_json`으로 끝나는
칸은 JSONB이고 나머지는 평범한 문자열 칸이다. 몇 가지 주의할 점이 있다.

- `recommendation_json`에 **두 가지가 함께** 들어간다 — 서식 추천(`recommendations`)과
  담은 자료(`adopted`). 쓸 때 합쳐야 하고 통째로 덮으면 안 된다.
- `extracted_json`은 일부러 구조를 안 정했다. 서식 2,146종이 저마다 다른 필드를
  요구해서 "원재료 창고"로 둔다.
- `urgency_level` / `eligibility`는 **후보**다. 화면 문구에서도 그 성격을 지운다.
- `case_type`의 고정 목록, `urgency_level`·`eligibility`의 값 집합, `checklist_json`의
  항목 목록은 아직 확정되지 않았다. 이 값들을 코드에 박기 전에 계약 문서를 다시 본다.
