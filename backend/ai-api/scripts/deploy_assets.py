"""배포 자산을 S3로 올리고 내려받는다.

왜 필요한가:
    ai-api가 뜨려면 두 덩어리가 로컬 디스크에 있어야 한다.

        storage/chroma   177MB   RAG 색인. 없으면 법령·판례·상담사례 검색이 통째로 죽는다
        서식_hwpx         23MB   서식 원본 291개. 없으면 초안 생성이 안 된다

    둘 다 크기 때문에 git에 없다(.gitignore). 그래서 컨테이너 이미지에도, 새로 받은
    작업 PC에도 들어 있지 않다. 지금까지는 팀 드라이브에서 손으로 받아 왔는데,
    배포에서는 그렇게 할 수 없다.

    S3를 그 통로로 쓴다. 이미 첨부파일·초안으로 쓰고 있는 버킷이라 자격증명이
    따로 필요 없고, 서비스가 뜰 때 pull 한 번이면 된다.

왜 런타임에 S3에서 읽지 않고 내려받는가:
    Chroma는 sqlite 파일을 직접 열고, 서식 검색은 요청마다 디렉터리를 rglob한다.
    둘 다 로컬 파일시스템을 전제로 한 접근이라 S3로 바꾸면 느려지거나 아예 안 된다.
    ai-api는 어차피 Chroma 때문에 1대 고정이므로 EBS에 받아두면 충분하다.

쓰는 법:
    python -m scripts.deploy_assets push       로컬 → S3 (색인을 새로 만든 뒤)
    python -m scripts.deploy_assets pull       S3 → 로컬 (배포·새 PC 셋업)
    python -m scripts.deploy_assets status     양쪽에 무엇이 있는지만 확인

주의:
    push는 ai-api를 내리고 하는 게 안전하다. Chroma가 sqlite에 쓰는 중이면
    반쯤 쓰인 상태가 올라갈 수 있다. pull은 반대로 ai-api가 떠 있을 때 하면
    안 된다 — 열려 있는 파일을 덮어쓰게 된다.
"""

import argparse
import hashlib
import os
import shutil
import sys
import tarfile
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.ai.config import S3_BUCKET_NAME, get_s3_client  # noqa: E402

# ai-api 루트(이 파일의 부모의 부모).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

KEY_PREFIX = "deploy-assets/"

# (로컬 경로, S3에 올릴 이름). 이름에 한글을 쓰지 않는다 — S3 key는 되지만
# 배포 스크립트나 CI 로그에서 인코딩 문제로 애먹을 이유가 없다.
ASSETS = [
    ("storage/chroma", "chroma.tar.gz"),
    ("서식_hwpx", "forms-hwpx.tar.gz"),
]


def _human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def _dir_size(path):
    total = 0
    for dirpath, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return total


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def push():
    s3 = get_s3_client()
    for rel, name in ASSETS:
        src = os.path.join(ROOT, rel)
        if not os.path.isdir(src):
            print(f"  건너뜀  {rel} 없음")
            continue

        print(f"  압축 중  {rel}  ({_human(_dir_size(src))})")
        tmp = os.path.join(tempfile.gettempdir(), name)
        with tarfile.open(tmp, "w:gz") as tar:
            # arcname을 고정해 pull 쪽이 어디에 풀지 알 수 있게 한다.
            tar.add(src, arcname=os.path.basename(rel))

        size = os.path.getsize(tmp)
        digest = _sha256(tmp)
        key = KEY_PREFIX + name
        print(f"  업로드   {key}  ({_human(size)})")
        with open(tmp, "rb") as f:
            # 체크섬을 메타데이터로 같이 올린다. pull 쪽이 이미 같은 것을 받았는지
            # 크기만으로 판단하면 내용이 바뀌었는데 크기가 같은 경우를 놓친다.
            s3.put_object(Bucket=S3_BUCKET_NAME, Key=key, Body=f.read(),
                          Metadata={"sha256": digest})
        os.remove(tmp)
    print("\n완료. 배포에서는 pull로 받는다.")


def pull(force=False):
    s3 = get_s3_client()
    for rel, name in ASSETS:
        dest = os.path.join(ROOT, rel)
        key = KEY_PREFIX + name

        try:
            head = s3.head_object(Bucket=S3_BUCKET_NAME, Key=key)
        except Exception as e:  # noqa: BLE001
            print(f"  없음     {key} ({e.__class__.__name__}) — push가 먼저다")
            continue

        if os.path.isdir(dest) and not force:
            print(f"  건너뜀   {rel} 이미 있음 (--force로 덮어쓰기)")
            continue

        print(f"  내려받기 {key}  ({_human(head['ContentLength'])})")
        tmp = os.path.join(tempfile.gettempdir(), name)
        s3.download_file(S3_BUCKET_NAME, key, tmp)

        expected = head.get("Metadata", {}).get("sha256")
        if expected and _sha256(tmp) != expected:
            os.remove(tmp)
            raise SystemExit(f"체크섬 불일치: {key}. 받다가 깨졌다.")

        # 통째로 갈아끼운다. 남은 파일이 섞이면 Chroma가 옛 컬렉션을 들고 있게 된다.
        if os.path.isdir(dest):
            shutil.rmtree(dest)
        os.makedirs(os.path.dirname(dest) or ROOT, exist_ok=True)
        with tarfile.open(tmp, "r:gz") as tar:
            # filter="data"는 tar 안의 절대경로·상위경로(..) 항목을 거부한다.
            # 우리가 만든 tar라 지금은 문제될 게 없지만, 받아 온 파일을 푸는
            # 자리라 기본값(무제한)으로 두지 않는다. 3.14부터는 이게 기본이 된다.
            tar.extractall(os.path.dirname(dest) or ROOT, filter="data")
        os.remove(tmp)
        print(f"           → {rel}  ({_human(_dir_size(dest))})")
    print("\n완료. ai-api를 띄우면 된다.")


def status():
    s3 = get_s3_client()
    print(f"버킷 {S3_BUCKET_NAME}\n")
    print(f"  {'자산':<18} {'로컬':>10}   {'S3':>10}")
    for rel, name in ASSETS:
        src = os.path.join(ROOT, rel)
        local = _human(_dir_size(src)) if os.path.isdir(src) else "없음"
        try:
            head = s3.head_object(Bucket=S3_BUCKET_NAME, Key=KEY_PREFIX + name)
            remote = _human(head["ContentLength"])
        except Exception:  # noqa: BLE001
            remote = "없음"
        print(f"  {rel:<18} {local:>10}   {remote:>10}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="배포 자산을 S3로 올리고 내려받는다")
    parser.add_argument("action", choices=["push", "pull", "status"])
    parser.add_argument("--force", action="store_true",
                        help="pull에서 이미 있는 디렉터리도 덮어쓴다")
    args = parser.parse_args()

    if args.action == "push":
        push()
    elif args.action == "pull":
        pull(force=args.force)
    else:
        status()
