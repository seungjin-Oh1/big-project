"""평가용 상담 20건으로 분류·추출·서식 추천을 채점한다.

왜 필요한가
-----------
프롬프트를 고칠 때마다 다른 사건이 망가졌는지 아무도 모르는 상태였다.
같은 20건을 매번 돌려서 이전 결과와 비교할 수 있게 한다.

대본은 tts-mock/cases/case_01.md .. case_20.md 이고, 어떤 사건인지는 파일에
적지 않았다(분석기가 대화만 보고 판단해야 하므로). 정답은 answer_key.json 에 있다.

두 가지 경로를 지원한다
  --mode text   대본 텍스트를 바로 분석에 넣는다 (STT 제외, 빠르고 무료)
  --mode audio  mock_audio/case_XX.wav 를 STT로 받아쓴 뒤 분석에 넣는다 (전 구간)
같은 사건을 두 방식으로 돌려 비교하면, 틀렸을 때 STT가 놓친 건지 분석이 놓친
건지 가릴 수 있다.

사용
----
cd backend/ai-api
.\\venv\\Scripts\\python.exe ..\\..\\tts-mock\\run_eval.py --mode text
.\\venv\\Scripts\\python.exe ..\\..\\tts-mock\\run_eval.py --mode text --only case_03
.\\venv\\Scripts\\python.exe ..\\..\\tts-mock\\run_eval.py --mode text --skip-forms
"""

import argparse
import io
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AI_API = ROOT.parent / "backend" / "ai-api"
sys.path.insert(0, str(AI_API))

CASES_DIR = ROOT / "cases"
ANSWER_KEY = ROOT / "answer_key.json"
RESULT_DIR = ROOT / "eval_results"
AUDIO_DIR = ROOT / "mock_audio"

TURN_RE = re.compile(r"^(상담원|내담자)\s*:\s*(.+)$")

# 소분류는 사람이 봐도 갈리는 경우가 있어 정답을 하나로 못 박지 않는다.
# 예: 한정승인 상담은 "상속" 안에 딱 맞는 소분류가 없어서 상속일반으로 떨어진다.
# 서식은 이름에 이 조각이 들어가면 맞은 것으로 본다.
EXPECT = {
    "상속포기":            (["상속일반", "상속분"],                     ["상속포기", "포기"]),
    "한정승인":            (["상속일반", "상속분"],                     ["한정승인", "상속재산목록"]),
    "재판상이혼":          (["재판상이혼 등", "이혼 및 위자료"],          ["이혼", "위자료"]),
    "친생부인":            (["가,나,다류 가사소송"],                    ["친생부인"]),
    "국적":               (["국적의 취득과 상실", "신고"],              ["국적", "가족관계등록"]),
    "상속재산분할":         (["상속재산분할", "상속분"],                  ["상속재산분할", "협의"]),
    "양육비직접지급명령":    (["양육비직접지급명령"],                     ["직접지급명령"]),
    "이혼및위자료":         (["이혼 및 위자료", "재판상이혼 등"],          ["위자료", "이혼"]),
    "성년후견":            (["라,마류 가사비송"],                       ["후견"]),
    "이행명령":            (["이행명령"],                              ["이행명령"]),
    "유언":               (["유언"],                                  ["유언", "검인"]),
    "면접교섭권":          (["면접교섭권"],                             ["면접교섭"]),
    "출생신고":            (["신고"],                                  ["출생"]),
    "성본창설":            (["성본창설과 개명"],                        ["성", "변경"]),
    "유류분":             (["유류분"],                                ["유류분"]),
    "과태료와감치":         (["과태료와 감치", "이행명령"],               ["감치", "과태료", "이행명령"]),
    "친권":               (["친권"],                                  ["친권"]),
    "등록창설":            (["가족관계등록창설"],                       ["창설"]),
    "등록부정정":          (["가족관계등록부정정"],                     ["정정"]),
    "부양":               (["부양"],                                  ["부양"]),
}


def read_dialogue(case_id):
    """대본에서 발화만 뽑아 하나의 상담 텍스트로 만든다."""
    path = CASES_DIR / f"{case_id}.md"
    lines = []
    for line in path.read_text(encoding="utf-8").splitlines():
        m = TURN_RE.match(line.strip())
        if m:
            lines.append(f"{m.group(1)}: {m.group(2)}")
    return "\n".join(lines)


def transcribe(case_id):
    """mock_audio/case_XX.wav 를 받아쓴다. (--mode audio)

    extract_all()은 S3 키를 받아 내려받는 경로라 로컬 파일에는 쓸 수 없다.
    Whisper를 직접 부르는 함수(extract_text_from_audio_video)를 그대로 쓴다 —
    실제 파이프라인이 녹취 파일에 대해 부르는 것과 같은 함수다.
    """
    from app.ai.stt.multimodal import extract_text_from_audio_video  # text 모드에선 불필요

    wav = AUDIO_DIR / f"{case_id}.wav"
    if not wav.exists():
        raise FileNotFoundError(f"음성 파일이 없습니다: {wav}")
    return extract_text_from_audio_video(str(wav))


