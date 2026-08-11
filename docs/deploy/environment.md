# 배포 환경변수

배포할 때 각 서비스에 넣어야 하는 값. 로컬 개발은 지금까지대로 두면 되고
(`.env` + 기본값), 이 문서는 **배포에서만** 필요한 것을 다룬다.

확인 방법은 추측이 아니라 실행이다 — core-api를 운영 프로파일로 띄워서
무엇이 막는지 직접 봤다(2026-08-11).

```
시크릿 없이  → 기동 거부. 막힌 항목 6개를 이름으로 알려준다 (DevSecretGuard)
시크릿 채움  → Started BigprojectApplication in 13.497 seconds
```

**시크릿 외에 기동을 막는 것은 없다.**

---

## core-api

`SPRING_PROFILES_ACTIVE`가 `local`/`test`가 아니면 `DevSecretGuard`가 켜진다.
아래 ★ 여섯 개가 개발용 기본값 그대로면 **기동을 거부한다**. 경고가 아니라 중단이다 —
기본 시크릿인 채로 뜬 서버는 "일단 동작은 하는" 상태라 아무도 이상을 못 느끼는 게
가장 위험하기 때문이다.

| 변수 | 필수 | 비고 |
|---|---|---|
| `SPRING_PROFILES_ACTIVE` | ✅ | `prod` 등. `local`이면 시크릿 검사가 꺼진다 |
| `JWT_SECRET` | ✅ | 32바이트 이상. 이게 뚫리면 아무나 토큰을 위조한다 |
| `PII_ENCRYPTION_KEY` ★ | ✅ | **한 번 정하면 못 바꾼다** (아래 주의) |
| `AUDIO_EXTERNAL_API_KEY` ★ | ✅ | 외부 오디오 게이트웨이 공유 비밀키 |
| `DB_URL` | ✅ | `jdbc:postgresql://<rds>:5432/bigproject` |
| `DB_USERNAME` | ✅ | |
| `DB_PASSWORD` ★ | ✅ | 기본값 `postgres`면 거부 |
| `MASTER_TALKER_PASSWORD` ★ | ✅ | 기본값 `test1234`면 거부 |
| `MASTER_LAWYER_PASSWORD` ★ | ✅ | 〃 |
| `MASTER_ADMIN_PASSWORD` ★ | ✅ | 〃 |
| `CORS_ALLOWED_ORIGINS` | ✅ | 실제 프론트 도메인. REST와 WebSocket이 공유한다 |
| `AWS_S3_BUCKET` | ✅ | **ai-api의 `S3_BUCKET_NAME`과 같아야 한다** (아래 주의) |
| `AWS_S3_REGION` | | 기본 `ap-northeast-2` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | | ECS 태스크 역할을 쓰면 불필요 |
| `AI_API_URL` | ✅ | `http://ai-api:8001` — VPC 내부 주소 |
| `STT_MASK_API_URL` | ✅ | `http://stt-mask-api:8002` — VPC 내부 주소 |
| `IN_PERSON_AUDIO_GATEWAY_WS_URL` | ✅ | **빈 값으로 둔다** (아래 주의) |
| `MASTER_*_EMAIL`, `MASTER_*_NAME` | | 기본값 `test_*@test.test` |
| `JWT_EXPIRATION_MS` | | 기본 24시간 |

## ai-api

`app/ai/config.py`의 `_require_env`가 없으면 기동 시 바로 죽는다.

| 변수 | 필수 | 비고 |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | |
| `S3_BUCKET_NAME` | ✅ | core-api의 `AWS_S3_BUCKET`과 같아야 한다 |
| `GEMINI_API_KEY` | ✅ | 분석 단계 |
| `KLAC_GEMINI_MODEL` | | |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | | 태스크 역할을 쓰면 불필요 |
| `AWS_REGION` | | 기본 `ap-northeast-2` |
| `LAW_API_OC` | | 법령 API |
| `WHISPER_MODEL_SIZE` | | 기본 `turbo` |

## stt-mask-api

환경변수를 읽지 않는다. 이미지에 모델만 들어 있으면 된다.

## frontend

빌드 시점에 필요한 값이 없다. 코드가 항상 상대경로(`/core-api`)로 호출하므로
리버스 프록시가 그 한 경로만 core-api로 넘기면 된다.

---

# 주의할 것 넷

## 1. `PII_ENCRYPTION_KEY`는 한 번 정하면 못 바꾼다

