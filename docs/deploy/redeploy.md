# 다시 배포하기

2026-08-11에 한 번 올려서 동작을 확인하고 유료 자원만 지웠다. 이 문서는 그때
실제로 겪은 것을 순서대로 적은 것이다. 설계 근거는 [vpc-architecture.md](vpc-architecture.md)에 있다.

**무료 구조(VPC·서브넷·라우팅·IGW·보안그룹·S3 Endpoint)는 지우지 않았다.**
`deploy/aws/state.json`에 ID가 남아 있으므로 아래 절차는 그 위에 유료 자원만 다시 얹는다.

## 0. 먼저 확인할 것

| | |
|---|---|
| 시크릿 | `deploy/aws/deploy.env.local` (gitignore 대상). 서버에 올릴 `.env` 원본이다 |
| 지난 리소스 ID | `deploy/aws/backup/state-*.json` |
| ECR 이미지 | 지우지 않았다면 그대로 있다. 없으면 파이프라인을 `PUSH_IMAGES=true`로 한 번 돌린다 |

`deploy.env.local`에서 다시 채워야 하는 값은 넷이다 — 새로 만들면 주소가 바뀐다.

```
DB_HOST              RDS 엔드포인트
DB_PASSWORD          create_compute.py가 새로 만든다
APP_HOST             앱 서버 사설 IP
PUBLIC_ORIGIN        웹 서버 공인 IP
STREAM_CALLBACK_URL  웹 서버 공인 IP
```

## 1. 계정에 필요한 권한

오늘 하나씩 막히면서 붙인 것들이다. 미리 붙여 두면 중간에 멈추지 않는다.

**사용자 `seungjin01`**

| 정책 | 왜 |
|---|---|
| `AmazonEC2FullAccess` | VPC·EC2·NAT 생성 |
| `AmazonRDSFullAccess` | RDS 생성. 없으면 조회조차 안 된다 |
| `AmazonEC2ContainerRegistryReadOnly` | EC2에서 이미지를 받을 때 |
| `AWSCodePipeline_FullAccess` | 파이프라인 조작 |
| 인라인 `PassCodeConnections` | `codestar-connections:PassConnection` + `codeconnections:PassConnection`. 파이프라인의 소스 액션을 수정할 때 필요하다. 서비스 이름이 바뀌는 중이라 **둘 다** 넣어야 한다 |

**CodeBuild 서비스 역할 `bigproject`**

| 정책 | 왜 |
|---|---|
| `AmazonEC2ContainerRegistryFullAccess` | PowerUser에는 `CreateRepository`가 없다. 저장소가 없으면 여기서 막힌다 |
| `AmazonEC2FullAccess` | CodeBuild를 VPC 안에서 돌리려면 ENI를 만들어야 한다 |
| `AmazonS3ReadOnlyAccess` | Deploy 단계가 SSH 키를 S3에서 받는다 |

`ssm:GetParameter`는 끝내 없었다. 그래서 AMI를 SSM 공개 파라미터가 아니라
`ec2:DescribeImages`로 고른다(`create_compute.py`).

## 2. 계정 제약 — 인스턴스 크기

이 계정은 **프리 플랜**이라 아무 크기나 못 쓴다. 처음에 적어둔 값들이 전부 거부당했다.

```
t3.xlarge     → InvalidParameterCombination: not eligible for Free Tier
db.t3.small   → FreeTierRestrictionError
```

쓸 수 있는 것 중 가장 큰 것을 골랐다.

| | 고른 것 | 이유 |
|---|---|---|
| 앱 서버 | `m7i-flex.large` (2 vCPU / 8GB) | free-tier 목록에서 제일 크고 x86_64다. `t4g` 계열은 arm64라 우리 이미지(amd64)가 안 돈다 |
| 웹 서버 | `t3.small` | nginx만 돌린다 |
| RDS | `db.t3.micro` | `small`이 막힌다 |

RDS 엔진 버전은 **고정하지 않는다.** `16.6`으로 박아 뒀더니 AWS가 그 마이너를
이미 내려서 생성이 실패했다. 지금은 실행 시점에 최신 16.x를 고른다.

## 3. 순서

