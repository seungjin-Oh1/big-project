"""평가용 대본 20건을 한 번에 음성으로 만든다.

generate_tts_single.py 는 대본 하나에 음성 하나를 만든다(녹음 파일이 사건별로
따로 있어야 하므로). 이 스크립트는 그걸 case_01..case_20 에 대해 순서대로 부른다.

이미 만들어둔 음성은 건너뛴다 — 중간에 끊겨도 다시 돌리면 남은 것부터 이어간다.
발화 단위 wav도 generate_tts_single.py 쪽에서 재사용하므로 두 번 결제되지 않는다.

사용
----
cd tts-mock
python build_all_audio.py
python build_all_audio.py --only case_03
python build_all_audio.py --dry-run
"""

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CASES = ROOT / "cases"
AUDIO = ROOT / "mock_audio"
SCRIPT = ROOT / "generate_tts_single.py"


def main():
    parser = argparse.ArgumentParser(description="평가 대본 20건 -> 음성")
    parser.add_argument("--only", default=None, help="특정 case_id 하나만")
    parser.add_argument("--dry-run", action="store_true", help="대본 파싱만 확인")
    parser.add_argument("--model", default="tts-1", help="tts-1 또는 tts-1-hd")
    args = parser.parse_args()

    targets = sorted(CASES.glob("case_*.md"))
    if args.only:
        targets = [p for p in targets if p.stem == args.only]
    if not targets:
        print("대본을 찾지 못했습니다.", file=sys.stderr)
        sys.exit(1)

    AUDIO.mkdir(parents=True, exist_ok=True)
    made, skipped, failed = 0, 0, 0

    for idx, md in enumerate(targets, start=1):
        wav = AUDIO / f"{md.stem}.wav"
        if wav.exists() and wav.stat().st_size > 0 and not args.dry_run:
            print(f"[{idx:02d}/{len(targets)}] {md.stem} 건너뜀 (이미 있음)")
            skipped += 1
            continue

        print(f"[{idx:02d}/{len(targets)}] {md.stem} 생성 중...")
        cmd = [
            sys.executable, str(SCRIPT),
            "--input", str(md),
            "--outdir", str(AUDIO),
            "--format", "wav",          # run_eval.py 가 .wav 를 찾는다
            "--model", args.model,
        ]
        if args.dry_run:
            cmd.append("--dry-run")

        result = subprocess.run(cmd, cwd=str(ROOT))
        if result.returncode != 0:
            print(f"  !! 실패: {md.stem}")
            failed += 1
        else:
            made += 1

    print(f"\n생성 {made}건 / 건너뜀 {skipped}건 / 실패 {failed}건")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
