#!/bin/sh
# 서버 안에서 도는 배포 스크립트. CodeBuild가 SSH로 이걸 실행한다.
#
# 손으로 하던 절차를 그대로 옮긴 것이다. 배포를 한 번 해보고 나서 자동화하는
# 순서를 택했는데, 그러지 않았으면 여기 적힌 것들(.env가 이미 서버에 있어야
# 한다, ECR 로그인이 먼저다, compose 파일이 배포 형태마다 다르다)을 추측으로
# 적었을 것이다.
#
# 시크릿은 CI로 넘기지 않는다. .env는 서버에 이미 있고 이 스크립트는 건드리지
# 않는다 - 배포할 때마다 키가 파이프라인을 통과하면 로그에 샐 여지가 생긴다.
#
# 사용:
#   deploy.sh <브랜치> <compose 파일>
#   deploy.sh chore/voip-handoff-cleanup deploy/compose.app.yml
set -e

BRANCH="${1:?브랜치를 넘겨야 한다}"
COMPOSE_FILE="${2:?compose 파일을 넘겨야 한다}"

cd ~/app

echo "== 코드 받기 =="
git fetch -q origin
git checkout -q "$BRANCH"
git pull -q
echo "커밋 $(git rev-parse --short HEAD)"

if [ ! -f .env ]; then
  echo "!! .env가 없다. 최초 1회는 사람이 올려야 한다." >&2
  exit 1
fi

echo "== ECR 로그인 =="
# .env에 있는 키를 쓴다. 인스턴스 프로파일을 붙이는 쪽이 더 좋지만 이 계정에는
# IAM 역할을 만들 권한이 없다.
# 레지스트리 주소에는 AWS 계정 ID가 들어간다. 이 저장소는 공개라 스크립트에 박지
# 않고, compose 파일들이 이미 쓰고 있는 .env의 ECR_REGISTRY를 그대로 읽는다.
REGISTRY=$(grep '^ECR_REGISTRY=' .env | cut -d= -f2-)
if [ -z "$REGISTRY" ]; then
  echo "!! .env에 ECR_REGISTRY가 없다." >&2
  exit 1
fi

AWS_ACCESS_KEY_ID=$(grep '^AWS_ACCESS_KEY_ID=' .env | cut -d= -f2-)
AWS_SECRET_ACCESS_KEY=$(grep '^AWS_SECRET_ACCESS_KEY=' .env | cut -d= -f2-)
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export AWS_DEFAULT_REGION=ap-northeast-2
aws ecr get-login-password --region ap-northeast-2 \
  | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

echo "== 이미지 받기 =="
docker compose --env-file .env -f "$COMPOSE_FILE" pull

echo "== 기동 =="
docker compose --env-file .env -f "$COMPOSE_FILE" up -d

echo "== 상태 =="
docker compose --env-file .env -f "$COMPOSE_FILE" ps
