"""DB에 암호문으로 저장된 상담 원문을 사람이 읽을 수 있게 푼다.

암호화(TolerantCryptoConverter)를 켠 뒤로는 psql로 상담 원문을 봐도 Base64만 보인다.
문제를 찾을 때 원문을 확인할 길이 아예 없으면 곤란해서, 같은 키로 푸는 도구를 함께 둔다.

  # 상담 55의 원문
  psql -At -c "SELECT input_text FROM consultation WHERE id=55" | python decrypt_pii.py

  # 대면 상담 이력 전체(한 줄에 하나씩)
  psql -At -c "SELECT unnest(inperson_input_texts) FROM consultation WHERE id=55" \
    | python decrypt_pii.py

암호문이 아닌 줄(암호화 전에 저장된 평문)은 그대로 통과시킨다.
키는 core-api와 같은 PII_ENCRYPTION_KEY 환경변수에서 읽는다.
"""
import base64
import hashlib
import os
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# CryptoConverter.DEV_DEFAULT_SECRET과 같아야 한다.
DEV_DEFAULT_SECRET = "dev-only-pii-encryption-key-please-change-in-production"
IV_LENGTH = 12

KEY = hashlib.sha256(
    os.environ.get("PII_ENCRYPTION_KEY", DEV_DEFAULT_SECRET).encode("utf-8")
).digest()


def decrypt(value: str) -> str:
    """암호문이면 풀고, 아니면 받은 값을 그대로 준다 (Java 쪽과 같은 규칙)."""
    try:
        combined = base64.b64decode(value, validate=True)
    except Exception:
        return value
    if len(combined) <= IV_LENGTH:
        return value
    try:
        iv, cipher_text = combined[:IV_LENGTH], combined[IV_LENGTH:]
        return AESGCM(KEY).decrypt(iv, cipher_text, None).decode("utf-8")
    except Exception:
        # GCM 인증 태그 불일치 = 암호문이 아니다.
        return value


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        print(decrypt(line.strip()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