def score_case(case_id, meta, analysis, forms):
    """정답표와 대조한다. 맞았는지뿐 아니라 무엇이 나왔는지도 같이 남긴다."""
    label = meta["label"]
    expected_subtypes, expected_form_parts = EXPECT.get(label, ([], []))
    extracted = analysis.get("consult_extracted") or {}

    got_type = analysis.get("consult_case_type")
    got_subtype = analysis.get("consult_case_subtype")
    form_names = [r.get("form_name", "") for r in (forms or {}).get("recommendations", [])]

    parties = extracted.get("당사자") or []
    amounts = extracted.get("금액") or []
    dates = extracted.get("날짜") or []

    return {
        "case_id": case_id,
        "label": label,
        "type_ok": got_type == meta["case_type"],
        "type_expected": meta["case_type"],
        "type_got": got_type,
        "subtype_ok": got_subtype in expected_subtypes if expected_subtypes else None,
        "subtype_expected": expected_subtypes,
        "subtype_got": got_subtype,
        "form_ok": any(part in name for name in form_names for part in expected_form_parts)
                   if expected_form_parts else None,
        "form_expected_parts": expected_form_parts,
        "forms_got": form_names,
        "headline": analysis.get("consult_summary_headline") or "",
        "keywords": analysis.get("consult_summary_keywords") or [],
        "parties": [f"{p.get('역할')}:{p.get('이름')}" for p in parties],
        "amounts": [f"{a.get('항목')}={a.get('값')}" for a in amounts],
        "dates": [f"{d.get('항목')}={d.get('값')}" for d in dates],
        "summary_lines": len((analysis.get("consult_summary") or "").splitlines()),
    }


def main():
    parser = argparse.ArgumentParser(description="평가 20건 채점")
    parser.add_argument("--mode", choices=["text", "audio"], default="text")
    parser.add_argument("--only", default=None, help="특정 case_id 하나만 (예: case_03)")
    parser.add_argument("--skip-forms", action="store_true", help="서식 추천을 건너뛴다")
    parser.add_argument("--out", default=None, help="결과 JSON 경로")
    args = parser.parse_args()

    from app.ai import config  # noqa: F401  (.env 로드)
    from app.ai.analysis.service import analyze

    recommend = None
    if not args.skip_forms:
        from app.ai.forms.recommender import recommend

    key = json.loads(ANSWER_KEY.read_text(encoding="utf-8"))
    targets = [args.only] if args.only else sorted(key)

    results = []
    started = time.time()
    for idx, case_id in enumerate(targets, start=1):
        meta = key[case_id]
        print(f"[{idx:02d}/{len(targets)}] {case_id} ({meta['label']}) ... ", end="", flush=True)
        try:
            text = transcribe(case_id) if args.mode == "audio" else read_dialogue(case_id)
            result = analyze(text)
            payload = result.to_dict()

            forms = None
            if recommend and payload.get("consult_case_type"):
                forms = recommend({
                    "case_type": payload["consult_case_type"],
                    "case_subtype": payload.get("consult_case_subtype"),
                    "summary": payload.get("consult_summary") or "",
                    "extracted_json": payload.get("consult_extracted") or {},
                })

            row = score_case(case_id, meta, payload, forms)
            marks = "".join([
                "T" if row["type_ok"] else "t",
                "S" if row["subtype_ok"] else "s",
                "F" if row["form_ok"] else "f",
            ])
            print(f"{marks}  {row['type_got']}/{row['subtype_got']}")
        except Exception as exc:  # noqa: BLE001
            print(f"실패: {type(exc).__name__}: {exc}")
            row = {"case_id": case_id, "label": meta["label"], "error": f"{type(exc).__name__}: {exc}"}
        results.append(row)

    ok = [r for r in results if not r.get("error")]
    type_ok = sum(1 for r in ok if r.get("type_ok"))
    subtype_ok = sum(1 for r in ok if r.get("subtype_ok"))
    form_ok = sum(1 for r in ok if r.get("form_ok"))

    print("\n" + "=" * 62)
    print(f"모드: {args.mode}   소요: {time.time() - started:.0f}초")
    print(f"대분류  {type_ok}/{len(ok)}")
    print(f"소분류  {subtype_ok}/{len(ok)}")
    if not args.skip_forms:
        print(f"서식    {form_ok}/{len(ok)}")
    if len(results) != len(ok):
        print(f"실패    {len(results) - len(ok)}건")
    print("=" * 62)

    print("\n틀린 건")
    for r in ok:
        if r.get("type_ok") and r.get("subtype_ok") and (args.skip_forms or r.get("form_ok")):
            continue
        print(f"  {r['case_id']} ({r['label']})")
        if not r.get("type_ok"):
            print(f"    대분류: {r['type_expected']} -> {r['type_got']}")
        if not r.get("subtype_ok"):
            print(f"    소분류: {r['subtype_expected']} -> {r['subtype_got']}")
        if not args.skip_forms and not r.get("form_ok"):
            print(f"    서식: {r['form_expected_parts']} 중 하나를 기대했는데 {r['forms_got']}")

    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    out = Path(args.out) if args.out else RESULT_DIR / f"{args.mode}_{time.strftime('%m%d_%H%M')}.json"
    with io.open(out, "w", encoding="utf-8", newline="\n") as fp:
        json.dump(results, fp, ensure_ascii=False, indent=2)
        fp.write("\n")
    print(f"\n상세 결과: {out}")


if __name__ == "__main__":
    main()
