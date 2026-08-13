# 배포 순서

EC2 한 대에 Docker Compose로 올린다. 환경변수 하나하나의 설명은
[environment.md](environment.md)에 있고, 이 문서는 순서와 함정만 다룬다.

## 구성

```
                    인터넷
                      │
                  ┌───▼────────────────────┐
                  │ frontend (nginx) :80   │  ← 유일하게 열린 포트
                  └───┬────────────────────┘
        /core-api, /ws│              │/webhook (Twilio)
                  ┌───▼──────────┐   │
                  │ core-api     │   │
                  │ :8080  [1대] │   │
                  └──┬────────┬──┘   │
         /stt, /ai   │        │      │
              ┌──────▼───┐ ┌──▼──────▼──────────────┐
              │ ai-api   │ │ stt-mask-api-modal     │
              │ :8001    │ │ :9000                  │
              │ [1대]    │ │  → Modal Qwen3-ASR(GPU)│
              └────┬─────┘ └────────────────────────┘
             ┌─────▼──────┐
             │ postgres   │
             └────────────┘
```

`stt-mask-api`(8002)는 배포하지 않는다. 그 서버가 하던 일은 옮겼다.

| 기능 | 옮긴 곳 |
|---|---|
| `POST /redact` 메모 가리기 | stt-mask-api-modal `/redact` |
| `POST /transcribe` 파일 전사 | ai-api `/stt/transcribe` |

파일 전사를 ai-api에 둔 이유는 whisper가 이미 거기 있고 **Modal이 꺼져 있어도
동작하기 때문**이다. 9000에 두면 GPU 비용을 아끼려고 Modal을 내린 순간 파일 업로드까지
같이 죽는다.

## 왜 한 대인가

core-api는 통화 세션(`CallRegistry`), 오디오 티켓, 로그인 실패 횟수, 캡차를 전부
**메모리**에 들고 있고 ai-api의 Chroma는 **로컬 파일**이다. 인스턴스를 늘리면 통화가
엉뚱한 서버로 붙고, 방금 받은 캡차가 "틀렸다"고 나온다. 오토스케일(ECS·App Runner)을
쓰려면 그 상태들을 Redis로 먼저 빼야 한다.

권장 사양: **t3.xlarge (4 vCPU / 16GB), gp3 60GB, ap-northeast-2**
디스크가 큰 이유는 torch가 들어간 파이썬 이미지가 몇 GB이기 때문이다.

## 순서

### 1. 자산을 S3에 올린다 (로컬에서 한 번)

Chroma 색인 177MB와 서식 23MB는 git에 없다. 이미지에도 굽지 않는다 — 컨테이너가
뜰 때 S3에서 받는다.

```
cd backend/ai-api
python -m scripts.deploy_assets push
python -m scripts.deploy_assets status   # 올라갔는지 확인
```

**이걸 안 하면 ai-api가 기동을 거부한다.** 색인 없이 뜨면 검색이 조용히 빈 결과를
돌려주고("검색 실패"와 "결과 없음"이 화면에서 구분되지 않는다) 아무도 못 알아채므로,
아예 못 뜨게 해 두었다.

### 2. Modal에 STT 모델을 올린다

```
cd backend/stt-mask-api-modal
modal setup                        # 최초 1회, 브라우저 인증
modal deploy ./modal/modal_asr.py
```

출력된 주소 + `/ws/transcribe`가 `MODAL_ASR_WS_URL`이다.

- **`serve`가 아니라 `deploy`를 쓴다.** `serve`는 그 터미널을 닫으면 죽는다.
- Windows에서는 `set PYTHONUTF8=1`을 먼저 한다. 안 하면 콘솔이 Modal의 `✓` 출력을
  못 찍고 `cp949` 오류로 죽는다.
- A10G가 `min_containers=1`로 잡혀 있어 **요청이 없어도 계속 켜져 있다**(시간당 약 $1.1).
  안 쓸 때는 `modal app stop qwen3-asr-streaming`.

### 3. 환경변수를 채운다

```
cp .env.deploy.example .env
vi .env
```

빠뜨린 값이 있으면 컨테이너가 뜨기 전에 멈춘다(compose의 `${VAR:?}`).

### 4. 올린다

```
docker compose up -d --build
docker compose ps          # 전부 healthy 인지
docker compose logs -f core-api
```

### 5. Twilio 전화번호 Webhook을 바꾼다

로컬 개발에서 쓰던 ngrok 주소를 실제 도메인으로 바꾼다.

```
전화번호 Webhook :  https://example.com/webhook
.env             :  STREAM_CALLBACK_URL=wss://example.com/webhook
```

같은 주소인데 **프로토콜이 다르다**. 여기서 자주 틀린다.

## 함정

### PII_ENCRYPTION_KEY는 한 번 정하면 못 바꾼다

상담 원문·이름·주소·전화번호가 이 키로 암호화되어 저장된다. 바꾸면 기존 데이터를
복호화할 수 없고 되돌릴 방법이 없다. **만들자마자 따로 보관할 것.**

그리고 `app.pii.encrypt-legacy-on-startup`을 켠 채로 올리면 안 된다. 그 마이그레이션은
"이미 암호문인가"를 *지금 키로 복호화되는가*로 판단해서, 키가 다르면 기존 암호문을
평문으로 오인해 **한 번 더 암호화한다**. 기본이 꺼짐이고 운영 프로파일에서는 켜도
기동을 거부하지만(`DevSecretGuard`), 알고는 있어야 한다.

### S3 버킷은 core-api와 ai-api가 같아야 한다

core-api가 첨부파일을 올리고 ai-api가 그걸 내려받는다. 다르면 분석이 "파일 오류"만
낸다. compose가 두 서비스에 같은 `S3_BUCKET_NAME`을 넘기므로 `.env`에 한 번만 적으면 된다.

### 백엔드 포트를 열지 말 것

ai-api와 stt-mask-api-modal에는 **인증이 없다.** 보안그룹이나 compose에서 8001·9000을
열면 누구나 분석·전사를 돌릴 수 있다. 컨테이너끼리는 도커 네트워크로 통하므로 열 이유가
없다.

보안그룹은 22(내 IP만)·80·443만 연다.

### /webhook에는 인증이 없다

Twilio가 들어와야 해서 nginx가 이 경로 하나를 바깥에 뚫는다. 아직 Twilio 서명
검증(`X-Twilio-Signature`)이 없어서 **아무나 전화 세션을 흉내 낼 수 있다.** 실제 서비스로
쓰기 전에 반드시 붙일 것.

### 첫 기동은 오래 걸린다

ai-api는 자산 200MB를 받고 임베딩 모델을 올린다. `start_period`를 180초로 잡아 두었지만
네트워크가 느리면 더 걸릴 수 있다. `docker compose logs -f ai-api`로 확인한다.