상담 원문·내담자 이름·연락처가 이 키로 암호화되어 DB에 들어간다. 키를 바꾸면
기존 데이터를 못 읽는다. 그냥 못 읽는 게 아니라 **더 나쁘다** — `TolerantCryptoConverter`가
복호화 실패 시 원값을 그대로 돌려주도록 되어 있고(평문 시절 데이터를 읽기 위한 장치),
`ConsultationPiiEncryption`이 부팅할 때 그 값을 "평문"으로 보고 새 키로 다시 암호화한다.
암호문을 한 번 더 암호화한 쓰레기가 된다.

- 배포 전에 정하고 Secrets Manager에 넣는다
- 로컬 DB로 테스트할 때 운영 키를 쓰지 않는다(반대도 마찬가지)

## 2. 두 버킷 이름이 갈라지면 조용히 깨진다

`application.yaml`의 기본값이 **ai-api와 다른 버킷**이다.

```
core-api  AWS_S3_BUCKET     기본값 aivle-test-ai-34178924
ai-api    S3_BUCKET_NAME    기본값 없음(필수)
```

`AWS_S3_BUCKET`을 안 넣으면 core-api는 첨부파일을 A 버킷에 올리고 ai-api는 B 버킷에서
찾는다. 예외가 안 나고 "분석 결과가 비어 있음"으로만 보인다. 반드시 명시할 것.

## 3. `IN_PERSON_AUDIO_GATEWAY_WS_URL`은 빈 값으로

VoIP 게이트웨이는 아직 이 레포에 없다. 기본값(`ws://localhost:9000/...`)을 그대로 두면
운영 서버가 **자기 자신의 localhost:9000**에 10초간 연결을 시도하다 타임아웃으로 실패한다.
원인을 찾기 어렵다.

빈 값으로 두면 `InPersonCallInitiator`가 *"대면 녹음 게이트웨이 주소가 설정되지 않았습니다"*라는
명확한 메시지를 던진다.

게이트웨이가 생기면 **이 변수만 채우고 재시작하면 된다. 코드 변경 없다.**

## 4. core-api와 ai-api는 1대 고정

| | 왜 | 늘리면 |
|---|---|---|
| core-api | `CallRegistry`·`AudioStreamTicketService`가 메모리 저장 | 통화 두 레그가 다른 인스턴스에 붙어 마이크 연결이 끊긴다. 티켓도 A가 발급한 걸 B가 검증 못 해 403 |
| ai-api | `storage/chroma`가 로컬 파일 | 인스턴스마다 다른 색인을 본다. EFS로 공유하면 핸들이 깨진다 |

- ECS `desiredCount: 1`, **오토스케일링 걸지 말 것**
- 무중단 배포가 안 된다. `minimumHealthyPercent: 0` / `maximumPercent: 100`으로 두어
  2대가 겹치는 순간을 만들지 않는다. 잠깐 내려갔다 올라온다

나중에 푸는 방법(지금 할 일 아님): 티켓·통화 상태를 Redis로, Chroma를 관리형 벡터 DB로.

---

# 배포 자산

`storage/chroma`(177MB)와 `서식_hwpx`(23MB)는 크기 때문에 git에 없다. 그래서 컨테이너
이미지에도 안 들어간다. **없으면 검색과 초안 생성이 통째로 죽는다.**

S3를 통로로 쓴다(`deploy-assets/` 접두어, 압축 후 72MB).

```
# 색인을 새로 만든 뒤 (ai-api를 내리고)
python -m scripts.deploy_assets push

# 배포·새 PC 셋업 (ai-api 뜨기 전)
python -m scripts.deploy_assets pull

# 양쪽에 뭐가 있는지만
python -m scripts.deploy_assets status
```

ai-api 컨테이너의 시작 스크립트에서 `pull`을 먼저 부르면 된다. 런타임에 S3에서 직접
읽지 않는 이유: Chroma는 sqlite 파일을 직접 열고 서식 검색은 요청마다 디렉터리를
rglob한다. 둘 다 로컬 파일시스템을 전제로 한다.

---

# 남은 것

- `S3TestController` 삭제 — `key`만 바꾸면 버킷의 아무 오브젝트나 읽고 지울 수 있다.
  `/test/**`가 `denyAll`이라 당장 위험하진 않지만 배포 전에 지우는 게 맞다.
  (Fun1984 님 파일)
- ai-api에는 인증이 없다. core-api 프록시(`/api/ai/**`)로만 닿게 하고 **보안그룹에서
  core-api만 허용**할 것. nginx/ALB에 `/ai-api`, `/stt-api`를 뚫으면 그 격리가 무너진다.
- VoIP를 붙일 때: 게이트웨이 태스크 +1, NLB +1(SIP를 직접 받는 경우), EC2 인스턴스는
  stt-mask-api의 GPU 노드를 나눠 쓰면 +0. **퍼블릭 서브넷은 지금 잡아둘 것** —
  나중에 CIDR이 모자라면 못 늘린다.
