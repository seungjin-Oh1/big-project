"""첨부 링크가 우리 버킷 밖을 가리키지 못하는지 확인한다.

시큐어 코딩 가이드의 "신뢰되지 않은 URL 주소로 자동접속 연결" 항목에 해당한다.

배경: content.summited_file_link는 /consult/analyze 요청 본문에 실려 오고 ai-api에는
인증이 없다. 예전에는 "s3://다른-버킷/키"를 넣으면 그 버킷을 그대로 읽어서 내용을
분석 결과 텍스트로 돌려줬다.

이 테스트는 Chroma를 열지 않으므로 ai-api가 떠 있는 상태에서 돌려도 안전하다.
"""

import pytest

from app.ai.config import S3_BUCKET_NAME
from app.ai.stt.multimodal import UntrustedFileLinkError, parse_s3_key


def test_plain_key_uses_configured_bucket():
    """core-api가 실제로 보내는 형태 — 버킷 없는 평범한 key."""
    bucket, key = parse_s3_key("consult-attachments/uuid__녹취.mp3")
    assert bucket == S3_BUCKET_NAME
    assert key == "consult-attachments/uuid__녹취.mp3"


def test_s3_uri_for_our_own_bucket_is_allowed():
    bucket, key = parse_s3_key(f"s3://{S3_BUCKET_NAME}/consult-attachments/a.txt")
    assert bucket == S3_BUCKET_NAME
    assert key == "consult-attachments/a.txt"


def test_other_bucket_is_rejected():
    """핵심 회귀 방지 — 남의 버킷을 지정하면 거절해야 한다."""
    with pytest.raises(UntrustedFileLinkError):
        parse_s3_key("s3://someone-elses-bucket/secret.txt")


@pytest.mark.parametrize(
    "link",
    [
        "http://169.254.169.254/latest/meta-data/",  # 클라우드 메타데이터
        "https://example.com/payload.txt",
        "file:///etc/passwd",
        "ftp://example.com/a.txt",
    ],
)
def test_non_s3_addresses_are_rejected(link):
    with pytest.raises(UntrustedFileLinkError):
        parse_s3_key(link)


@pytest.mark.parametrize("link", ["", "   ", None, "/", "s3://%s/" % S3_BUCKET_NAME])
def test_empty_links_are_rejected(link):
    with pytest.raises(UntrustedFileLinkError):
        parse_s3_key(link)


def test_parent_directory_segment_is_rejected():
    with pytest.raises(UntrustedFileLinkError):
        parse_s3_key("consult-attachments/../../etc/passwd")
