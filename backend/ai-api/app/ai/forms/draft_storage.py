"""생성한 초안 HWPX를 S3에 올린다.

왜 필요한가:
    core-api가 초안을 내려줄 때 ai-api의 output/ 디렉터리를 로컬 파일로 직접 읽는다
    (GeneratedDocumentService의 FileSystemResource). 두 서비스가 같은 머신에 있을 때만
    성립하는 구조라, 서비스를 나누는 순간 초안 다운로드가 깨진다.
    또 output/은 재배포하면 사라져서, 이미 만든 초안이 통째로 없어진다.

설계:
    로컬 저장은 없애지 않는다. llm_judge와 verify가 로컬 경로를 받아 쓰고, 문제가 생겼을 때
    실제 파일을 열어 보는 것이 디버깅의 기본이다. 여기서는 '올리기'만 더한다.

    응답의 기존 file 키(로컬 경로)도 그대로 둔다. 화면과 저장소가 그 값을 이미 쓰고 있어서
    의미를 바꾸면 어디가 깨지는지 한눈에 안 보인다. 새 값은 s3_key로 따로 싣고,
    core-api가 s3_key가 있으면 그쪽을 쓰도록 한다.

실패했을 때:
    올리지 못해도 예외를 밖으로 던지지 않는다. 초안 생성 자체는 성공했는데 업로드가
    실패했다고 전체를 실패로 만들면, 상담원은 다 만들어진 초안을 못 받는다.
    s3_key를 None으로 두면 core-api가 예전처럼 로컬 경로로 폴백한다
    (한 대에서 돌릴 때는 그대로 동작하고, 분리 배포에서는 그 건만 다운로드가 안 된다).
"""

import logging
import os
import uuid

from app.ai.config import S3_BUCKET_NAME, get_s3_client

logger = logging.getLogger(__name__)

# 첨부파일(consult-attachments/)과 섞이지 않게 접두어를 나눈다. 수명 주기 정책이나
# 접근 권한을 나중에 다르게 걸 때 접두어가 갈라져 있어야 손댈 수 있다.
KEY_PREFIX = "form-drafts/"

HWPX_CONTENT_TYPE = "application/hwp+zip"


def upload_draft(local_path: str) -> str | None:
    """초안 파일을 S3에 올리고 key를 돌려준다. 실패하면 None."""
    if not local_path or not os.path.isfile(local_path):
        return None

    # 파일명은 서식명에서 나오므로 사람이 알아볼 수 있게 남기되, 앞에 UUID를 붙여
    # 같은 서식을 여러 번 만들어도 서로 덮어쓰지 않게 한다.
    file_name = os.path.basename(local_path)
    key = f"{KEY_PREFIX}{uuid.uuid4()}__{file_name}"

    try:
        s3 = get_s3_client()
        with open(local_path, "rb") as f:
            s3.put_object(
                Bucket=S3_BUCKET_NAME,
                Key=key,
                Body=f.read(),
                ContentType=HWPX_CONTENT_TYPE,
            )
        return key
    except Exception as e:  # noqa: BLE001 - 업로드 실패가 초안 생성을 무르게 하지 않는다
        logger.warning("초안 S3 업로드 실패, 로컬 경로로만 응답한다: %s (%s)", local_path, e)
        return None