```
# 1) 유료 자원 생성 - 여기서부터 시간당 과금 (약 $0.22)
python deploy/aws/create_compute.py
python deploy/aws/create_compute.py --wait-db     # RDS는 10분쯤 걸린다

# 2) deploy.env.local의 네 값을 위 출력으로 갱신

# 3) 서버 준비 (최초 1회. .env는 사람이 올린다 - CI로 시크릿을 흘리지 않는다)
#    앱 서버는 공인 IP가 없다. 웹 서버를 밟고 들어간다.
KEY=deploy/aws/bigproject-key.pem
ssh -i $KEY ec2-user@<웹서버공인IP> \
  "git clone https://github.com/seungjin-Oh1/big-project.git ~/app"
scp -i $KEY deploy/aws/deploy.env.local ec2-user@<웹서버공인IP>:~/app/.env
#    앱 서버도 같은 방식으로 (ProxyCommand 경유)

# 4) SSH 키를 S3에 올린다 - Deploy 단계가 여기서 받는다
aws s3 cp deploy/aws/bigproject-key.pem \
  s3://<버킷>/deploy-keys/bigproject-key.pem --sse AES256

# 5) 파이프라인의 Deploy 액션 환경변수를 새 IP로 갱신 (APP_HOST, WEB_HOST)

# 6) 파이프라인 실행 → Source·Build·Deploy
```

## 4. 오늘 걸린 것들

다음에 같은 자리에서 멈추지 않으려고 적어 둔다.

### `.env`를 윈도우에서 만들면 깨진다

CRLF로 저장되면 값 끝에 `\r`이 붙는다. AWS 서명 헤더가 깨져서
`Invalid header value ...Credential=AKIA...\r/...`로 `docker login`이 실패한다.
**LF로 써야 한다.** 원인과 증상이 멀어서 찾는 데 오래 걸렸다.

### RAG 자산 볼륨 교착 — **아직 안 고쳤다**

```
deploy_assets pull  →  "건너뜀  storage/chroma 이미 있음"   (폴더 존재만 본다)
entrypoint 검사     →  "중단: /app/storage/chroma 가 비어 있습니다"  (내용을 본다)
```

도커 볼륨이 **빈 폴더**를 만들기 때문에 서로 물린다. `--force`를 주면 이번엔
`shutil.rmtree`가 마운트 지점을 지우려다 `PermissionError`로 죽는다.

오늘은 손으로 풀어 넣었다(root로 압축 해제 후 `chown 999:999`). 제대로 고치려면
`deploy_assets.pull`이

- 폴더 **존재**가 아니라 **내용 유무**로 건너뛸지 판단하고
- 덮어쓸 때 폴더를 지우지 말고 **안의 내용만** 지워야 한다

고치면 이미지를 다시 구워야 한다(12분).

### Deploy 단계가 스스로를 받아올 수 없다

`deploy.sh` 안에서만 `git pull`을 하면, 그 스크립트를 처음 추가한 회차에는
받아올 스크립트가 서버에 없다. SSH 명령이 코드를 먼저 받고 그다음 스크립트를
실행한다(`buildspec.deploy.yml`).

### CodeBuild는 각 명령을 별도 셸로 돌린다

`- ` 항목 하나에서 `exit 0`을 해도 다음 항목이 그대로 이어진다. 조건부로 건너뛸
구간은 **한 블록(`- |`)으로 묶어야** 한다.

### 로컬 캐시를 켜면 컨테이너 이름이 충돌한다

빌드 호스트가 재사용되면서 지난 회차의 `ci-postgres`가 남는다. 띄우기 전에
`docker rm -f`로 지운다.

## 5. 정리

```
python deploy/aws/teardown.py
```

**파이프라인도 같이 손봐야 한다.** teardown은 AWS 자원만 지우고 파이프라인 정의는
그대로 둔다. Deploy 단계는 이미 사라진 EC2의 사설 IP로 계속 SSH를 시도하고,
없는 주소라 응답 없이 타임아웃까지 기다린다 — **회차당 22분이 분당 요금으로**
나간다. push할 때마다 반복된다(실제로 두 번 겪었다).

정리할 때 같이 할 것:

- Deploy 스테이지 제거
- 트리거(WebhookV2) 제거, 소스 액션의 `DetectChanges`를 `false`로

다시 띄울 때는 `deploy/aws/`의 스크립트로 인프라를 만든 뒤 Deploy 스테이지를
새 IP로 다시 붙이면 된다.

지운 뒤 콘솔에서 한 번 더 볼 것: **NAT Gateway, 탄력적 IP, EBS 볼륨, RDS 스냅샷.**
중지로는 안 멈추는 것들이다.

ECR 이미지는 teardown 대상이 아니다. 12GB면 월 $1.2쯤 나가므로, 한동안 다시
배포할 일이 없으면 콘솔에서 지우는 편이 낫다.
