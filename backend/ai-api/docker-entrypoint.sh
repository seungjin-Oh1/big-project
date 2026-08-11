#!/bin/sh
# ai-api 컨테이너 기동 절차.
#
# 하는 일은 하나 — 앱을 띄우기 전에 RAG 자산(Chroma 색인, 서식 HWPX)이 제자리에
# 있는지 확인하고, 없으면 S3에서 내려받는다.
#
# 왜 여기서 하는가: 자산은 git에 없고(용량) 이미지에도 굽지 않는다. 볼륨에 한 번
# 받아두면 재기동에는 "이미 있음"으로 건너뛴다.
#
# 없으면 앱을 띄우지 않고 죽는다. 색인 없이 뜨면 검색이 조용히 빈 결과를 돌려주고
# ("검색 실패"와 "결과 없음"이 화면에서 구분되지 않는다), 아무도 이상을 알아채지
# 못한 채 상담이 진행된다. 그것보다 못 뜨는 편이 낫다.
set -e

CHROMA_DIR="/app/storage/chroma"
FORMS_DIR="/app/서식_hwpx"

if [ "${SKIP_ASSET_PULL}" = "true" ]; then
    echo "[entrypoint] SKIP_ASSET_PULL=true — 자산 내려받기를 건너뜁니다."
else
    echo "[entrypoint] RAG 자산 확인 중..."
    python -m scripts.deploy_assets pull
fi

# pull의 종료 코드만 믿으면 안 된다. S3에 자산이 없을 때 그 스크립트는
# "없음 ... push가 먼저다"를 찍고 그냥 넘어가며 0으로 끝난다. 그래서 결과를
# 직접 본다 — 디렉터리가 있고 비어 있지 않아야 한다.
for dir in "$CHROMA_DIR" "$FORMS_DIR"; do
    if [ ! -d "$dir" ] || [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
        echo "[entrypoint] 중단: $dir 가 없거나 비어 있습니다." >&2
        echo "[entrypoint] 로컬에서 'python -m scripts.deploy_assets push'를 먼저 실행해" >&2
        echo "[entrypoint] S3(deploy-assets/)에 색인과 서식을 올려두어야 합니다." >&2
        echo "[entrypoint] 색인 없이 띄우면 검색이 빈 결과만 돌려주고 아무도 알아채지 못합니다." >&2
        exit 1
    fi
done

echo "[entrypoint] 자산 준비 완료."
exec "$@"
