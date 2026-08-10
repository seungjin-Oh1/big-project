# ai/forms/drafter.py — 서식 초안 생성 모듈 (정형 치환 + 예시문단 재서술)
#
# 두 종류의 채우기를 명확히 분리:
#   A. 정형 치환: 자리표시자(○○○ 등) 주변 라벨로 값 치환. GPT가 before/after 생성.
#   B. 예시문단 재서술: 서식에 인쇄된 '남의 사연' 문단을 코드가 인덱스로 특정해,
#      우리 사건 사실로 재서술 후 그 문단 객체만 직접 교체.
#      (텍스트 검색이 아니라 문단 객체 직접 수정 → 오염 불가, run쪼개짐 무관)
#
# 사용:
#   from app.ai.forms.drafter import draft
#   result = draft("이혼 및 위자료 조정신청서", extracted, summary)

import json
import re
import time
import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
from hwpx import HwpxDocument

from app.ai.forms.verifier import llm_judge

load_dotenv()
# 초안 생성·검증(verifier)·법령 추천 이유(statutes/explainer)가 함께 쓰는 모델.
# gpt-4o-mini는 자리표시자가 많은 큰 서식에서 응답이 2만 4천 자를 넘다가 잘려
# JSON 파싱이 깨졌다. 그러면 치환 목록이 통째로 버려져 당사자란이 빈 초안이
# 나간다. 녹취 8건으로 비교한 결과 채워진 칸 43 -> 69개, 초안 생성 실패
# 1 -> 0건, 유류분반환청구의 소 263 -> 34초.
# 비용이 부담되면 .env의 LLM_MODEL로 되돌릴 수 있다.
MODEL = os.getenv("LLM_MODEL", "gpt-5.4-mini")

# 치환을 만드는 두 호출(_generate_fields, _generate_table_fields)만 따로 뗀다.
#
# 이 단계는 글쓰기가 아니라 원문 복사 정확도 문제다 — before가 문서 원문과 글자
# 하나까지 같아야 replace_text_in_runs가 찾는다. 서식은 라벨 사이를 벌려 쓰고
# ("채 권 자") 공백 개수도 제각각이라, 하나만 틀려도 치환이 조용히 실패한다.
# 거기에 "이 칸의 주인이 누구인가"(채무자 vs 소득세원천징수의무자) 판단이 겹친다.
#
# 실패 방향도 다르다. B단계는 검증에 걸리면 문단을 비우고 상담원에게 넘기지만,
# A단계가 틀리면 자리표시자를 지운 채 그럴듯한 값이 남아 C단계 표시조차 안 붙는다.
# 그래서 여기만 올릴 수 있게 해 둔다. 안 주면 MODEL과 같아 동작이 그대로다.
STRUCT_MODEL = os.getenv("LLM_STRUCT_MODEL") or MODEL
_client = None


def _get_openai_client():
    global _client

    if _client is None:
        _client = OpenAI()

    return _client

ROOT = Path(__file__).resolve().parent.parent.parent.parent
HWPX_ROOT = ROOT / "서식_hwpx"
OUTPUT = ROOT / "output"
OUTPUT.mkdir(exist_ok=True)

# 서식마다 이름 자리표시자로 쓰는 특수문자가 다르다(○○이 기본이지만
# ◇◇·◉◉ 같은 반복 기호나, "①○"처럼 원문자+○ 조합으로 쓰는 서식도 있음).
# "195○. ○. ○"처럼 연도 앞자리만 실제 숫자고 나머지가 ○로 분리된 형식은
# 사이에 마침표·공백이 껴서 기존 패턴에 안 걸렸다 — \d{2,3}○와 ○\.\s*○를 추가.
PLACEHOLDER_RE = re.compile(
    r"○\s*○|□\s*□|◎\s*◎|◇\s*◇|◉\s*◉|●\s*●|▲\s*▲|"
    r"20○○|19○○|△\s*△|[①②③④⑤⑥⑦⑧⑨]\s*○|○\s*[①②③④⑤⑥⑦⑧⑨]|"
    r"\d{2,3}○|○\s*\.\s*○"
)


# ══════════════════════════════════════
# A. 정형 치환용 GPT 프롬프트 (자리표시자 값 채우기만)
# ══════════════════════════════════════
FIELD_PROMPT = """너는 법률 서식의 자리표시자를 실제 값으로 바꾸는 치환목록을 만든다.

규칙:
1. 서식 원문 문구는 바꾸지 않는다. 자리표시자(○○○, ○ ○ ○, □□□, △△△,
   20○○ 등)만 값으로 치환한다.
1-1. 다만 이름 자리표시자 바로 앞의 한글 한 글자는 서식 원문이 아니라
   서식 제작자가 넣은 '예시 인물의 성씨'다 — "장 ○ ○"의 "장",
   "곽 △ △"의 "곽". before에 포함시키는 것으로 끝이 아니라,
   **after에서 그 성씨를 반드시 지워야 한다.**
   extracted의 이름("서지호")은 이미 성과 이름을 다 갖춘 온전한 이름이라,
   예시 성씨가 남으면 성이 둘인 없는 사람이 만들어진다.

     원문:   청구인  장 ○ ○ (주민등록번호)
     맞음:   {"before": "청구인  장 ○ ○ (주민등록번호)",
              "after":  "청구인  서지호 (주민등록번호)"}
     틀림:   {"after": "청구인  장 서지호 (주민등록번호)"}   ← 성씨 잔존
     틀림:   {"before": "○ ○", "after": "서지호"}          ← before가 성씨를 빼먹음

   after의 이름 자리에는 extracted의 이름이 글자 그대로만 들어간다.
   앞뒤에 서식에 있던 다른 한글을 덧붙이지 않는다.
1-2. 자리표시자가 아니라 '이미 값이 채워진 것처럼 보이는 항목'도 서식 제작자가
   넣은 예시일 수 있다 — "유언자와의 관계 : 배우자", "국적 : 중화민국" 처럼
   라벨 뒤에 구체적인 값이 인쇄돼 있는 줄이다. 이 사건의 사실로 답을 알 수
   있으면 그 값으로 바꾼다. 모르면 건드리지 않는다(추측 금지).

     상담: "피상속인(부친)이 자필증서 유언을 남겼고, 아들 남기훈이 신청"
     원문: 유언자와의 관계 : 배우자
     맞음: 유언자와의 관계 : 아들
     틀림: 그대로 두기 (신청인이 아들인 게 상담에 있으므로 알 수 있다)

   관계·역할은 상담에 그대로 적혀 있지 않아도 문장에서 확정적으로 따라나오면
   쓴다. "피상속인이 유언을 남겼다"면 유언자는 피상속인이고, 신청인이 그
   자녀면 관계는 '아들' 또는 '딸'이다. 다만 이건 관계·역할에만 해당한다 —
   이름·날짜·금액·주소는 상담에 명시된 값이 아니면 절대 쓰지 않는다.
2. extracted에 명시된 값만 사용. 없으면 unfilled에만 넣는다.
   날짜·금액·주소·주민번호는 정확한 값 없으면 절대 치환하지 않는다.
3. before는 자리표시자 주변 라벨을 포함해 원문에서 유일하게 특정되게 복사
   ("신 청 인   ○  ○  ○" 처럼). 여러 줄에 걸친 긴 서술 문단은 대상 아님
   (그건 별도 처리하므로 여기선 무시).
3-1. before에는 '지워질 것'(자리표시자 또는 바꿀 예시값)이 반드시 들어 있어야
   한다. 라벨만 잡아놓고 after에서 뒤에 이름을 이어 붙이면 안 된다 — 같은 줄을
   제대로 치환한 항목과 겹쳐 이름이 두 번 들어간다.

     맞음: {"before": "신 청 인  ○  ○  ○", "after": "신 청 인  남기훈"}
     틀림: {"before": "신 청 인",           "after": "신 청 인 남기훈"}

   한 줄에는 항목을 하나만 만든다. 그 줄을 이미 다뤘으면 또 만들지 않는다.
4. role을 반드시 붙인다: 청구인/상대방/사건본인/공동당사자/기타.
   신청인=청구인, 피신청인=상대방, 원고=청구인, 피고=상대방.
   청구인 자리에 상대방 값을 넣는 것은 최악의 오류다.
4-1. 다투는 상대가 없고 당사자 전원이 대등한 서식(협의서·합의서·동의서 등)에는
   청구인도 상대방도 아예 없다. 공동상속인, 협의당사자, 연서인처럼 나란히
   놓인 자리는 전부 role="공동당사자"로 붙인다.

     원문: 공동상속인 ○○○, ○○○, ○○○는 다음과 같이 …
     맞음: {"after": "공동상속인 조민석, 조회진, 조수는 다음과 같이 …",
            "role": "공동당사자"}

   role="기타"는 '역할을 판단하지 못했다'는 뜻으로만 쓴다. 이름 자리표시자를
   채우면서 기타를 붙이면 그 치환은 통째로 버려져 빈칸으로 남으니, 역할을
   알 수 있으면 반드시 위 다섯 중 맞는 것을 고른다. 대등한 당사자를
   '기타'로 처리하는 것은 흔한 오답이다 — 그건 '공동당사자'다.
5. 같은 사람 이름이 당사자란과 서명란("위 신청인")에 각각 나오면
   각각 별도 항목으로 만든다 (각 위치의 주변 라벨을 before에 포함).
6. 서명란 바로 위의 작성일자("20○○년   ○월   ○일" 형태로 "위 신청인/원고 (인)"
   바로 앞에 있는 날짜)는 절대 채우지 않는다. 이건 사건 사실의 날짜가 아니라
   상담원이 실제 제출하는 날 직접 적는 칸이다. 임의로 오늘 날짜 비슷한 값을
   지어내 채우는 것은 명백한 오류이며, 다른 어떤 규칙보다 우선한다.
7. 자리표시자가 요구하는 정밀도(연/월/일)까지 extracted에 정확히 다 있을 때만
   채운다. extracted에 "2026-01"처럼 연-월까지만 있는데 자리표시자가
   "20○○. ○. ○."처럼 일(day)까지 요구하면, 없는 일자를 지어내 채우지 말고
   통째로 unfilled로 남긴다. 부분적으로 아는 값의 나머지를 추측하는 것도
   지어내는 것과 같은 오류다.
8. 같은 역할의 칸이 여러 개인데(사건본인 1., 2. … / 청구인 1., 2. …)
   extracted의 실제 인원이 그보다 적으면, 남는 칸은 채우지 말고 unfilled로
   남긴다. 서식은 흔히 자녀 2명을 전제로 칸을 두 개 두는데, 자녀가 한 명인
   사건에서 같은 이름을 두 칸에 넣으면 없는 사람이 하나 생긴다.

출력 JSON:
{"replacements": [{"before": "...", "after": "...", "role": "청구인"}],
 "unfilled": ["..."]}"""


def _generate_fields(markdown: str, extracted: dict, summary: str) -> dict:
    """정형 치환 목록 생성. 서식이 크면 GPT 응답이 중간에 잘려 JSON 파싱이
    깨지는 경우가 있다 — 이 경우 정형 치환만 건너뛰고(예시문단 재서술은
    별개로 계속 진행), 원인을 error로 남겨 draft()가 보고할 수 있게 한다."""
    user_msg = (f"[서식 마크다운]\n{markdown}\n\n"
                f"[사건 요약]\n{summary}\n\n"
                f"[추출정보]\n{json.dumps(extracted, ensure_ascii=False, indent=2)}")
    try:
        resp = _get_openai_client().chat.completions.create(
            model=STRUCT_MODEL,
            messages=[{"role": "system", "content": FIELD_PROMPT},
                      {"role": "user", "content": user_msg}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        return {"replacements": [], "unfilled": [],
                "error": f"{type(e).__name__}: {e}"}


# ══════════════════════════════════════
# E. 표 셀 채우기
# ══════════════════════════════════════
# python-hwpx는 표를 doc.sections→paragraphs→runs 순회로는 전혀 보여주지
# 않는다(표 안 문단은 별도 구조). 291개 서식 중 96%가 표를 포함하고, 그
# 표 안에 원본 예시 인물이나 실제 채워야 할 서술란이 들어있는 경우가
# 있어(예: 가족관계등록 창설신청서의 당사자 표, 한정후견개시의 청구
# 동기란) 별도로 다뤄야 한다. get_table_map()으로 읽고 set_cell_text()로
# 쓴다 — 둘 다 저장→재오픈 라운드트립으로 반영 확인됨.
TABLE_FIELD_PROMPT = """너는 법률 서식의 표 안 자리표시자를 실제 값으로 바꾸는 치환목록을 만든다.

표는 (표번호, 행, 열, 현재텍스트) 형태로 주어진다. 보통 "라벨 셀"(예: 성명,
출생연월일, 주민등록번호, 관계)의 바로 옆이나 아래 칸이 "값을 채워야 할 셀"이며,
그 자리에 자리표시자(○○○, 빈칸, "   년   월   일" 같은 빈 날짜 칸 등)가 있거나,
서식 제작자가 넣은 가상의 예시 값(예: "김본인", "김일남")이 이미 인쇄돼 있다.

규칙:
1. extracted에 명시된 값만 사용한다. 없으면 건드리지 않는다.
2. 라벨 셀 자체(예: "성명", "구분")는 절대 바꾸지 않는다 — 그 라벨에 대응하는
   값 셀만 바꾼다.
3. 서식에 이미 뭔가 채워진 것처럼 보여도(가상의 예시 인물 이름 등), 그건 서식
   제작자가 넣은 남의 사연이지 우리 사건이 아니다. extracted에 해당 항목이
   있으면 그 값으로 교체한다.
4. 날짜·금액·주소·주민번호는 정확한 값이 없으면 절대 채우지 않는다. 부분적으로만
   아는 값(예: 연-월만 있는데 일자까지 요구)의 나머지를 추측하지 않는다.
5. "관련법규", "제출법원", "비용", "제출부수", "해설", 체크박스(□)로 된 선택
   항목 안내처럼 이 사건과 무관하게 항상 고정인 안내/법조문 셀은 건드리지 않는다.
6. 확신이 없으면 건드리지 않는다 — 틀린 칸에 잘못 채우는 것보다 안 채우는 게 낫다.

출력 JSON:
{"cell_replacements": [
  {"table_index": 0, "row": 1, "col": 1, "value": "..."}
]}"""


def _collect_tables(doc) -> list:
    """문서 안의 모든 표 객체를 문서 순서대로 수집한다.
    get_table_map()의 table_index와 같은 순서여야 (읽기용 메타데이터와
    쓰기용 객체를 인덱스로 짝지을 수 있음)."""
    tables = []
    for sec in doc.sections:
        for p in sec.paragraphs:
            for t in (getattr(p, "tables", None) or []):
                tables.append(t)
    return tables


def _describe_tables(tables_meta: list) -> str:
    lines = []
    for table in tables_meta:
        idx = table.get("table_index")
        for cell in table.get("cells", []):
            text = cell.get("text", "").strip()
            lines.append(f"[표{idx} 행{cell['row']} 열{cell['col']}] {text}")
    return "\n".join(lines)


def _generate_table_fields(tables_meta: list, extracted: dict, summary: str) -> dict:
    if not tables_meta:
        return {"cell_replacements": []}
    desc = _describe_tables(tables_meta)
    user_msg = (f"[표 셀 목록]\n{desc}\n\n"
                f"[사건 요약]\n{summary}\n\n"
                f"[추출정보]\n{json.dumps(extracted, ensure_ascii=False, indent=2)}")
    try:
        resp = _get_openai_client().chat.completions.create(
            model=STRUCT_MODEL,
            messages=[{"role": "system", "content": TABLE_FIELD_PROMPT},
                      {"role": "user", "content": user_msg}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        return {"cell_replacements": [], "error": f"{type(e).__name__}: {e}"}


def _row_label(tables_meta: list, idx: int, row: int) -> str:
    """그 행의 라벨(보통 0열 머리글)을 읽는다. 없으면 빈 문자열."""
    # table_index는 목록 위치와 같게 만들어져 있지만(_collect_tables 주석),
    # 값으로 한 번 더 맞춰 본다 — 어긋나면 엉뚱한 표의 라벨을 보게 된다.
    meta = next((t for t in (tables_meta or [])
                 if t.get("table_index") == idx), None)
    if meta is None:
        try:
            meta = tables_meta[idx]
        except (IndexError, TypeError):
            return ""
    for c in (meta.get("cells") or []):
        if c.get("row") == row and c.get("col") == 0:
            return re.sub(r"\s+", "", str(c.get("text", "")))
    return ""


def _apply_table_fields(table_objs: list, replacements: list,
                        tables_meta: list = ()) -> tuple:
    """GPT가 제안한 셀 치환을 실제로 적용. 범위를 벗어나거나 실패하면
    조용히 건너뛴다(표 하나 잘못됐다고 전체가 죽으면 안 됨).

    안내표 행은 채우지 않는다. TABLE_FIELD_PROMPT 5번에 "제출법원·관련법규·
    비용 셀은 건드리지 마라"고 적어 두었는데도 LLM이 어긴다 — 실측에서
    상속한정승인 심판청구서의 '제출법원' 칸에 사망자 이름이 들어갔다.
    그 표는 서식 안내문이라 사건과 무관하게 항상 고정이고, 거기 사람 이름이
    찍히면 서류를 읽는 사람이 무엇을 믿어야 할지 알 수 없게 된다.
    프롬프트로 못 막는 것은 코드로 막는다.

    반환: (적용건수, 실패목록, 이번에 채운 (table_index,row,col) 집합)."""
    applied, missed, filled_keys = 0, [], set()
    for r in replacements:
        idx, row, col, value = r.get("table_index"), r.get("row"), r.get("col"), r.get("value")
        if idx is None or row is None or col is None or not value:
            continue
        if not (0 <= idx < len(table_objs)):
            missed.append(r)
            continue
        label = _row_label(tables_meta, idx, row)
        if label and any(k in label for k in TABLE_NONFILLABLE_LABELS):
            missed.append(r)
            continue
        try:
            table_objs[idx].set_cell_text(row, col, str(value))
            applied += 1
            filled_keys.add((idx, row, col))
        except Exception:
            missed.append(r)
    return applied, missed, filled_keys


TABLE_EXAMPLE_TAG = "[예시:확인필요] "

# 이런 라벨(보통 0열)이 붙은 행/셀은 이 사건과 무관하게 항상 고정인 안내문·
# 법조문·참조 문구다 — 자리표시자가 있어도 "채워야 할 빈칸"이 아니므로
# 안전장치 대상에서 제외한다 (FIELD_PROMPT 규칙 5와 같은 취지).
TABLE_NONFILLABLE_LABELS = (
    "관련법규", "비용", "제출법원", "제출부수", "해설", "불복절차",
    "청구권자", "결격사유", "관할", "인지", "송달료",
)


TABLE_CLASSIFY_PROMPT = """너는 법률 서식의 표 안에서, 서식 제작자가 넣은 가상의
예시 행(사람 이름·날짜·주소 등 이미 채워진 것처럼 보이는 구체적 데이터)인데
아직 실제 값으로 안 바뀐 행을 가려내는 분류기다.

각 항목은 "(라벨) 값1 | 값2 | ..." 형태로, 표의 한 행 전체를 보여준다.
라벨은 그 행이 무슨 항목인지 알려준다(예: "부", "모", "배우자", "본인").

핵심 신호: **행 안의 일부 값(주로 이름)만 구체적으로 채워져 있고 나머지
값들은 비어있거나 자리표시자·미기재 상태**라면, 이건 서식 제작자가 이름 등
일부만 예시로 인쇄해둔 가상의 사람일 가능성이 매우 높다 — 진짜 우리 사건
정보라면 상담원이 아는 만큼 자연스럽게 채웠을 것이지, 이름만 정확히 알고
나머지(생년월일·주민번호 등)를 전부 모를 이유가 없기 때문이다.

[추출정보]/[사건 요약]과도 대조하라: 그 라벨에 해당하는 사람/항목이
[추출정보]에 아예 없는데 행에 구체적 값이 있으면 예시일 가능성이 높다.

각 행이 "예시 행"(true)인지 "정상"(false)인지 판단하라. 애매하면 false.

## 출력 JSON (입력 개수·순서와 같은 배열)
{"is_example": [true/false, ...]}"""


def _classify_table_rows_batch(row_descs: list, extracted: dict, summary: str) -> list:
    """row_descs: 사람이 읽을 수 있는 행 설명 문자열 리스트."""
    if not row_descs:
        return []
    numbered = "\n".join(f"[{i}] {d}" for i, d in enumerate(row_descs))
    user_msg = (f"[행 목록]\n{numbered}\n\n"
                f"[사건 요약]\n{summary}\n\n"
                f"[추출정보]\n{json.dumps(extracted, ensure_ascii=False, indent=2)}")
    try:
        resp = _get_openai_client().chat.completions.create(
            model=MODEL,
            messages=[{"role": "system", "content": TABLE_CLASSIFY_PROMPT},
                      {"role": "user", "content": user_msg}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        out = json.loads(resp.choices[0].message.content)
        flags = out.get("is_example", [])
    except Exception:
        return [False] * len(row_descs)
    if len(flags) != len(row_descs):
        return [False] * len(row_descs)
    return [bool(f) for f in flags]


def _mark_unresolved_table_cells(table_objs: list, tables_meta: list, filled_keys: set,
                                  extracted: dict, summary: str) -> int:
    """방금 채운 셀은 제외하고, 남아있는 셀 중:
    1) 자리표시자가 있으면 바로 표시 — 단, 관련법규·비용·제출법원처럼 항상
       고정인 안내문 행은 제외(TABLE_NONFILLABLE_LABELS)
    2) 자리표시자는 없지만 '이미 채워진 것처럼' 보이는 값(예: 원본 예시 인물
       이름)은 GPT로 배치 분류해서 표시.

    셀 하나하나를 떼어 보여주면 "김일남" 같은 값이 다른 정상 필드값과
    섞여 GPT가 예시인지 판단할 신호가 약해진다(실측: 개별 셀 분류로는
    31개 후보 중 진짜 예시 인물도 전부 놓침) — 그래서 행 전체를 한 단위로
    보여준다. "이름만 채워지고 나머지는 다 빈칸"이라는 패턴 자체가
    예시 인물임을 보여주는 핵심 신호이기 때문이다.

    표는 칸 너비가 고정이라 문단용 긴 태그를 쓰면 레이아웃이 깨질 수 있어
    짧은 태그(TABLE_EXAMPLE_TAG)를 쓴다."""
    marked = 0

    for table in tables_meta:
        idx = table.get("table_index")
        if not (0 <= idx < len(table_objs)):
            continue

        rows = {}
        for cell in table.get("cells", []):
            rows.setdefault(cell["row"], []).append((cell["col"], cell.get("text", "")))

        row_batch = []  # [(idx, row, [(col,text) to mark]), ...] — 이번 표의 후보 행
        for row, cells in rows.items():
            if row == 0:
                continue  # 0행은 열 제목
            label = next((t.strip() for c, t in cells if c == 0), "")
            if any(nf in label for nf in TABLE_NONFILLABLE_LABELS):
                continue
            value_cells = [(c, t) for c, t in sorted(cells)
                           if c != 0 and (idx, row, c) not in filled_keys
                           and t.strip() and not t.startswith(TABLE_EXAMPLE_TAG)
                           and "☞" not in t and "참조" not in t]
            if not value_cells:
                continue

            placeholder_cells = [(c, t) for c, t in value_cells if PLACEHOLDER_RE.search(t)]
            plain_cells = [(c, t) for c, t in value_cells if not PLACEHOLDER_RE.search(t)]

            for c, t in placeholder_cells:
                try:
                    table_objs[idx].set_cell_text(row, c, TABLE_EXAMPLE_TAG + t)
                    marked += 1
                except Exception:
                    pass

            # 너무 긴 행(해설·법조문 등 boilerplate)은 분류 대상에서 제외
            total_len = sum(len(t) for _, t in plain_cells)
            if plain_cells and total_len <= 150:
                row_batch.append((idx, row, label, plain_cells))

        if row_batch:
            descs = [f"(라벨: {label or '?'}) " + " | ".join(t for _, t in cells)
                     for (_, _, label, cells) in row_batch]
            flags = _classify_table_rows_batch(descs, extracted, summary)
            for (i2, row, _label, cells), is_example in zip(row_batch, flags):
                if not is_example:
                    continue
                for c, t in cells:
                    try:
                        table_objs[i2].set_cell_text(row, c, TABLE_EXAMPLE_TAG + t)
                        marked += 1
                    except Exception:
                        pass

    return marked


# ══════════════════════════════════════
# B. 예시문단 재서술
# ══════════════════════════════════════
NARRATIVE_END_RE = re.compile(r"(습니다|하였|였다|입니다|되었|하고|근무|생활)")


def _is_narrative(text: str) -> bool:
    return len(text) >= 40 and bool(NARRATIVE_END_RE.search(text))


# 법조문 인용("민법 제1091조 제1항", "제837조의2"). 이게 있는 문단은 서식이
# 주는 정형 문구지 남의 사연이 아니다.
STATUTE_CITE_RE = re.compile(r"제\s*\d+\s*조(?:\s*의\s*\d+)?")


def _cites_statute(text: str) -> bool:
    """이 문단이 법조문을 인용하고 있는가.

    유언증서 검인신청서에서 이런 일이 났다. 청구원인 2번 문단이

        "2. 신청인은 20○○. ○. ○. 유언자 망 □□□가 ... 유언자가 사망했으므로
         민법 제1091조 제1항에 의하여 이건 검인을 청구합니다."

    인데, 40자가 넘고 자리표시자(□□□)가 있어 '예시 사연'으로 분류됐다.
    그래서 통째로 재서술됐고, 그 결과 **민법 제1091조와 청구 결론이 문서에서
    사라졌다** — 상담 코멘트("즉각적인 위험은 없는 상황입니다")가 그 자리에
    들어갔다. 원본 서식을 따로 펴보지 않는 한 무엇이 빠졌는지 알 수 없다.

    이 문단은 이름과 날짜만 채우면 그대로 쓸 수 있는 완성된 법률 문장이었다.
    다시 쓸 이유가 없었다. 법조문을 인용하는 문단은 재서술 대상에서 제외해
    원본을 지키고, 빈칸은 자리표시자 표시로 상담원에게 넘긴다."""
    return bool(STATUTE_CITE_RE.search(text))


CLASSIFY_PROMPT = """너는 법률 서식 원문에서 '서식 제작자가 넣은 가상의 예시 사연'을
가려내는 분류기다.

법률 서식에는 보통 두 종류의 긴 문단이 있다:
1. 예시 사연: 실제 있음직한 가상의 인물·사건으로 채워진 완결된 이야기
   (구체적 날짜·금액·직업·장소 등이 이미 다 채워져 있거나, ○○ 같은
   자리표시자가 섞여 있음). 이 사건과 무관한 남의 얘기이며, 상담원이
   실제 사건 내용으로 통째로 바꿔써야 하는 부분이다.
2. 안내문/법조문/정형 문구: 관할법원 안내, 신청취지의 정형 문구, 제출 서류
   설명, "~를 기재해 주십시오" 같은 작성 안내 등 이 사건과 무관하게 항상
   그대로 유지되는 문구.

아래 [문단들]은 문서에서 끊김 없이 이어지는 하나의 블록이다. 이 블록 전체가
1번(예시 사연)인지 2번(안내문 등)인지 판단하라. 조금이라도 애매하면
2번(건드리지 않음)으로 판단한다.

## 출력 JSON
{"is_example": true/false, "reason": "..."}"""


def _classify_is_example(texts: list) -> bool:
    joined = "\n".join(f"[{i}] {t}" for i, t in enumerate(texts))
    try:
        resp = _get_openai_client().chat.completions.create(
            model=MODEL,
            messages=[{"role": "system", "content": CLASSIFY_PROMPT},
                      {"role": "user", "content": f"[문단들]\n{joined}"}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        out = json.loads(resp.choices[0].message.content)
        return bool(out.get("is_example"))
    except Exception:
        return False


CLASSIFY_BATCH_PROMPT = """너는 법률 서식 원문에서 '서식 제작자가 넣은 가상의 예시 사연'을
가려내는 분류기다.

법률 서식에는 보통 두 종류의 긴 문단이 있다:
1. 예시 사연: 실제 있음직한 가상의 인물·사건으로 채워진 완결된 이야기
   (구체적 날짜·금액·직업·장소·인명 등이 이미 다 채워져 있음). 이 사건과
   무관한 남의 얘기이며, 상담원이 실제 사건 내용으로 통째로 바꿔써야 한다.
2. 안내문/법조문/정형 문구: 관할법원 안내, 신청취지의 정형 문구, 제출 서류
   설명 등 이 사건과 무관하게 항상 그대로 유지되는 문구.

아래 [문단들]은 서로 무관한 개별 문단들이다(하나의 흐름이 아니다). 각 문단을
독립적으로 1번(예시 사연)인지 2번(안내문 등)인지 판단하라. 조금이라도
애매하면 2번(false)으로 판단한다.

## 출력 JSON (입력 문단 개수와 순서가 같은 배열)
{"is_example": [true/false, ...]}"""


def _classify_examples_batch(texts: list) -> list:
    """문단마다 개별 호출하면 문단이 많은 서식에서 GPT 호출이 과도하게
    쌓인다 — 한 번의 호출로 여러 문단을 동시에 판정한다."""
    if not texts:
        return []
    numbered = "\n".join(f"[{i}] {t}" for i, t in enumerate(texts))
    try:
        resp = _get_openai_client().chat.completions.create(
            model=MODEL,
            messages=[{"role": "system", "content": CLASSIFY_BATCH_PROMPT},
                      {"role": "user", "content": f"[문단들]\n{numbered}"}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        out = json.loads(resp.choices[0].message.content)
        flags = out.get("is_example", [])
    except Exception:
        return [False] * len(texts)
    if len(flags) != len(texts):
        return [False] * len(texts)
    return [bool(f) for f in flags]


# 청구취지/신청취지 구간의 시작과 끝. 글자 사이를 벌려 쓰므로 공백을 지워 비교한다.
DEMAND_SECTION_START_RE = re.compile(r"^(청구취지|신청취지|청구의취지|신청의취지)$")
DEMAND_SECTION_STOP_RE = re.compile(
    r"^(청구원인|청구이유|신청원인|신청이유|청구의원인|사건의개요|첨부서류|입증방법|소명방법)"
)


def _demand_clause_mask(texts: list) -> list:
    """각 문단이 청구취지 구간 안에 있는지 표시한다.

    청구취지는 법원에 무엇을 명해 달라는 정형 문구다 — 사건 사실을 서술하는
    칸이 아니라, 금액·기간만 채워 넣는 칸이다. 그런데 자리표시자가 들어 있고
    문장이 길어서 B단계가 '예시 사연'으로 오인한다. 실제로 양육비 심판청구서의

        1. 상대방은 청구인에게 사건본인의 양육비로 금 76,000,000 원 및 …
           20○○. ○. ○.부터 … 매월 말일에 지급하라.

    가 통째로 "신청인 정미래와 피신청인 김도훈은 혼인 관계에 있었습니다."로
    덮여서 청구취지 자체가 사라졌다. 원본을 남기면 자리표시자가 그대로라
    C단계가 표시를 붙여 상담원에게 넘긴다."""
    mask = [False] * len(texts)
    inside = False
    for i, t in enumerate(texts):
        compact = re.sub(r"\s+", "", t)
        if not compact:
            mask[i] = inside
            continue
        if DEMAND_SECTION_START_RE.match(compact):
            inside = True
            continue
        if inside and DEMAND_SECTION_STOP_RE.match(compact):
            inside = False
        mask[i] = inside
    return mask


# 별지의 시작. "별지", "(별 지)", "별지." 등 모양이 제각각이라 공백을 지워 본다.
# 본문 문장("별지 목록 기재와 같이 …")이 구간을 열어버리면 그 뒤가 통째로
# 재서술 대상에서 빠지므로, 제목처럼 짧은 줄일 때만 인정한다.
ANNEX_START_RE = re.compile(r"^\(?별\s*지\)?")
ANNEX_TITLE_MAX = 6


def _annex_mask(texts: list) -> list:
    """각 문단이 별지 구간 안에 있는지 표시한다.

    별지는 압류·청구의 '대상'을 특정하는 법정 문구가 들어가는 자리다. 사건
    사실을 서술하는 칸이 아니라, 목록·금액·행위를 적어 넣는 칸이다. 그런데
    자리표시자가 들어 있고 문장이 길어서 B단계가 예시 사연으로 오인한다.
    실제로 양육비 직접지급명령 신청서의 압류채권목록 별지

        양육비채무자(◇◇지점 근무)가 소득세원천징수의무자로부터 지급받는
        다음의 채권으로서 별지 청구채권목록 기재 금액에 이르기까지의 금액…

    이 "신청인은 현재 초등학교 4학년인 딸을 양육하고 있으며, 본인은 마트에서
    월 160만 원의 소득을 얻고 있습니다…"로 덮였다. ◇◇ 하나 때문에 예시로
    판정됐는데, 실은 채워 넣어야 할 지점명이 든 필수 기재사항이었다.
    압류채권목록은 압류 대상을 특정하는 별지라 이 문구가 사라지면 명령 자체가
    성립하지 않는다. 게다가 바뀐 문장이 읽기에는 그럴듯해서 상담원이 걸러내기도
    어렵다 — _find_example_paragraphs가 재서술 실패를 비워두는 것과 같은 이유로
    '남의 사연으로 덮이는' 쪽이 제일 위험하다.

    별지는 서식 맨 뒤에 붙어 그 뒤로는 안내표뿐이므로, 한 번 들어가면 섹션
    끝까지 구간으로 본다(291개 중 별지가 있는 7개를 전수 확인했다 —
    상속재산목록·청구채권목록·압류채권목록·동의서·후견 권한범위로, 전부
    서술란이 아니다). 원본을 남기면 자리표시자가 그대로라 C단계가 표시를
    붙여 상담원에게 넘긴다."""
    mask = [False] * len(texts)
    inside = False
    for i, t in enumerate(texts):
        compact = re.sub(r"\s+", "", t)
        if (compact and len(compact) <= ANNEX_TITLE_MAX
                and ANNEX_START_RE.match(compact)):
            inside = True
        mask[i] = inside
    return mask


def _find_example_paragraphs(doc) -> list:
    """예시 사연 '블록'을 통째로 식별.
    1) 서술체(길이 40자↑ + 종결어미) 문단의 끊김 없는 연속 구간을 블록 후보로 삼는다.
       짧은 문단(제목·안내문, <40자)을 만나면 블록이 끝난다.
    2) 블록에 자리표시자(○○ 등)가 하나라도 있으면 곧바로 예시 블록으로 확정한다.
    3) 자리표시자가 전혀 없는 블록은 GPT로 분류한다 — 서식에는 자리표시자 없이
       완결된 문장으로 인쇄된 가상 사연도 있다(예: 날짜·소득까지 다 채워진
       예시 인물 이야기). 앵커만으로는 이런 블록을 놓친다.
    보수적인 이유: 항상 짧은 문단 경계 안에서만 판단하므로 안내문·법조문을
    건드릴 일이 없고, 애매하면 분류기 자체가 '건드리지 않음'을 기본값으로 한다.
    반환: [(para객체, 실제텍스트), ...] 문서 순서대로."""
    found = []
    for sec in doc.sections:
        paras = list(sec.paragraphs)
        texts = []
        for p in paras:
            runs = getattr(p, "runs", [])
            texts.append("".join(getattr(r, "text", "") or "" for r in runs))
        # 청구취지 구간과 별지는 정형 문구다 — 재서술 대상에서 아예 뺀다.
        in_demand = _demand_clause_mask(texts)
        in_annex = _annex_mask(texts)
        is_narr = [_is_narrative(t) and not in_demand[i] and not in_annex[i]
                   for i, t in enumerate(texts)]
        is_blank = [not t.strip() for t in texts]
        has_ph = [is_narr[i] and bool(PLACEHOLDER_RE.search(texts[i]))
                  for i in range(len(paras))]

        i, n = 0, len(paras)
        while i < n:
            if not is_narr[i]:
                i += 1
                continue
            # 서술 문단 사이의 빈 문단(간격용)은 블록을 끊지 않고 건너뛴다.
            # 짧지만 내용 있는 문단(안내문·소제목)만 블록 경계로 취급한다.
            j, last_narr_end = i, i + 1
            while j < n and (is_narr[j] or is_blank[j]):
                if is_narr[j]:
                    last_narr_end = j + 1
                j += 1
            j = last_narr_end
            block_idx = [k for k in range(i, j) if is_narr[k]]
            block_texts = [texts[k] for k in block_idx]
            include = any(has_ph[k] for k in block_idx) or _classify_is_example(block_texts)
            if include:
                for k in block_idx:
                    # 법조문을 인용하는 문단은 블록이 예시로 판정돼도 건드리지
                    # 않는다. 재서술하면 근거 법조문이 통째로 사라진다
                    # (_cites_statute 주석 참고). 원본을 남기면 자리표시자가
                    # 그대로라 C단계 안전장치가 표시를 붙여준다.
                    if _cites_statute(texts[k]):
                        continue
                    found.append((paras[k], texts[k]))
            i = j
    return found


REWRITE_PROMPT = """너는 법률 서식의 사실 서술란을, 이번 사건의 상담 내용만으로
작성하는 도구다.

## 무엇을 쓰는가
서식의 특정 서술란(예: "혼인의 파탄" 경위)을, 아래에 주어진 '상담 요약'과
'추출정보'에 담긴 사실만으로 서술한다.

## 절대 원칙 — 근거 있는 서술만 (가장 중요)
1. 문장에 들어가는 모든 사실은 반드시 [상담 요약] 또는 [추출정보]에
   명시적으로 존재해야 한다. 거기 없는 것은 단 한 단어도 쓰지 않는다.
2. 특히 다음을 지어내지 마라 (상담에 없으면 절대 언급 금지):
   - 구체적 행위: 외박, 음주/술, 폭행, 가출, 협박, 고소, 외도 등
     (상담에 "폭언"만 있으면 "폭행"으로 바꾸지 마라. "도박"만 있으면
      "사채·빚·협박" 같은 파생 사실을 덧붙이지 마라.)
   - 구체적 시점·기간·횟수 ("자주", "여러 차례", "매일" 등도 근거 없으면 금지)
   - 직업·경제활동·거주지·제3자
   - 감정·정황 묘사 중 사실을 함의하는 것 ("공포에 떨며" 등)
3. 날짜·금액은 [추출정보]의 값만. 없으면 시점·액수를 언급하지 않는다.
4. 허용되는 것: 상담에 있는 사실을 법률 문체로 다듬고 자연스럽게 잇는 것.
   상담에 있는 사실로부터의 직접적 요약(예: "도박으로 경제적 어려움")은 가능.

## 문체·형식
- 법률 문서 문체("~하였습니다/~입니다"). 당사자는 [당사자 호칭]에 주어진 말로만
  지칭한다. 서식마다 부르는 말이 다르다(채권자/채무자, 청구인/상대방, 원고/피고,
  신청인/피신청인). 다른 말로 쓰면 같은 서식 안에서 당사자란과 서술란의 호칭이
  어긋나 누구를 가리키는지 알 수 없게 된다.
- 서술란은 여러 문단(가. 나. 다. ...)으로 나뉘어 있을 수 있고, 문단 개수가
  주어진다. 있는 사실을 그 개수에 맞춰 자연스럽게 배분한다.
  단, 사실이 적으면 억지로 문단을 채우지 말고 앞 문단들에만 쓰고
  나머지는 빈 문자열로 둔다. (없는 내용으로 칸을 메우지 마라)
- 마지막에 사실이 부족하면 "(구체적 경위는 상담을 통해 보완이 필요합니다.)"로
  한 번만 맺는다.

## 입력
- [서술란 성격]: 이 란이 무슨 내용을 적는 곳인지 (예: 혼인 파탄 경위)
- [당사자 호칭]: 이 서식이 당사자를 부르는 말 (서류를 내는 쪽 / 상대 쪽)
- [문단 개수]: 채워야 할 문단 수 N
- [상담 요약], [추출정보]: 쓸 수 있는 사실의 전부. 이 밖의 것은 없다.
  (원본 예시 문구는 제공하지 않는다. 참고할 남의 사연이 없으니 오직
   상담 사실로만 쓴다.)

## 출력 JSON (문단 N개, 순서대로. 못 채우는 문단은 "")
{"paragraphs": ["문단1", "문단2", ...]}"""


# 서식이 당사자를 부르는 말. 같은 가사사건이라도 서식마다 다르다 — 양육비
# 직접지급명령은 채권자/채무자, 이혼청구는 원고/피고, 심판청구는 청구인/상대방이다.
# 앞에 적은 것이 더 구체적이라 먼저 본다. '신청인'은 '피신청인'의 일부라
# 그대로 세면 상대방 쪽 등장 횟수까지 신청인으로 잡힌다.
APPLICANT_TERM_RES = (("채권자", re.compile(r"채권자")),
                      ("청구인", re.compile(r"청구인")),
                      ("원고", re.compile(r"원고")),
                      ("신청인", re.compile(r"(?<!피)신청인")))
OPPONENT_TERM_RES = (("채무자", re.compile(r"채무자")),
                     ("피신청인", re.compile(r"피신청인")),
                     ("상대방", re.compile(r"상대방")),
                     ("피고", re.compile(r"피고")))
DEFAULT_PARTY_TERMS = ("신청인", "상대방")


def _detect_party_terms(doc) -> tuple:
    """서식이 당사자를 부르는 말을 문서에서 읽는다.

    B단계 프롬프트는 원래 '신청인/피신청인'을 못박아 두고 있었다. 그래서 양육비
    직접지급명령 신청서(채권자/채무자)의 신청이유가 "신청인과 상대방은…"으로
    나갔다 — 바로 위 당사자란은 채권자·채무자인데 서술란만 다른 말을 쓴 것이라,
    읽는 사람이 누구를 가리키는지 알 수 없다.

    가장 많이 쓰인 말을 그 서식의 호칭으로 본다. 못 찾으면 종전 기본값을 쓴다."""
    lines = []
    for sec in doc.sections:
        for p in sec.paragraphs:
            lines.append("".join(getattr(r, "text", "") or "" for r in getattr(p, "runs", [])))
    compact = re.sub(r"\s+", "", " ".join(lines))

    def pick(candidates, fallback):
        best, best_n = fallback, 0
        for term, rx in candidates:
            n = len(rx.findall(compact))
            if n > best_n:
                best, best_n = term, n
        return best

    return (pick(APPLICANT_TERM_RES, DEFAULT_PARTY_TERMS[0]),
            pick(OPPONENT_TERM_RES, DEFAULT_PARTY_TERMS[1]))


def _infer_field_label(example_texts: list) -> str:
    """예시 문단들이 무슨 란인지 코드가 대략 라벨링 (GPT엔 성격만 전달)."""
    joined = " ".join(example_texts)
    if re.search(r"파탄|혼인|이혼", joined):
        return "혼인의 파탄 경위 (신청인·피신청인 사이 혼인이 파탄에 이른 사정)"
    if re.search(r"양육|미지급|양육비", joined):
        return "양육 및 양육비 관련 경위"
    if re.search(r"친권|양육자|복리", joined):
        return "친권 관련 사정"
    return "사건의 경위 서술"


# 문단 첫머리의 항번호("1.", "2)", "3 ."). B단계는 '무슨 란인지'와 우리 사실만
# 받아 새로 쓰기 때문에 원문에 붙어 있던 번호를 알지 못한다.
LIST_MARKER_RE = re.compile(r"^(\s*\d+\s*[.)]\s*)")


def _keep_list_number(original: str, rewritten: str) -> str:
    """재서술이 떨어뜨린 항번호를 원문에서 되살린다.

    신청이유가 "1. 사건 경위 / 2. 근거 법령 / 3. 신청 취지"처럼 번호로 이어지는
    서식에서, 재서술 대상은 사연이 담긴 1번뿐이다. 그래서 번호가 사라지면 본문이
    번호 없이 시작하고 다음이 2.로 이어져 1번이 통째로 빠진 것처럼 읽힌다
    (양육비 직접지급명령 신청서에서 실측).

    재서술문이 이미 번호로 시작하면 그대로 둔다 — 두 번 붙이지 않는다."""
    if not rewritten.strip():
        return rewritten
    marker = LIST_MARKER_RE.match(original)
    if not marker or LIST_MARKER_RE.match(rewritten):
        return rewritten
    return marker.group(1) + rewritten.lstrip()


def _rewrite_examples(example_texts: list, extracted: dict, summary: str,
                      party_terms: tuple = None) -> list:
    """원본 예시 문구는 GPT에 넘기지 않는다(베낌 방지).
    '무슨 란인지' + '당사자 호칭' + '문단 개수' + 우리 사실만 주고 서술하게 한다."""
    n = len(example_texts)
    label = _infer_field_label(example_texts)
    applicant, opponent = party_terms or DEFAULT_PARTY_TERMS
    user_msg = (f"[서술란 성격]\n{label}\n\n"
                f"[당사자 호칭]\n서류를 내는 쪽: {applicant} / 상대 쪽: {opponent}\n"
                f"이 두 말만 쓴다. 다른 호칭으로 바꿔 쓰지 않는다.\n\n"
                f"[문단 개수]\n{n}\n\n"
                f"[상담 요약]\n{summary}\n\n"
                f"[추출정보]\n{json.dumps(extracted, ensure_ascii=False, indent=2)}\n\n"
                f"위 사실만으로 문단 {n}개를 작성하라. 사실이 부족하면 뒤 문단은 \"\".")
    try:
        resp = _get_openai_client().chat.completions.create(
            model=MODEL,
            messages=[{"role": "system", "content": REWRITE_PROMPT},
                      {"role": "user", "content": user_msg}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        out = json.loads(resp.choices[0].message.content)
        paras = out.get("paragraphs", [])
    except Exception:
        # 응답이 깨지면 근거 없이 채우느니 전부 미기재 처리 — draft()가
        # "서술문단(근거부족·상담원작성)"으로 unfilled에 기록하고, 해당 문단은
        # 원본(남의 사연)을 지우고 상담원이 채울 자리로 바꾼다.
        paras = []
    if len(paras) < n:
        paras = paras + [""] * (n - len(paras))
    return paras[:n]


REVISE_PROMPT = """너는 방금 작성된 법률 서식 문단에서 근거 없는 사실을 골라내는
엄격한 검수자다. 작성 단계에서 "상담에 없는 사실은 쓰지 마라"는 지시가 있었지만,
실제로는 지켜지지 않는 경우가 있다 — 그걸 잡아내는 마지막 관문이 너다.

## 할 일
아래 [작성된 문단]에 있는 모든 구체적 사실(행위·사건·정황·시점·기간·횟수·
장소·직업·제3자·감정묘사 등)을 하나하나 [상담 요약]/[추출정보]와 대조하라.
근거가 없는 부분을 찾으면:
- 그 단어·구·절만 삭제하고 문장이 자연스럽게 이어지도록 다듬는다.
- 문단 전체를 지우지 않는다. 근거 있는 부분은 최대한 살린다.
- 삭제 후 문단이 빈약해져도 억지로 채우지 않는다. 짧으면 짧은 대로 둔다.

특히 아래 유형은 상담/추출정보에 명시적으로 없으면 반드시 삭제한다
(이 목록은 예시일 뿐, 없어도 근거 없는 구체적 사실은 모두 삭제 대상):
외박, 음주/술, 폭행, 협박, 가출, 고소, 외도, 유기, 제3자, 구체적 직업·근무지,
"자주"/"여러 차례"/"매번"처럼 근거 없는 빈도·정도 표현.

이미 근거가 충분한 문단은 그대로 둔다. 없는 사실을 새로 지어내 추가하지 않는다.
빈 문자열("")로 입력된 문단은 그대로 빈 문자열로 둔다.

## 출력 JSON (입력과 같은 개수, 같은 순서)
{"paragraphs": ["...", ...]}"""


def _selfcheck_and_revise(paragraphs: list, extracted: dict, summary: str) -> list:
    """2차 GPT 패스: 1차 작성 결과에서 근거 없는 구체적 사실(행위·정황 등)을
    제거한다. _verify_rewrite는 날짜·금액만 기계적으로 검증하므로,
    '외박했다'류의 서술형 할루시네이션은 이 단계에서만 걸러진다."""
    if not any(p.strip() for p in paragraphs):
        return paragraphs
    numbered = "\n".join(f"[{i}] {p}" for i, p in enumerate(paragraphs))
    user_msg = (f"[작성된 문단]\n{numbered}\n\n"
                f"[상담 요약]\n{summary}\n\n"
                f"[추출정보]\n{json.dumps(extracted, ensure_ascii=False, indent=2)}")
    try:
        resp = _get_openai_client().chat.completions.create(
            model=MODEL,
            messages=[{"role": "system", "content": REVISE_PROMPT},
                      {"role": "user", "content": user_msg}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        out = json.loads(resp.choices[0].message.content)
        revised = out.get("paragraphs", [])
    except Exception:
        return paragraphs  # 검수 호출 자체가 깨지면 1차 결과 유지 (팩트검증에서 재확인)
    if len(revised) != len(paragraphs):
        return paragraphs  # 형식이 깨지면 안전하게 1차 결과 유지 (팩트검증에서 재확인)
    return revised


# ── 팩트검증: 재서술에 근거 없는 날짜/금액 있으면 위반 ──
def _allowed_facts(extracted, summary):
    blob = summary + " " + json.dumps(extracted, ensure_ascii=False)
    years = set(re.findall(r"(?:19|20)\d\d", blob))
    money = set(re.findall(r"\d{5,}", blob.replace(",", "")))
    return years, money


def _verify_rewrite(text, years, money):
    v = []
    for y in re.findall(r"(?:19|20)\d\d", text):
        if y not in years:
            v.append(f"근거없는연도:{y}")
    for m in re.findall(r"\d{5,}", text.replace(",", "")):
        if m not in money:
            v.append(f"근거없는금액:{m}")
    if PLACEHOLDER_RE.search(text):
        v.append("자리표시자잔존")
    return v


# hwpx 문단 안의 글자 노드. run 안에 여러 개 있을 수 있다.
_HP_TEXT_TAG = "{http://www.hancom.co.kr/hwpml/2011/paragraph}t"


def _purge_run_text(run) -> None:
    """run에 남아 있는 글자를 모두 지운다. 탭 같은 자식 요소는 남긴다.

    python-hwpx의 run.text 세터는 '자식 요소가 없는 <hp:t>'에만 글을 쓴다
    (_plain_text_nodes). 그런데 서식은 칸을 맞추려고 글자 사이에 <hp:tab/>을
    넣고, 그러면 그 <hp:t>는 자식이 있는 노드가 된다 — 세터는 거기에 못 쓰고
    새 <hp:t>를 뒤에 만들어 붙인다. 원래 글자는 <hp:tab/>의 tail에 그대로
    남아 지워지지 않는다(세터가 지우는 건 node.text뿐이다).

    그래서 상속재산포기 심판청구서의 서명란이

        원본   청 구 인 <탭>1. ○  ○  ○   (인감도장)
        결과   청 구 인 1. ○  ○  ○   (인감도장)      ← 원본이 안 지워짐
               청 구 인 1. ○  ○  ○   (인감도장)      ← C단계가 다시 읽어 되쓴 것
               청 구 인 1. 문가영   (인감도장)         ← 실제로 채운 값

    처럼 한 줄에 세 번 찍혔다. 남은 ○ ○ ○ 때문에 C단계가 [예시:확인필요]까지
    붙이면서 두 번이 세 번이 됐다. 291개 서식 중 178개가 이런 <hp:t>를 갖고
    있어, 글자를 새로 써넣는 줄이면 어디서든 같은 일이 난다.

    탭 요소 자체는 지우지 않는다 — 지우면 서식의 들여쓰기가 무너진다."""
    element = getattr(run, "element", None)
    if element is None:
        return
    for node in element.findall(_HP_TEXT_TAG):
        node.text = ""
        for child in node:
            child.tail = ""


def _set_paragraph_text(p, text: str):
    """문단 객체의 첫 run에 text, 나머지 run 비움."""
    runs = getattr(p, "runs", [])
    if not runs:
        return False
    # 세터에 맡기면 탭 뒤에 숨은 원본 글자가 안 지워진다 — 먼저 비우고 쓴다.
    for r in runs:
        _purge_run_text(r)
    runs[0].text = text
    return True


# 표 안전장치(TABLE_EXAMPLE_TAG)와 같은 이유로 짧은 태그를 쓴다 — 원래
# 긴 태그("[서식 예시—실제 값으로 교체 필요] ")를 앞에 붙이면 "국 적    중화민국"
# 같이 라벨-값 사이 간격을 맞춰둔 줄의 정렬이 밀려서 서식이 이상해 보였다.
# 그래서 (1) 짧은 태그로 바꾸고 (2) 앞이 아니라 뒤에 붙여서 원래 간격을
# 그대로 보존한다.
PARA_EXAMPLE_TAG = " [예시:확인필요]"


def _tag_paragraph(runs) -> None:
    # 읽은 글자를 그대로 되쓰는 자리라, 탭 뒤에 숨은 글자가 안 지워지면 줄이
    # 통째로 한 번 더 찍힌다(_purge_run_text 주석 참고).
    tagged = (runs[-1].text or "") + PARA_EXAMPLE_TAG
    _purge_run_text(runs[-1])
    runs[-1].text = tagged


# 재서술이 불가능한 서술문단 자리에 남기는 문구. 원본(남의 사연)을 그대로 두는
# 대신 이걸 넣는다. 태그를 포함하고 있어 C단계 안전장치가 중복으로 다시 잡지
# 않는다(_mark_unresolved_examples가 태그 있는 문단을 건너뛴다).
NARRATIVE_UNFILLED_TEXT = ("(상담 내용에 근거가 없어 비워둔 자리입니다. "
                           "상담원이 직접 작성해 주세요.)" + PARA_EXAMPLE_TAG)

# 예시 문단 사이의 '낀 줄'을 몇 줄까지 원본 사연의 일부로 볼지. 1~2줄이면
# 증거 인용·부연처럼 앞뒤 서술에 딸린 줄이지만, 그보다 길게 벌어지면 그 사이는
# 안내문·소제목 같은 다른 성격의 구간일 가능성이 높아 건드리지 않는다.
_INTERSTITIAL_MAX_GAP = 2


def _tag_interstitial_examples(doc, example_texts: set) -> int:
    """예시 문단과 예시 문단 사이에 낀 짧은 줄에 표시를 붙인다.

    _find_example_paragraphs는 서술체(40자↑ + 종결어미) 문단만 예시로 잡는다.
    그래서 "｛갑 제1 호증의 1,2 (각 혼인관계증명서) 참조｝"처럼 종결어미가 없는
    줄은 예시 블록 한가운데 있어도 후보에서 빠지고, 자리표시자도 없어
    _mark_unresolved_examples의 정규식에도 안 걸린다. 결과적으로 우리 사건
    문단 사이에 원본 사연의 증거 인용만 덩그러니 남는다.

    문단 객체 id()는 hwpx 라이브러리가 접근마다 새 래퍼를 만들어 재사용할 수
    없으므로(_mark_unresolved_examples와 같은 이유) 텍스트 값으로 판별한다."""
    if not example_texts:
        return 0

    marked = 0
    for sec in doc.sections:
        paras = list(sec.paragraphs)
        texts = ["".join(getattr(r, "text", "") or "" for r in getattr(p, "runs", []))
                 for p in paras]
        idx = [i for i, t in enumerate(texts) if t in example_texts]
        if len(idx) < 2:
            continue
        for a, b in zip(idx, idx[1:]):
            gap = [k for k in range(a + 1, b) if texts[k].strip()]
            if not gap or len(gap) > _INTERSTITIAL_MAX_GAP:
                continue
            for k in gap:
                if PARA_EXAMPLE_TAG.strip() in texts[k]:
                    continue
                runs = getattr(paras[k], "runs", [])
                if runs:
                    _tag_paragraph(runs)
                    marked += 1
    return marked


# 이 프로젝트가 다루는 서식은 절대다수 내국인 사건이라 "국적: 중화민국"처럼
# 이미 구체적인 값이 인쇄된 짧은 한 줄짜리 항목도 있다 — 자리표시자가 아니라서
# 정규식엔 안 걸리고, 40자 미만이라 서술문단 탐지에도 안 걸린다. 특정 값으로
# 추측해 채우지 않고(예: "국적 없으면 대한민국으로 채우기") 표 안전장치와 같은
# 원칙으로 "예시일 가능성"만 GPT로 판단해 표시만 한다.
SHORT_FIELD_CLASSIFY_PROMPT = """너는 법률 서식의 짧은 한 줄짜리 항목(라벨+값 형태)에서,
서식 제작자가 미리 인쇄해둔 가상의 예시 값(자리표시자가 아니라 이미 구체적인 값처럼
보이는 것 — 예: "국적    중화민국", "직업    회사원")이 남아있는지, 아니면 정상
안내문·항목명·라벨 그 자체인지 판단하는 분류기다.

핵심 신호: 라벨 뒤에 구체적이고 특정적인 값(나라 이름, 직업명 등)이 이미 채워져
있는데 [추출정보]/[사건 요약]에는 그 항목에 대한 언급이 전혀 없다면, 서식
제작자가 견본으로 인쇄해둔 예시 값일 가능성이 높다.

반대로 "청  구  인", "신청취지" 같은 항목명 자체나, 법조문·관할 안내 같은 정형
문구는 예시가 아니다. 애매하면 false.

## 출력 JSON (입력 개수·순서와 같은 배열)
{"is_example": [true/false, ...]}"""


def _classify_short_fields_batch(texts: list, extracted: dict, summary: str) -> list:
    if not texts:
        return []
    numbered = "\n".join(f"[{i}] {t}" for i, t in enumerate(texts))
    user_msg = (f"[줄 목록]\n{numbered}\n\n"
                f"[사건 요약]\n{summary}\n\n"
                f"[추출정보]\n{json.dumps(extracted, ensure_ascii=False, indent=2)}")
    try:
        resp = _get_openai_client().chat.completions.create(
            model=MODEL,
            messages=[{"role": "system", "content": SHORT_FIELD_CLASSIFY_PROMPT},
                      {"role": "user", "content": user_msg}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        out = json.loads(resp.choices[0].message.content)
        flags = out.get("is_example", [])
    except Exception:
        return [False] * len(texts)
    if len(flags) != len(texts):
        return [False] * len(texts)
    return [bool(f) for f in flags]


def _mark_unresolved_examples(doc, rewritten_texts: set, extracted: dict, summary: str) -> int:
    """A·B 단계 처리 후에도 남아있는 원본 예시를 표시한다. 세 가지 신호를 쓴다:

    1) 자리표시자가 남은 문단 — 길이 상관없이 즉시 표시. 계산식처럼 서술체가
       아니라 B단계 탐지를 못 통과하는 원본 예시(유류분 계산 내역 등)나,
       "생년월일    195○. ○. ○"처럼 짧은 한 줄짜리 잔존 자리표시자에 대응.
    2) 자리표시자가 아예 없이 '이미 다 채워진 것처럼' 완결된 긴 문단(40자↑)인데
       우리가 방금 재서술해 넣은 문단이 아닌 것 — "청구인은 중화민국 국적의
       화교인 상대방과..." 같은, 서식 자체에 인쇄된 남의 사연. GPT 분류기
       (_classify_is_example)로 "우리 사건과 무관한 예시 사연처럼 보이는가"를
       판단시킨다.
    3) 40자 미만의 짧은 "라벨+값" 한 줄짜리 항목(예: "국적    중화민국") —
       자리표시자도 없고 서술문단 취급도 안 돼서 1)·2) 둘 다 놓치는 사각지대.
       표 안전장치(_classify_table_rows_batch)와 같은 원칙으로 GPT 배치 분류.

    rewritten_texts: draft()가 방금 _set_paragraph_text로 써넣은 문단 텍스트
    집합 — 이건 재분류 대상에서 제외한다. (주의: 문단 객체의 id()는 hwpx
    라이브러리가 .paragraphs 접근마다 새 래퍼를 만들어 재사용 불가하므로,
    텍스트 값 자체로 판별한다.)

    2)·3)번 판정은 문단마다 개별 호출하면 문단이 많은 서식에서 GPT 호출이
    과도하게 쌓여 느려지므로, 후보를 모았다가 문서당 한 번에 배치 분류한다."""
    marked = 0
    llm_candidates = []  # [(runs, text), ...] — 긴 서술문단 배치 분류 대상
    short_candidates = []  # [(runs, text), ...] — 짧은 라벨+값 한 줄 배치 분류 대상

    for sec in doc.sections:
        for p in sec.paragraphs:
            runs = getattr(p, "runs", [])
            if not runs:
                continue
            text = "".join(getattr(r, "text", "") or "" for r in runs)
            if not text.strip() or PARA_EXAMPLE_TAG.strip() in text:
                continue
            if PLACEHOLDER_RE.search(text):
                _tag_paragraph(runs)
                marked += 1
                continue
            if text in rewritten_texts:
                continue
            if len(text) >= 40:
                llm_candidates.append((runs, text))
            elif len(text) >= 4 and re.search(r"\s{2,}|\S\s*[:：]\s*\S", text):
                # 라벨과 값을 가르는 방식이 서식마다 둘로 갈린다.
                #   (1) 칸 맞춤 공백 — "국 적    중화민국"
                #   (2) 콜론        — "유언자와의 관계 : 배우자"
                # 예전에는 (1)만 봐서, 유언증서 검인신청서의 "유언자와의 관계 :
                # 배우자"가 그물을 통째로 빠져나갔다(14자라 서술문단도 아니고
                # 연속공백도 없음). 실제 사건은 아들이 신청한 건인데 원본 예시값
                # "배우자"가 표시조차 없이 남았다.
                #
                # 2칸 이상 공백은 이 서식들이 라벨과 값을 시각적으로 정렬할 때
                # 쓰는 방식(예: "국 적    중화민국") — 순수 안내문·소제목과
                # 구분하는 최소 신호로 쓴다. 다만 이것만으로는 "청 구 인"
                # 같은 순수 라벨이나 "1. 갑 제1호증   혼인관계증명서" 같은
                # 정상 첨부서류 목록까지 다 걸려서 후보가 희석된다(표에서
                # 겪었던 것과 같은 문제 — 실측: 19개 후보 중 진짜 예시 2개가
                # 있었는데 GPT가 전부 false로 답함). 그래서 미리 걸러낸다:
                # (a) 번호 매긴 목록("1. ...")은 항상 정형 문구이므로 제외
                # (b) 이미 우리가 채워넣은 "미상" 표기가 있으면 예시가 아니라
                #     우리 시스템이 넣은 값이므로 제외
                # (c) 공백을 다 빼고 남는 글자가 6자 미만이면 라벨 그 자체일
                #     뿐 값이 없는 것으로 보고 제외("청구인"=3자, "첨부서류"=4자)
                compact = re.sub(r"\s+", "", text)
                if (not re.match(r"\s*\d+\.\s", text)
                        and "미상" not in text
                        and len(compact) >= 6):
                    short_candidates.append((runs, text))

    if llm_candidates:
        flags = _classify_examples_batch([t for (_, t) in llm_candidates])
        for (runs, _text), is_example in zip(llm_candidates, flags):
            if is_example:
                _tag_paragraph(runs)
                marked += 1

    if short_candidates:
        flags = _classify_short_fields_batch(
            [t for (_, t) in short_candidates], extracted, summary)
        for (runs, _text), is_example in zip(short_candidates, flags):
            if is_example:
                _tag_paragraph(runs)
                marked += 1

    return marked


# ══════════════════════════════════════
# 정형 치환 적용 (계단식)
# ══════════════════════════════════════
def _replace_first_in_runs(doc, target, value):
    for sec in doc.sections:
        for p in sec.paragraphs:
            for run in getattr(p, "runs", []):
                t = getattr(run, "text", None)
                if t and target in t:
                    # 라이브러리의 replace_text는 탭 같은 자식 요소를 넘나들며
                    # 제자리 치환을 한다 — run.text 세터와 달리 탭 뒤에 숨은
                    # 글자도 지운다(_purge_run_text 주석 참고). 탭 위치도 그대로
                    # 남아 서식의 칸 맞춤이 안 밀린다.
                    try:
                        if run.replace_text(target, value, count=1):
                            return 1
                    except Exception:
                        pass
                    # 치환기가 못 잡으면 줄 전체를 다시 쓴다(탭은 앞으로 밀린다).
                    _purge_run_text(run)
                    run.text = t.replace(target, value, 1)
                    return 1
    return 0


def _apply_fields(doc, replacements):
    applied, missed = 0, []
    for r in replacements:
        before, after = r.get("before", ""), r.get("after", "")
        if not before or not after:
            continue
        try:
            n = doc.replace_text_in_runs(before, after)
        except Exception:
            n = 0
        if n and n > 0:
            applied += n
            continue
        done = False
        for v in {before.replace("   ", " "), before.replace("  ", " "),
                  re.sub(r"\s+", " ", before)}:
            if v == before:
                continue
            try:
                n = doc.replace_text_in_runs(v, after)
            except Exception:
                n = 0
            if n and n > 0:
                applied += n
                done = True
                break
        if done:
            continue
        # run 쪼개짐: 공통 접두·접미 벗겨 핵심만 first-only
        i = 0
        while i < min(len(before), len(after)) and before[i] == after[i]:
            i += 1
        j = 0
        while (j < min(len(before), len(after)) - i
               and before[len(before)-1-j] == after[len(after)-1-j]):
            j += 1
        core_b = before[i:len(before)-j] if j else before[i:]
        core_a = after[i:len(after)-j] if j else after[i:]
        if core_b.strip():
            n = _replace_first_in_runs(doc, core_b, core_a)
            if n:
                applied += n
                continue
        missed.append(before[:40])
    return applied, missed


# ══════════════════════════════════════
# 서식 찾기
# ══════════════════════════════════════
def _norm_name(s):
    s = re.sub(r"\s+", "", s)
    for ch in "·,()[]_-":
        s = s.replace(ch, "")
    return s.lower()


def find_hwpx(form_name):
    key = _norm_name(form_name)
    files = list(HWPX_ROOT.rglob("*.hwpx"))
    for f in files:
        if _norm_name(f.stem) == key:
            return f
    for f in files:
        if key in _norm_name(f.stem) or _norm_name(f.stem) in key:
            return f
    return None


def _extract_markdown(doc):
    try:
        return doc.export_rich_markdown()
    except Exception:
        return "\n".join(p.text or "" for sec in doc.sections for p in sec.paragraphs)


# ══════════════════════════════════════
# A-2. 역할 기반 이름 채우기 (GPT 판단을 코드로 보정)
# ══════════════════════════════════════
# A단계는 "어느 칸에 무엇을 쓸지"를 GPT에게 통째로 맡긴다. 그래서 같은 서식·같은
# 사건인데도 실행마다 결과가 달라진다. 실제로 유언증서 검인신청서에서 이런 일이 났다:
#
#   1회차   유 언 자 □□□ → "아버지"      (관계어를 이름 자리에)
#   2회차   유 언 자 □□□ → "남기준"      (형을 유언자로 — 유언자는 사망한 부친)
#   두 회차 모두  위 신청인 ○ ○ ○ → 안 채움 (신청인 이름을 알고 있는데도)
#
# 프롬프트에도 규칙 4·5로 같은 내용이 적혀 있지만 부탁이라 지켜지지 않는다.
# 확정된 사실(누가 신청인인가)은 코드가 처리하고, GPT에게는 판단이 필요한 자리만
# 남긴다.

# 이름 자리표시자. 서식마다 두 가지로 쓴다:
#   띄어쓰기형  "위 청구인  ○  ○  ○ (인)"
#   붙임형      "위 신청인 ○○○  (인)"
# 처음에는 띄어쓰기형만 잡았는데, 과태료부과신청서가 붙임형이라 서명란이
# 그대로 비었다. 둘 다 잡되 2~3자까지만 본다 — 전화번호("○○○○")는 4자다.
NAME_PLACEHOLDER_RE = re.compile(
    r"[○□◎◇◉●△▽](?:\s+[○□◎◇◉●△▽]){1,2}"      # ○ ○ ○
    r"|(?<![○□◎◇◉●△▽\d])[○□◎◇◉●△▽]{2,3}(?![○□◎◇◉●△▽])"  # ○○○
)

# 이름칸으로 오인하면 안 되는 줄. 주소·전화·날짜 칸도 같은 자리표시자를 쓰기
# 때문에("등록기준지 ○○시 ○○구", "생년월일 19○○년"), 라벨로 먼저 걸러낸다.
NON_NAME_LINE_RE = re.compile(
    r"주\s*소|등록기준지|전\s*화|휴대폰|팩스|우편|번호|생년월일|년\s*월\s*일|e-mail"
    # 작성일자 줄("20○○.  ○.  ○○.")도 이름칸처럼 생겼다. 연도 형태로 걸러낸다.
    r"|(?:19|20)[○\d]"
)

# 서식마다 당사자를 부르는 말이 다르다. 같은 역할이면 같은 이름이 들어가야 한다.
ROLE_LABELS = {
    "청구인": ("청구인", "신청인", "원고"),
    "상대방": ("상대방", "피신청인", "피고"),
    "사건본인": ("사건본인",),
}


def _inserted_name(before: str, after: str) -> str:
    """치환 전후를 비교해 '새로 들어간 이름'만 뽑는다.

    before "신 청 인  ○  ○  ○" / after "신 청 인  남기훈" → "남기훈".
    라벨은 양쪽에 다 있으므로 공통 접두를 걷어내면 이름만 남는다."""
    i = 0
    while i < min(len(before), len(after)) and before[i] == after[i]:
        i += 1
    j = 0
    while (j < min(len(before), len(after)) - i
           and before[len(before) - 1 - j] == after[len(after) - 1 - j]):
        j += 1
    return after[i:len(after) - j].strip() if j else after[i:].strip()


# 사람을 잘못 넣으면 문서의 의미가 뒤집히는 자리의 라벨. 이 라벨이 붙은
# 칸에서만 '역할불명' 치환을 버린다.
CONTESTED_ROLE_LABEL_RE = re.compile(
    r"청\s*구\s*인|신\s*청\s*인|원\s*고"
    r"|상\s*대\s*방|피\s*신\s*청\s*인|피\s*고"
    r"|사\s*건\s*본\s*인|유\s*언\s*자|피\s*상\s*속\s*인"
)


def _drop_unidentified_name_fills(replacements: list, extracted: dict = None) -> tuple:
    """역할을 특정하지 못한 채(role='기타') 이름 자리를 채우는 치환을 버린다.

    GPT는 역할을 모를 때 role='기타'를 붙이는데, 그 상태로 이름을 넣으면
    엉뚱한 사람이 법적 서류에 올라간다(형을 유언자로 넣은 사례). 역할을
    모르면 채우지 않는 게 맞다 — 빈칸은 상담원이 채우면 되지만, 잘못 채워진
    이름은 그럴듯해서 걸러지지 않는다.

    다만 '기타'를 그 자체로 위험 신호로 보면 안 된다. 상속재산분할협의서처럼
    다투는 상대가 없는 서식은 청구인도 상대방도 없어서 '기타'가 오히려 정답인데,
    예전에는 이걸 전부 버려서 공동상속인 네 명의 이름이 한 칸도 안 들어갔다.
    그래서 버리는 기준을 role이 아니라 '그 칸의 라벨'로 잡는다 — 청구인·상대방·
    유언자처럼 사람이 뒤바뀌면 문서 의미가 뒤집히는 자리에서만 버리고,
    공동상속인·성명처럼 나란한 자리는 남긴다.

    role은 GPT가 붙이는 값이라 자주 '기타'로 흘러내린다. 그것 하나만 보고 버리면
    분석이 역할까지 확실히 아는 이름도 같이 버려진다 — 재감사에서 버려진 3건이
    전부 그랬다(추출정보에 "역할: 피상속인, 이름: 남정호"가 있는데도 유언자 칸이
    한 곳도 안 채워졌다). 근거가 분석에 있으면 GPT의 role이 무엇이든 신뢰한다.
    이 필터가 막으려는 건 '근거 없는 이름'이지 '라벨이 흐린 이름'이 아니다.

    반환: (남길 치환 목록, 버린 자리 설명 목록)"""
    deceased = _known_names_by_role(extracted or {}, DECEASED_KEY_RE)
    living = _known_names_by_role(extracted or {}, LIVING_KEY_RE)
    opponent = _known_names_by_role(extracted or {}, OPPONENT_KEY_RE)

    kept, dropped = [], []
    for r in replacements:
        before, after = r.get("before", ""), r.get("after", "")
        role = (r.get("role") or "").strip()
        if (role in ("", "기타")
                and before and after
                and CONTESTED_ROLE_LABEL_RE.search(before)
                and NAME_PLACEHOLDER_RE.search(before)
                and not NAME_PLACEHOLDER_RE.search(after)):
            # 그 칸이 어떤 역할의 자리인지 라벨로 보고, 들어간 이름이 분석에서
            # 그 역할로 확인된 사람이면 남긴다. 라벨과 다른 쪽 이름이 들어갔다면
            # 그건 이 필터가 원래 막으려던 사람 뒤바뀜이므로 그대로 버린다.
            name = _inserted_name(before, after)
            grounded = (deceased if DECEASED_LABEL_RE.search(before)
                        else living if LIVING_LABEL_RE.search(before)
                        else opponent)
            if name and name in grounded:
                kept.append(r)
                continue
            dropped.append(f"이름칸(역할불명·상담원확인): {before[:30]}")
            continue
        kept.append(r)
    return kept, dropped


def _drop_non_name_person_fills(replacements: list) -> tuple:
    """이름칸을 이름이 아닌 지칭어로 채우는 치환을 버린다.

    분석은 이름을 못 들었을 때 이름 자리에 "첫째, 둘째"처럼 관계를 적어 넣는데,
    서식에 그대로 들어가면 "청구인(상속인) 2. 첫째, 둘째(주민등록번호)"가 된다.
    사람 이름처럼 찍히지만 실제로는 아무도 특정하지 못한 상태다.

    비워두면 C단계가 '확인필요' 표시를 붙이고 상담원이 채운다 — 그게 맞는 처리다.

    반환: (남길 치환 목록, 버린 자리 설명 목록)"""
    kept, dropped = [], []
    for r in replacements:
        before, after = r.get("before", ""), r.get("after", "")
        # 이름칸이었던 자리만 본다. 주소·날짜칸은 이 검사 대상이 아니다.
        if not (before and NAME_PLACEHOLDER_RE.search(before)
                and not NAME_PLACEHOLDER_RE.search(after)):
            kept.append(r)
            continue
        name = _inserted_name(before, after)
        # 한 줄에서 이름과 날짜를 한꺼번에 바꾸는 치환도 있다("망 △△△의 …로서 20○○. ○. ○."
        # → "망 백승현의 …로서 2024. 6. 18."). 그때 _inserted_name은 가운데 덩어리를 통째로
        # 돌려주므로 이름으로 판정하면 안 된다 — 실제로 맞게 채운 것을 버렸다.
        # 이름 길이 범위일 때만 이름으로 보고 판단한다.
        if name and 2 <= len(name) <= 10 and not _is_person_name(name):
            dropped.append(f"이름칸(이름 아님·상담원확인): {before[:30]} ← '{name[:20]}'")
            continue
        kept.append(r)
    return kept, dropped


def _drop_unfounded_value_fills(replacements: list, extracted: dict,
                                summary: str) -> tuple:
    """상담에 없는 연도·금액을 채워 넣는 치환을 버린다.

    B단계 재서술에는 _verify_rewrite로 같은 검사를 이미 걸어두었는데, A단계
    정형 치환에는 안 걸려 있었다. 그 틈으로 양육비 심판청구서의
    "20○○. ○. ○.부터 20○○. ○. ○. 까지"가 상담에 날짜가 한 줄도 없는데도
    "2026. 01. 01.부터 2026. 12. 31. 까지"로 채워졌다. 지어낸 날짜가 위험한
    건 틀려서만이 아니다 — 자리표시자가 사라지는 바람에 C단계 표시까지 빠져서
    상담원 눈에는 확정된 값처럼 보인다.

    before에 이미 있던 숫자(서식 제작자의 예시 금액 등)는 우리가 넣은 게
    아니므로 통과시킨다. 새로 등장한 숫자만 본다.

    반환: (남길 치환 목록, 버린 자리 설명 목록)"""
    years, money = _allowed_facts(extracted, summary)
    kept, dropped = [], []
    for r in replacements:
        before, after = r.get("before", "") or "", r.get("after", "") or ""
        bad = []
        for y in set(re.findall(r"(?:19|20)\d\d", after)):
            if y not in years and y not in before:
                bad.append(y)
        for m in set(re.findall(r"\d{5,}", after.replace(",", ""))):
            if m not in money and m not in before.replace(",", ""):
                bad.append(m)
        if bad:
            dropped.append(f"근거없는 값이라 비워둠({'/'.join(bad)}): {before[:30]}")
            continue
        kept.append(r)
    return kept, dropped


def _drop_append_only_fills(replacements: list) -> list:
    """'바꾸기'가 아니라 '덧붙이기'인 치환을 버린다.

    GPT는 같은 줄에 대해 제대로 된 치환과 라벨만 잡은 치환을 함께 내놓을 때가
    있다:

        {"before": "신 청 인  ○  ○  ○", "after": "신 청 인  남기훈"}   ← 정상
        {"before": "신 청 인",           "after": "신 청 인 남기훈"}   ← 덧붙이기

    둘 다 적용되면 "신 청 인 남기훈  남기훈"이 된다. 뒤엣것은 before가 after에
    통째로 들어있는(자리표시자를 지운 게 아니라 뒤에 이어 붙인) 모양이라
    글자만 봐도 가려낼 수 있다.

    라벨 뒤 예시값을 바꾸는 정상 치환("유언자와의 관계 : 배우자" → "… : 아들")은
    before가 after 안에 그대로 남지 않으므로 여기 걸리지 않는다."""
    kept = []
    for r in replacements:
        before = (r.get("before") or "").strip()
        after = (r.get("after") or "").strip()
        if before and after != before and before in after:
            continue
        kept.append(r)
    return kept


# 이름칸 앞에 붙는 '사람 라벨'. 서술문단 이름채움은 이 라벨 뒤에서만 동작한다.
# "망" 한 글자는 넣지 않는다 — 너무 흔해서 엉뚱한 자리까지 걸린다.
PERSON_LABELS = {
    "유언자", "피상속인", "망인", "사망자", "피성년후견인", "피한정후견인",
    "신청인", "청구인", "원고", "상대방", "피신청인", "피고", "사건본인",
    "피상속인망", "유언자망",
}

# 사망한 사람을 가리키는 라벨과, 서류를 내는 산 사람을 가리키는 라벨.
# "망 백승현"처럼 '망' 한 글자로 사망을 표시하는 자리도 사망자 칸이다. 이걸 빼면
# 청구취지("청구인들의 망 ○○○에 대한 재산상속포기 신고는 이를 수리한다")가 청구인 칸으로
# 분류되어, 거기 들어간 사망자 이름이 '청구인 이름'으로 등록된다. 그러면 _drop_self_
# contradicting_fills가 진짜 사망자 칸 치환을 전부 모순으로 보고 버린다 — 실측된 사고다
# (상속재산포기 심판청구서에서 백승현이 사건본인·피상속인 칸에 한 번도 안 들어갔다).
# '희망'·'사망'처럼 다른 낱말에 섞인 망은 앞 글자가 한글이라 걸리지 않게 한다.
DECEASED_LABEL_RE = re.compile(
    r"유\s*언\s*자|피\s*상\s*속\s*인|망\s*인|사\s*망\s*자"
    r"|(?<![가-힣])망\s*(?=[가-힣○□◎◇◉●△▽])")
LIVING_LABEL_RE = re.compile(r"청\s*구\s*인|신\s*청\s*인|원\s*고")

# "유언자와의 관계 : 배우자"처럼 사람 이름이 아니라 지칭어가 들어가는 칸.
# 이름칸 필터가 여기까지 오면 안 된다.
RELATION_SLOT_RE = re.compile(r"관\s*계\s*[)）]?\s*[:：]")


def _drop_self_contradicting_fills(replacements: list, living_extra=()) -> tuple:
    """서류를 내는 사람을 사망자 자리에 넣는 치환을 버린다.

    실측된 사고 두 건이 모두 이 모양이었다:
      · 상속한정승인 — 청구인 이도영이 "피상속인 망 이도영"으로 들어갔다.
        자기 상속을 자기가 한정승인하는 문서가 만들어진다.
      · 유언증서 검인 — 유언에 반대하는 형(남기준)이 유언자 자리에 들어갔다.

    사람 이름은 그럴듯해서 상담원 눈으로 걸러지지 않는다. 반면 '청구인과
    피상속인이 같은 사람'은 글자만 봐도 모순이라 코드가 확실히 잡을 수 있다.
    모순이면 사망자 쪽을 비운다 — 청구인은 상담에서 확실히 아는 값이지만
    사망자 이름은 상담에 없는 경우가 많아 지어냈을 가능성이 훨씬 높다.

    반환: (남길 치환 목록, 버린 자리 설명 목록)"""
    # 산 사람 이름을 치환 목록에서만 모으면 필터가 통째로 꺼지는 구멍이 있다.
    # 청구인 이름이 상담기록(applicant_name)이나 추출정보에서 와서 GPT 치환에는
    # 없을 수 있는데, 그러면 living이 비어 그대로 반환된다 — 실측에서 GPT가
    # "청구인들의 망 문가영에 대한 재산상속포기"를 만들었는데 걸러지지 않았다.
    # 확정된 이름을 함께 넣어야 LLM이 흔들려도 같은 사고가 막힌다.
    living = _living_names(replacements) | {n for n in (living_extra or ()) if n}
    if not living:
        return replacements, []

    # 문단 전체에 청구인 라벨이 같이 있는지로 판단하면 안 된다. 청구취지는
    # "청구인들이 피상속인 망 ○○○의 재산상속을 함에 있어…"처럼 한 문장에 둘 다
    # 나오고, 그러면 검사가 통째로 무력화된다(실제로 "피상속인 망 이도영"이
    # 그렇게 빠져나갔다). 라벨 바로 뒤에 오는 이름만 본다.
    # 두 패턴을 이어붙일 때 (?:...)로 묶어야 한다. DECEASED_LABEL_RE는 괄호 없는
    # 선택지(A|B|C)라서 그냥 붙이면 "A 또는 B 또는 C뒤에이름"이 돼, 사망자 라벨만
    # 있으면 이름과 무관하게 걸린다 — 맞게 채운 "피상속인 망 이재호"까지 버려졌다.
    contradiction = re.compile(
        r"(?:" + DECEASED_LABEL_RE.pattern + r").{0,6}?"
        r"(?:" + "|".join(map(re.escape, living)) + r")")

    kept, dropped = [], []
    for r in replacements:
        after = r.get("after") or ""
        m = contradiction.search(after)
        if m:
            dropped.append("사망자 자리에 청구인 이름이 들어가 비워둠"
                           f"({m.group(0)[:20]}): {(r.get('before') or '')[:26]}")
            continue
        kept.append(r)
    return kept, dropped


def _living_names(replacements: list) -> set:
    """서류를 내는 산 사람(청구인·신청인·원고)의 이름."""
    living = set()
    for r in replacements:
        before = r.get("before") or ""
        if LIVING_LABEL_RE.search(before) and not DECEASED_LABEL_RE.search(before):
            name = _inserted_name(before, r.get("after") or "")
            if name and 2 <= len(name) <= 10:
                living.add(name)
    return living


DECEASED_KEY_RE = re.compile(r"피상속인|유언자|망인|사망자|피성년후견인|피한정후견인")
LIVING_KEY_RE = re.compile(r"청구인|신청인|원고|내담자")
OPPONENT_KEY_RE = re.compile(r"상대방|피신청인|피고")

# 이름이 아니라 '확인 못 했다'는 표시. 이걸 이름으로 쓰면 서식에 "미상"이 찍힌다.
UNKNOWN_NAME_MARKS = ("미상", "불명", "확인불가", "확인 불가", "알 수 없음", "없음",
                      # 프론트가 빈 값 자리에 넣는 화면 표시 문구. 상담 등록 때
                      # clientName으로 저장돼 서식까지 넘어온다.
                      "미입력")

# 이름을 모를 때 분석 층이 이름 자리에 대신 적어 넣는 지칭어들. 이름이 아니므로
# 서식에 그대로 들어가면 안 된다 — 실측에서 상속재산포기 심판청구서의 청구인 2번 칸이
# "첫째, 둘째(주민등록번호)"로 나갔다. 분석은 자녀 이름을 못 들었을 뿐인데, 서식에는
# 그게 사람 이름처럼 찍힌다. 모르면 비워두고 누락자료로 남기는 게 맞다.
NON_NAME_PERSON_RE = re.compile(
    r"첫\s*째|둘\s*째|셋\s*째|넷\s*째|막내|장남|차남|장녀|차녀"
    r"|미성년|자녀|아이들?|본인|배우자|공동상속인|상속인들|형제|자매|남매"
    r"|모름|해당\s*없음|추후|확인\s*필요|예시")


def _is_person_name(value: str) -> bool:
    """서식의 이름칸에 그대로 넣어도 되는 '사람 이름'인가.

    쉼표가 들어가면 여러 명을 한 칸에 몰아넣은 것이라 이름이 아니다
    ("첫째, 둘째"). 지칭어·미확인 표시도 이름이 아니다."""
    v = str(value or "").strip()
    v = re.sub(r"^망\s*", "", v).strip()
    if not (2 <= len(v) <= 10):
        return False
    if "," in v or "·" in v or "/" in v:
        return False
    if any(m in v for m in UNKNOWN_NAME_MARKS):
        return False
    return not NON_NAME_PERSON_RE.search(v)


def _known_names_by_role(extracted: dict, role_re) -> set:
    """추출정보에서 특정 역할에 해당하는 사람 이름을 모은다.

    두 가지 모양을 모두 읽는다.
      (1) 평평한 키-값        {"피상속인": "이재호"}
      (2) 당사자 목록          {"당사자": [{"역할": "피상속인(부친)", "이름": "미상"},
                                          {"역할": "청구인", "이름": "남기훈"}]}

    (2)가 분석 층(app/schemas/analysis.py ExtractedInfo)이 실제로 만드는 모양이다.
    역할에 "(부친)" 같은 괄호 설명이 붙으므로 정확히 일치가 아니라 포함으로 본다.
    '미상'처럼 확인 못 했다는 표시는 이름이 아니므로 뺀다 — 그걸 이름으로 채우면
    서식에 "피상속인 망 미상"이 찍힌다."""
    names = set()

    def add(value):
        v = str(value).strip()
        v = re.sub(r"^망\s*", "", v).strip()
        if _is_person_name(v):
            names.add(v)

    for key, value in (extracted or {}).items():
        if key == "당사자" and isinstance(value, (list, tuple)):
            for party in value:
                if isinstance(party, dict) and role_re.search(str(party.get("역할", ""))):
                    add(party.get("이름", ""))
        elif role_re.search(str(key)):
            for v in (value if isinstance(value, (list, tuple)) else [value]):
                add(v)
    return names


def _drop_unfounded_deceased_fills(replacements: list, extracted: dict) -> tuple:
    """사망자 이름을 추출정보에 근거 없이 채우는 치환을 버린다.

    사망자가 누구인지는 문서 전체의 의미를 정하는데, 상담 요약에는 "부친이
    사망했다"처럼 이름 없이 관계만 적히는 경우가 많다. 그러면 LLM이 요약에
    등장하는 다른 사람 이름을 끌어다 쓴다 — 실측된 사고가 유언에 반대하는
    형(남기준)을 유언자로 올린 것이었다. 유언자가 뒤바뀌면 이 서류는 정반대
    사람의 유언을 검인해 달라는 문서가 된다.

    그래서 추출정보에 사망자 이름이 '키로 명시'돼 있을 때만 채운다. 없으면
    비워두고 표시한다 — 상담원이 아는 이름을 적는 편이 훨씬 안전하다.

    반환: (남길 치환 목록, 버린 자리 설명 목록)"""
    allowed = _known_names_by_role(extracted, DECEASED_KEY_RE)

    kept, dropped = [], []
    for r in replacements:
        before = r.get("before") or ""
        if DECEASED_LABEL_RE.search(before):
            name = _inserted_name(before, r.get("after") or "")
            # 관계칸("유언자와의 관계 : 배우자" → "… : 아들")은 이름칸이 아니다.
            # 라벨에 '유언자'가 들어있어 여기까지 오지만, 들어간 값이 지칭어라
            # 이 필터가 막으려는 '엉뚱한 사람을 사망자로 세우는 사고'와 무관하다.
            # 그런데 버리면 서식 제작자의 예시값('배우자')이 그대로 남아, 빈칸도
            # 아니고 C단계 표시도 안 붙어 확정된 사실처럼 보인다 — 실측된 오차단.
            if name in RELATION_WORDS and RELATION_SLOT_RE.search(before):
                kept.append(r)
                continue
            if name and 2 <= len(name) <= 10 and name not in allowed:
                dropped.append(
                    f"사망자 이름이 상담에 없어 비워둠({name}): {before[:26]}")
                continue
        kept.append(r)
    return kept, dropped


def _label_name_pairs(replacements: list, living: set = frozenset()) -> list:
    """이미 채운 치환에서 '라벨 → 이름' 짝을 뽑는다.

    "유 언 자  □  □  □" → "유 언 자  남정호" 를 받아들였다면, 이 문서에서
    유언자가 남정호라는 것은 확정된 사실이다. 그 확정값을 같은 문서의 다른
    자리에도 쓰기 위해 짝으로 모은다 — 새로 추측하는 게 아니라 이미 승인된
    값을 옮기는 것뿐이다."""
    pairs = []
    for r in replacements:
        before = (r.get("before") or "")
        name = _inserted_name(before, r.get("after") or "")
        if not name or not (2 <= len(name) <= 10):
            continue
        if PLACEHOLDER_RE.search(name) or name in RELATION_WORDS:
            continue
        m = NAME_PLACEHOLDER_RE.search(before)
        if not m:
            continue
        label = re.sub(r"\s+", "", before[:m.start()]).strip("()（）:：")
        # 사람 라벨일 때만 짝으로 인정한다. 아무 앞말이나 라벨로 받으면
        # "상속재산 중 ○○시"의 "○○"까지 사람 이름으로 바뀐다(실제로 "은은시"가
        # 나왔다) — 이 기능은 사람 이름칸을 채우려고 있는 것이다.
        if label in PERSON_LABELS:
            pairs.append((label, name))

    # 사망자 라벨에 산 사람(청구인·신청인) 이름이 붙은 짝은 버린다. 이 함수는
    # 확정값을 문서 전체에 퍼뜨리므로, 틀린 짝 하나가 세 군데로 번진다 —
    # 실제로 "유언자 = 남기준(형)"이 한 곳에서 세 곳으로 늘었다.
    #
    # living은 밖에서 받는다. 여기서 pairs만 보고 만들면 "청구인(상속인)"처럼
    # 라벨에 괄호가 붙은 자리를 놓쳐서 living이 비고, 검사가 통째로 헛돈다.
    return [(lab, n) for lab, n in pairs
            if not (DECEASED_LABEL_RE.match(lab) and n in living)]


def _fill_names_in_narrative(doc, replacements: list) -> tuple:
    """긴 서술 문단 안에 남은 이름 자리표시자를 확정된 이름으로 채운다.

    A단계 프롬프트는 긴 서술 문단을 아예 대상에서 뺀다("그건 별도 처리"). 그런데
    그걸 맡기로 한 B단계 재서술은 신청취지 구간이나 법조문 인용 문단에서는
    일부러 손을 떼므로, 두 단계 사이에 구멍이 생긴다. 실제로 유언증서
    검인신청서에서

        유언자 망 □□□가 20○○. ○. ○. 작성한 별지의 자필증서에 …

    가 세 군데 다 비었다 — 같은 문서 위쪽에서 "유언자 = 남정호"를 이미
    확정해 채워놓고도.

    여기서는 이름만 바꾼다. 날짜·금액·주소 자리표시자는 그대로 두고, 문장도
    다시 쓰지 않는다 — 법조문 인용과 정형 문구가 원문 그대로 살아 있어야 한다.

    반환: (채운 자리 수, 바뀐 문단 텍스트 집합)"""
    living = _living_names(replacements)
    pairs = _label_name_pairs(replacements, living)
    if not pairs:
        return 0, set()

    # "유언자 망 □□□" 처럼 라벨과 자리표시자 사이에 한두 글자가 끼는 경우가
    # 흔하다(망, 인, :). 라벨은 서식에서 글자를 벌려 쓰므로 사이 공백을 허용한다.
    patterns = [(re.compile(r"\s*".join(map(re.escape, label)) + r".{0,6}?("
                            + NAME_PLACEHOLDER_RE.pattern + r")"), name)
                for label, name in pairs]

    filled, written = 0, set()
    for sec in doc.sections:
        for p in sec.paragraphs:
            runs = getattr(p, "runs", [])
            if not runs:
                continue
            text = "".join(getattr(x, "text", "") or "" for x in runs)
            if len(text) < 40 or not NAME_PLACEHOLDER_RE.search(text):
                continue
            new_text = text
            for pat, name in patterns:
                # 라벨과 자리표시자 사이에 사망 표시가 끼어 있는데 넣으려는 이름이
                # 산 사람이면 건드리지 않는다. "청구인들의 망 ○○○에 대한 재산상속
                # 포기 신고는…"은 라벨이 '청구인'이라 매칭되지만 그 칸의 주인은
                # 사망자다 — 여기에 청구인을 넣으면 산 사람의 상속을 포기하는 문서가
                # 된다. 반대로 "유언자 망 □□□"는 유언자 본인이 사망자이므로 채운다.
                def _sub(m, _n=name):
                    head = m.group(0)[:m.start(1) - m.start(0)]
                    if _n in living and DECEASED_LABEL_RE.search(head):
                        return m.group(0)
                    return head + _n

                new_text = pat.sub(_sub, new_text)
            if new_text != text and _set_paragraph_text(p, new_text):
                filled += 1
                written.add(new_text)
    return filled, written


# 사망 표시와 이름 자리표시자 사이에 낄 수 있는 글자. 공백·괄호·콜론과 '망'
# 한 글자만 허용한다("피상속인 망 △△△"). 여기에 다른 한글이 끼면 그건 서식
# 제작자가 넣은 예시 인물의 성씨다 — "소외 망 김□□"의 '김'. 그대로 채우면
# "망 김백승현"처럼 성이 둘인 없는 사람이 만들어진다(실측: 친생자관계부존재확인
# 청구의 소에서 11곳이 그렇게 나왔다). 성씨가 붙어 있으면 그 자리는 우리
# 사망자가 아니라 서식의 등장인물이므로 아예 건드리지 않는다.
_DECEASED_SLOT_GAP_RE = re.compile(r"^[\s망:：()（）]{0,4}$")

# 자리표시자 바로 뒤에 이런 글자가 오면 사람 이름칸이 아니라 주소칸이다 —
# "유언자 ○○시 ○○구 ○○길"을 채우면 "유언자 백승현시"가 된다(실측).
# 조사로도 쓰이는 '가'·'로'는 넣지 않는다("망 ○○○가 사망하여"를 막게 된다).
_ADDRESS_UNIT_RE = re.compile(r"^(시|도|군|구|읍|면|동|리|길|번지|아파트|호)")


def _fill_deceased_name_slots(doc, extracted: dict) -> tuple:
    """"망 △△△"처럼 사망 표시 바로 뒤에 남은 이름칸을 사망자 이름으로 채운다.

    상속재산포기 심판청구서에서 사건본인(사망자) 칸에는 백승현이 들어갔는데
    청구취지·청구원인의

        청구인들의 망 △△△에 대한 재산상속포기 신고는 이를 수리한다.
        청구인들은 피상속인 망 △△△의 재산상속인으로서 …

    는 비어 있었다. 두 갈래가 다 막혀 있어서다 —
      · _fill_names_in_narrative는 라벨이 PERSON_LABELS에 있어야 채우는데
        이 줄의 라벨은 '청구인들의망'으로 잡혀 목록에 없다.
      · _fill_known_role_names는 '망'이 앞에 붙으면 청구인·상대방을 넣지 않고
        (그게 맞다 — 산 청구인이 자기 상속을 포기하는 문서가 된다),
        사망자 이름을 넣으려면 줄에 '사건본인'이라는 글자가 있어야 하는데 없다.

    여기서는 사망 표시 바로 뒤에 붙은 자리표시자만 본다. 그 자리의 주인은
    정의상 사망자라, 사람이 뒤바뀔 여지가 없다. 사이에 예시 성씨가 끼었거나
    (_DECEASED_SLOT_GAP_RE) 뒤가 주소칸이면(_ADDRESS_UNIT_RE) 건너뛴다.

    추측이 아니라 옮겨 적기다 — 추출정보에 사망자로 명시된 이름만 쓰고,
    후보가 둘 이상이면 누구인지 못 고르므로 아예 손대지 않는다.

    반환: (채운 자리 수, 바뀐 문단 텍스트 집합)"""
    names = _known_names_by_role(extracted, DECEASED_KEY_RE)
    if len(names) != 1:
        return 0, set()
    name = next(iter(names))

    filled, written = 0, set()
    for sec in doc.sections:
        for p in sec.paragraphs:
            runs = getattr(p, "runs", [])
            if not runs:
                continue
            text = "".join(getattr(x, "text", "") or "" for x in runs)
            # 이미 그 이름이 있는 줄은 건드리지 않는다(사건본인란 등).
            if name in text or not NAME_PLACEHOLDER_RE.search(text):
                continue
            parts, cursor = [], 0
            for label in DECEASED_LABEL_RE.finditer(text):
                if label.end() < cursor:
                    continue
                slot = NAME_PLACEHOLDER_RE.search(text, max(cursor, label.end()))
                if not slot:
                    continue
                if not _DECEASED_SLOT_GAP_RE.match(text[label.end():slot.start()]):
                    continue
                if _ADDRESS_UNIT_RE.match(text[slot.end():]):
                    continue
                parts.append(text[cursor:slot.start()])
                parts.append(name)
                cursor = slot.end()
            if not parts:
                continue
            parts.append(text[cursor:])
            new_text = "".join(parts)
            if new_text != text and _set_paragraph_text(p, new_text):
                filled += 1
                written.add(new_text)
    return filled, written


# 관계어는 이름이 아니다. 상담에 이름이 없을 때 GPT가 이 자리에 자주 넣는다.
RELATION_WORDS = {
    "형", "누나", "동생", "여동생", "남동생", "오빠", "언니", "누이",
    "아버지", "어머니", "부친", "모친", "아버님", "어머님",
    "배우자", "남편", "아내", "자녀", "아들", "딸", "손자", "손녀",
    "청구인", "신청인", "상대방", "피신청인", "사건본인", "유언자", "피상속인",
}


def _collect_person_names(replacements: list) -> list:
    """A단계가 넣은 값들에서 사람 이름을 문서 순서대로 모은다.

    당사자가 여럿인 서식은 한 줄에 여러 명이 나열된다
    ("공동상속인 조민석, 조회진, 조수는"). 쉼표로 갈라 순서대로 담는다."""
    names = []
    for r in replacements:
        inserted = _inserted_name(r.get("before", ""), r.get("after", ""))
        for part in re.split(r"[,、·/]|\s및\s|\s와\s|\s과\s", inserted):
            name = part.strip()
            # 끝에 붙은 조사 한 글자만 뗀다("조수는"→"조수"). 통째로 rstrip하면
            # "은은"처럼 조사 글자로만 된 이름이 빈 문자열이 돼 사라진다.
            if len(name) >= 3 and name[-1] in "은는이가와과":
                name = name[:-1]
            if not (2 <= len(name) <= 10):
                continue
            if PLACEHOLDER_RE.search(name) or name in RELATION_WORDS:
                continue
            if name not in names:
                names.append(name)
    return names


def _apply_repeated_name_slots(doc, replacements: list) -> tuple:
    """같은 문구가 여러 줄 반복되는 이름칸을 사람별로 나눠 채운다.

    _apply_fields는 doc.replace_text_in_runs(before, after)로 '일치하는 곳을
    전부' 바꾼다. 그런데 상속재산분할협의서의 서명란은

        성 명  ○  ○  ○
        성 명  ○  ○  ○
        성 명  ○  ○  ○

    처럼 글자까지 똑같이 세 줄이다. GPT가 치환 하나만 내놔도 세 곳이 전부
    같은 이름이 됐다 — 공동상속인 세 사람이 전원 같은 사람으로 서명하는
    문서가 만들어졌다. 프롬프트가 아니라 치환 방식 문제라 여기서 직접 나눈다.

    이름이 모자라면 남는 칸은 원본 자리표시자 그대로 둔다. C단계가 표시를
    붙여 상담원에게 넘긴다 — 있는 이름을 복사해 채우면 없는 사람이 생긴다.

    반대로 사람이 칸보다 많으면(상속인 4명 · 서명칸 3개) 넘치는 사람은 서식에
    적힐 자리가 없다. 예전에는 그냥 조용히 빠져서, 상속인 한 명이 빠진 협의서를
    상담원이 그대로 들고 나갈 수 있었다 — 빠진 사람을 unfilled로 올려 알린다.

    반환: (처리한 replacement 목록, 채운 칸 수, 써넣은 문단 텍스트 집합,
           자리가 없어 빠진 사람 안내 목록)
    세 번째 값은 C단계(_mark_unresolved_examples)가 '우리가 채운 줄'을 서식
    예시로 오인해 [예시:확인필요]를 붙이지 않게 하려고 돌려준다."""
    names = _collect_person_names(replacements)
    handled, filled, written, overflow = [], 0, set(), []
    if len(names) < 2:
        return handled, filled, written, overflow

    for r in replacements:
        before, after = (r.get("before") or "").strip(), (r.get("after") or "").strip()
        if not before or not after:
            continue
        inserted = _inserted_name(before, after)
        if inserted not in names:
            continue

        # 칸을 늘리려면 문단 객체만으로는 안 되고 '몇 번째 섹션의 몇 번째 문단'인지
        # 알아야 한다(copy_paragraph_range/insert_paragraphs가 인덱스를 받는다).
        targets = []          # [(sec, para_index, para, text), ...]
        for sec in doc.sections:
            for i, p in enumerate(sec.paragraphs):
                runs = getattr(p, "runs", [])
                if not runs:
                    continue
                text = "".join(getattr(x, "text", "") or "" for x in runs)
                if before in text:
                    targets.append((sec, i, p, text))
        if len(targets) < 2:
            continue                      # 한 곳뿐이면 기존 경로가 처리한다

        start = names.index(inserted)
        for offset, (_sec, _i, para, text) in enumerate(targets):
            idx = start + offset
            if idx >= len(names):
                break                     # 이름이 모자라면 자리표시자로 남긴다
            new_text = text.replace(before, after, 1).replace(inserted, names[idx], 1)
            if _set_paragraph_text(para, new_text):
                filled += 1
                written.add(new_text)
        handled.append(r)

    # 칸이 모자란 경우(사람 4명·칸 3개)는 여기서 늘리지 않는다. 이 함수는 GPT가
    # 준 before 문자열이 여러 곳에 똑같이 걸릴 때만 동작하는데, 실제로 늘려야 할
    # 칸은 그렇지 않은 경우가 더 많다 — 상속재산 항목은 세 줄이 ○○시/□□시/△△시로
    # 글자가 달라 before가 각각 한 곳씩만 걸린다. 늘리기는 값이 다 채워진 뒤
    # '모양이 같은 줄'을 찾는 _grow_name_slot_groups가 문서 전체에서 맡는다.
    return handled, filled, written, overflow


# "이 협의서 3통을 작성하고" — 당사자 수만큼 부수를 적는 정형 문구.
COPY_COUNT_RE = re.compile(r"(협의서|합의서|계약서|약정서)\s*(\d+)\s*통")


def _sync_copy_count(doc, people: int) -> list:
    """서명칸을 늘렸으면 본문의 '○통을 작성하고'도 같이 고친다.

    이 부수는 당사자 수와 같아야 한다(각자 1통씩 보유). 칸만 네 개로 늘리고
    본문은 '3통'으로 두면 서명자는 넷인데 부수는 셋인 앞뒤가 안 맞는 문서가
    된다 — 상담원이 아니라 서식이 틀린 것처럼 보인다."""
    written = []
    for sec in doc.sections:
        for p in sec.paragraphs:
            runs = getattr(p, "runs", [])
            if not runs:
                continue
            text = "".join(getattr(x, "text", "") or "" for x in runs)
            m = COPY_COUNT_RE.search(text)
            if not m or int(m.group(2)) == people:
                continue
            new_text = COPY_COUNT_RE.sub(rf"\g<1> {people}통", text, count=1)
            if _set_paragraph_text(p, new_text):
                written.append(new_text)
    return written


def _shape_of(text: str, names: list) -> str:
    """줄의 '모양'만 남긴다 — 사람 이름·자리표시자·숫자·공백을 지운 뼈대.

    같은 칸이 반복되는지 판단하려면 글자가 똑같은지가 아니라 구조가 같은지를
    봐야 한다. 상속재산분할협의서의 배분 항목 세 줄은

        1. 상속재산 중  ○○시 ○○구 ○○동 ○○ 대 300㎡는 은은의 소유로 한다.
        1. 상속재산 중  □□시 □□구 □□동 □□ 대 200㎡는 조민석의 소유로 한다.
        1. 상속재산 중  △△시 △△구 △△동 △△ 대 100㎡는 조회진의 소유로 한다.

    처럼 자리표시자 기호(○/□/△)와 면적 숫자가 줄마다 달라서 글자로는 전혀 안
    겹치지만, 뼈대는 "상속재산중N대N㎡는N의소유로한다"로 셋 다 같다."""
    out = text
    for name in names:
        out = out.replace(name, "\x00")
    out = PLACEHOLDER_RE.sub("\x00", out)
    out = re.sub(r"\d+", "\x00", out)
    out = re.sub(r"[\x00]+", "\x00", out)
    return re.sub(r"\s+", "", out)


def _names_in(text: str, names: list) -> list:
    """줄에 들어있는 사람 이름을 등장 순서대로."""
    found = [(text.find(n), n) for n in names if n in text]
    return [n for _pos, n in sorted(found)]


def _grow_name_slot_groups(doc, names: list) -> tuple:
    """사람이 서식의 칸보다 많으면 마지막 칸을 복제해 사람 수만큼 칸을 늘린다.

    상속재산분할협의서는 서명란도 배분항목도 세 벌뿐인데, 상속인이 네 명인
    사건이 흔하다. 예전에는 네 번째 사람이 조용히 빠져서 상속인 한 명이 누락된
    협의서가 그대로 나갔다 — 누락된 협의서는 무효라 빈칸보다 위험하다.

    값을 다 채운 뒤에 돌린다. 그래야 '이름이 하나씩 박힌 같은 모양의 줄'을
    문서에서 직접 찾을 수 있다(GPT가 준 치환 문자열에 기대지 않는다).

    늘릴 조건을 좁게 잡는다 — 넓으면 첨부서류 목록 같은 반복 줄까지 늘어난다:
      · 모양(_shape_of)이 같은 줄이 2줄 이상
      · 각 줄에 이름이 정확히 하나씩, names 순서대로 앞에서부터 붙어 있을 것
      · 줄 간격이 일정할 것(성명+주소 = 2줄이 한 벌)
      · 청구인·상대방처럼 서식이 인원을 정해 둔 자리가 아닐 것

    반환: (새로 써넣은 문단 텍스트 집합, 늘린 칸 수)"""
    written, grown = set(), 0
    if len(names) < 2:
        return written, grown

    for sec in doc.sections:
        # 모양이 같은 줄끼리 묶는다. 인덱스가 뒤에서부터 바뀌도록 역순으로 처리해야
        # 앞쪽 그룹의 인덱스가 어긋나지 않는다.
        groups = {}
        for i, p in enumerate(sec.paragraphs):
            runs = getattr(p, "runs", [])
            if not runs:
                continue
            text = "".join(getattr(x, "text", "") or "" for x in runs)
            hit = _names_in(text, names)
            if len(hit) > 1:
                continue
            if not hit:
                # 이름이 안 들어간 칸도 '한 사람 몫의 칸'일 수 있다. 상속재산
                # 배분항목처럼 누가 무엇을 받는지 상담에 없으면 이름을 비워두는
                # 게 맞는데(지어낸 배분은 위험하다), 그렇다고 칸 수까지 사람보다
                # 적으면 한 명이 배분에서 빠진다. 자리표시자가 여러 개인 줄도
                # 후보다 — 배분항목은 주소·면적·이름 칸이 한 줄에 다 있다.
                # 엉뚱한 줄이 딸려오는 것은 아래의 '모양이 같을 것 + 간격이
                # 일정할 것' 조건이 막는다.
                if not NAME_PLACEHOLDER_RE.search(text):
                    continue
            groups.setdefault(_shape_of(text, names), []).append(
                (i, text, hit[0] if hit else None))

        targets = []
        for _shape, rows in groups.items():
            if len(rows) < 2:
                continue
            filled_names = [r[2] for r in rows]
            all_named = filled_names == names[:len(rows)]
            all_blank = all(n is None for n in filled_names)
            if not (all_named or all_blank):
                continue                    # 이름이 순서대로 붙어있지 않으면 남의 줄
            if len(names) <= len(rows):
                continue                    # 칸이 모자라지 않는다
            if CONTESTED_ROLE_LABEL_RE.search(rows[-1][1]):
                continue                    # 서식이 인원을 정해 둔 자리는 안 늘린다
            strides = {b[0] - a[0] for a, b in zip(rows, rows[1:])}
            if len(strides) != 1:
                continue                    # 한 벌의 크기를 잴 수 없다
            targets.append((rows, strides.pop()))

        # 한 벌이 여러 줄이면(성명 + 주소) 그 안의 줄들도 각각 '모양이 같은 그룹'을
        # 이룬다. 성명 그룹을 늘리면 주소 줄은 같이 복제되므로, 주소 그룹까지
        # 따로 늘리면 두 번 늘어난다. 앞선 그룹의 한 벌에 이미 포함된 줄은 건너뛴다.
        chosen, covered = [], set()
        for rows, stride in sorted(targets, key=lambda t: t[0][0][0]):
            span = {i for r in rows for i in range(r[0], r[0] + stride)}
            if span & covered:
                continue
            covered |= span
            chosen.append((rows, stride))

        # 뒤쪽 그룹부터 늘려야 앞쪽 그룹의 문단 인덱스가 어긋나지 않는다.
        for rows, stride in sorted(chosen, key=lambda t: t[0][-1][0], reverse=True):
            block_start = rows[-1][0]
            last_text, last_name = rows[-1][1], rows[-1][2]
            for name in names[len(rows):]:
                # 한 벌이 문서 끝을 넘어가면 복제할 원본이 없다(마지막 벌이 잘려
                # 있는 경우) — 늘리지 않고 둔다.
                if block_start + stride > len(sec.paragraphs):
                    break
                # copy_paragraph_range는 end를 포함한다 — 한 벌이 stride줄이므로 -1.
                block = sec.copy_paragraph_range(block_start, block_start + stride - 1)
                added = sec.insert_paragraphs(block_start + stride, block)
                if added:
                    grown += 1
                    # 복제본에는 직전 사람 이름이 박혀 있다. 한 벌의 첫 줄이
                    # 이름칸이므로 거기만 새 이름으로 고친다. 원래 이름칸이
                    # 비어 있던 칸(배분항목 등)은 비운 채로 늘린다 — 근거 없는
                    # 배분을 지어내지 않고 C단계 표시에 맡긴다.
                    if last_name is not None:
                        new_text = last_text.replace(last_name, name, 1)
                        if _set_paragraph_text(added[0], new_text):
                            written.add(new_text)
                block_start += stride       # 다음 복제는 방금 넣은 벌 뒤에

    if grown:
        written.update(_sync_copy_count(doc, len(names)))
    return written, grown


# 서술란의 시작(제목)과 끝. 글자 사이를 벌려 쓰므로 공백을 지운 뒤 비교한다.
NARRATIVE_SECTION_START_RE = re.compile(
    r"^(청구이유|청구원인|신청이유|신청원인|신청취지및이유|사건의개요|사유)$"
)
NARRATIVE_SECTION_STOP_RE = re.compile(
    r"첨부서류|입증방법|소명방법|첨부자료|유의사항|관할법원|위청구인|위신청인"
)
# "(청구사유를 구체적으로 기재해 주십시오.)" 같은 작성 안내. 내용이 아니라 안내다.
SECTION_GUIDE_RE = re.compile(r"^[(（].*(기재|작성|적어|써).*[)）]$")


def _fill_empty_narrative_section(doc, extracted: dict, summary: str) -> int:
    """예시 문장 없이 '빈 칸'으로 남겨둔 서술란에 사건 내용을 써넣는다.

    서식은 두 부류다. 하나는 청구원인에 서식 제작자의 예시 사연이 인쇄돼 있어
    그걸 우리 사건으로 다시 쓰면 되고(친권행사자 변경 등), 다른 하나는
    아예 비어 있다:

        청 구 이 유
        (청구사유를 구체적으로 기재해 주십시오.)
                                    ← 빈 칸

    B단계는 '있는 문장을 바꾸는' 일만 하므로 후자에서는 아무것도 안 쓴다.
    실제로 친권 일부제한 심판청구서가 청구이유가 통째로 빈 채로 나갔다.
    여기서 그 빈 칸을 채운다 — 근거 없는 내용은 쓰지 않는다는 원칙은 같아서,
    재서술과 똑같이 _verify_rewrite로 날짜·금액을 검증한다."""
    filled = 0
    years, money = _allowed_facts(extracted, summary)
    party_terms = _detect_party_terms(doc)

    for sec in doc.sections:
        paras = list(sec.paragraphs)
        texts = ["".join(getattr(r, "text", "") or "" for r in getattr(p, "runs", []))
                 for p in paras]

        for i, t in enumerate(texts):
            compact = re.sub(r"\s+", "", t)
            if not NARRATIVE_SECTION_START_RE.match(compact):
                continue

            # 제목 다음부터 다음 구획 전까지가 이 서술란이다.
            end = len(paras)
            for j in range(i + 1, len(paras)):
                if NARRATIVE_SECTION_STOP_RE.search(re.sub(r"\s+", "", texts[j])):
                    end = j
                    break

            body = [(j, texts[j]) for j in range(i + 1, end)]
            # 내용이라 할 만한 게 있으면(안내문 제외) 건드리지 않는다 — B단계 담당이다.
            has_content = any(
                s.strip() and not SECTION_GUIDE_RE.match(s.strip()) and len(s.strip()) >= 10
                for _, s in body
            )
            if has_content or not body:
                continue

            new_texts = _rewrite_examples([t.strip() or "청구이유"], extracted, summary,
                                          party_terms)
            new_texts = _selfcheck_and_revise(new_texts, extracted, summary)
            new_text = (new_texts[0] if new_texts else "").strip()
            if not new_text or _verify_rewrite(new_text, years, money):
                continue

            # 안내문 아래 첫 빈 문단에 쓴다. 빈 문단은 run이 없을 수 있어 만들어준다.
            target = None
            for j, s in body:
                if not s.strip():
                    target = paras[j]
                    break
            if target is None:
                target = paras[body[-1][0]]

            if getattr(target, "runs", None):
                if _set_paragraph_text(target, new_text):
                    filled += 1
            else:
                try:
                    target.add_run(new_text)
                    filled += 1
                except Exception:
                    pass

    return filled


def _seed_role_names(applicant_name: str = "", opponent_name: str = "",
                     extracted: dict = None) -> dict:
    """상담 기록에 확정돼 있는 당사자 이름을 역할별로 정리한다.

    이름은 AI가 추론할 대상이 아니다 — 상담을 접수할 때 이미 적어둔 값이고
    (Consultation.clientName / opponentName), core-api가 그대로 내려준다.
    그런데 지금까지는 GPT가 요약문에서 다시 찾아내야 했고, 그래서 당사자란은
    채우고 서명란은 빠뜨리거나(유언증서 검인신청서) 형을 유언자로 넣는
    일이 났다.

    core-api가 /forms/draft에 이 두 값을 실어 보낸다. 다만 통화 중 접수처럼
    이름을 아직 안 적은 상담이 흔해서 비어 오는 경우가 많고, 그때는 추출정보의
    당사자 목록이 유일한 확정 출처다. 그래서 양쪽에서 다 뽑는다.

    우선순위는 접수 때 적어둔 값 > 추출정보 > GPT 추론이다. 앞의 둘은 사람이
    확인한 값이고 마지막만 추론이라, 사람 손을 거친 쪽이 이긴다."""
    seeded = {}
    for role, key_re in (("청구인", LIVING_KEY_RE), ("상대방", OPPONENT_KEY_RE)):
        names = _known_names_by_role(extracted, key_re)
        if len(names) == 1:      # 여럿이면 누가 그 칸의 주인인지 알 수 없다
            seeded[role] = names.pop()
    # 접수 때 적어둔 값이 있으면 그게 우선이다.
    if applicant_name and applicant_name.strip():
        seeded["청구인"] = applicant_name.strip()
    if opponent_name and opponent_name.strip():
        seeded["상대방"] = opponent_name.strip()
    return seeded


# 서식을 채우는 데 쓸모가 없으면서 프롬프트만 키우는 키들.
#   aiAnalysisResponse  프론트가 분석 응답 전체를 통째로 다시 넣은 것. 그 안에
#                       extracted_json·raw_input_json이 또 중첩돼 있어 혼자
#                       전체의 8할을 차지한다(실측 9,131자 중 7,684자).
#   extracted_content   STT 원문 대화록. "유언장"이 "유원장", "무효"가 "무혈"로
#                       적혀 있어 넣으면 오히려 잘못된 값을 만든다. 사건 내용은
#                       summary로 따로 전달된다.
#   case_list 등        사건 분류·긴급도. 서식 칸에 들어갈 값이 아니다.
#   주소·전화번호       LLM 단계에 보이면 안 되는 값이다. 서식의 주소칸은 청구인
#                       것도 채무자 것도 회사 것도 모양이 같아서, 모델이 이 값을
#                       쥐고 있으면 어느 칸에든 넣는다 — A단계 일괄 치환에서는
#                       한 번에 세 칸이 전부 청구인 주소가 됐다. 당사자 구획을
#                       따라가는 _fill_contact_info가 draft() 인자로 따로 받아
#                       청구인 칸만 채운다. 그쪽은 이 목록과 무관하게 동작한다.
#   개인정보동의        수집 동의 여부. 서식에 적히는 값이 아니다.
_DRAFT_IRRELEVANT_KEYS = {
    "aiAnalysisResponse", "aiEligibilityResponse", "aiMissingDataResponse",
    "raw_input_json", "extracted_content", "extracted_content_detail",
    "attachment_links", "submitted_file_link",
    "case_list", "case_emergency_level", "case_emergency_ratio",
    "case_emergency_reason",
    "주소", "전화번호", "개인정보동의",
}


def _trim_extracted_for_draft(extracted: dict) -> tuple:
    """초안 생성에 넣을 추출정보만 남긴다.

    core-api는 AI_ANALYSIS의 extracted_json을 통째로 보낸다. 거기엔 서식과
    무관한 것들이 잔뜩 들어 있어서, 실제 사건 상담에서 2만 5천 자까지 커진다.
    서식 원문이 2천 자인데 추출정보가 2만 5천 자면 모델이 무엇을 채워야 할지
    놓치고 응답이 늘어지다 잘린다 — 실제로 응답이 27,500자에서 끊겨
    JSONDecodeError가 났고, 그러면 치환 목록이 통째로 버려져 당사자란이 빈
    초안이 나간다(재현 3/3, 한 번에 220초).

    모르는 키는 남긴다. 분석 층이 앞으로 항목을 더 붙일 수 있고, 여기서
    화이트리스트로 막으면 그때마다 이 파일을 같이 고쳐야 한다."""
    if not isinstance(extracted, dict):
        return extracted, 0
    kept = {k: v for k, v in extracted.items() if k not in _DRAFT_IRRELEVANT_KEYS}
    dropped = len(extracted) - len(kept)
    return kept, dropped


# 서식이 예시 인물을 표시하는 토큰. 같은 역할이라도 토큰이 다르면 다른 사람이다.
#   "원 고 1. ○○○ / 2. 김①○ / 3. 김②○"  ← 예시 원고 세 명
PERSON_PH_TOKEN_RE = re.compile(
    r"[가-힣][①②③④⑤][○◯□◇▢△▲◉]"      # 김①○
    r"|[가-힣]?[○◯□◇▢△▲◉]{2,3}")        # ○○○, 김◇◇


def _removed_placeholder(before: str, after: str) -> str:
    """치환으로 '지워진 자리표시자'를 뽑는다(_inserted_name의 반대)."""
    i = 0
    while i < min(len(before), len(after)) and before[i] == after[i]:
        i += 1
    j = 0
    while (j < min(len(before), len(after)) - i
           and before[len(before) - 1 - j] == after[len(after) - 1 - j]):
        j += 1
    return before[i:len(before) - j].strip() if j else before[i:].strip()


def _drop_surplus_person_fills(replacements: list, extracted: dict = None) -> tuple:
    """한 사람을 서식의 여러 당사자 자리에 중복으로 넣는 치환을 버린다.

    유류분반환청구의 소는 원고 3인용 서식이라 예시 인물이 ○○○·김①○·김②○ 셋이다.
    청구인이 한 명인 사건에서 GPT가 세 자리를 전부 같은 이름으로 채웠고, 상속분
    계산식까지 "원고 장미란 3/9 / 원고 장미란 2/9 / 원고 장미란 2/9"로 세 벌이
    나왔다. 한 사람이 셋으로 늘어난 문서다.

    판단 기준은 역할 라벨이 아니라 '같은 이름이 다른 자리에 들어가는가'다.
    처음에는 역할별 인원수와 자리수를 비교했는데, 상속재산분할협의서처럼 당사자
    전원이 대등한(공동상속인) 서식에서 분석이 한 명만 '청구인'으로 라벨링하면
    나머지 세 명이 통째로 잘려나갔다. 라벨은 층마다 다르게 붙지만, 같은 사람이
    두 자리를 차지할 수 없다는 것은 어느 서식에서나 같다.

    자리표시자 토큰이 곧 그 사람의 '자리'다(○○○ 1번, 김①○ 2번). 같은 이름이
    이미 다른 토큰에 배정돼 있으면 그 치환은 버린다. 같은 토큰이 여러 줄에
    걸치는 것(당사자란·서명란·계산식)은 같은 사람이므로 그대로 둔다.

    버린 자리는 원본 그대로 두고 C단계가 [예시:확인필요]를 붙여 상담원에게
    넘긴다 — 있는 사람을 복사해 채우면 없는 당사자가 생긴다."""
    # 이 사건에 실제로 있는 사람 이름. 한 줄에 여러 자리가 든 문장을 판정할 때,
    # 그 이름이 원문보다 늘어났는지를 세는 데 쓴다.
    real_names = set()
    for rx in (LIVING_KEY_RE, OPPONENT_KEY_RE, DECEASED_KEY_RE):
        real_names |= _known_names_by_role(extracted or {}, rx)

    slot_of: dict[tuple, str] = {}      # (역할, 이름) -> 처음 배정된 자리 토큰
    kept, dropped = [], []
    for r in replacements:
        role = (r.get("role") or "").strip()
        before, after = r.get("before", ""), r.get("after", "")
        tokens = PERSON_PH_TOKEN_RE.findall(before)
        if not tokens:
            kept.append(r)
            continue

        name = _inserted_name(before, after)
        # 한 줄에 예시 인물이 여럿인 문장("원고 ○○○에게 …, 원고 김①○, 원고 김②○")은
        # 일부만 고쳐 쓸 수 없다. 한 사람이 두 번 이상 늘어났으면 통째로 버린다.
        # 이 줄은 _inserted_name이 이름 하나가 아니라 긴 덩어리를 돌려주므로,
        # 실제 당사자 목록으로 등장 횟수를 센다.
        if len(tokens) > 1:
            grown = [n for n in real_names
                     if after.count(n) >= 2 and after.count(n) > before.count(n)]
            if grown:
                dropped.append(f"당사자 자리 {len(tokens)}개를 '{grown[0]}' 한 사람으로 "
                               f"채운 문장 (…{before[:34]}…)")
                continue
            kept.append(r)
            continue

        if not name or len(name) > 20 or PLACEHOLDER_RE.search(name):
            kept.append(r)          # 이름 자리가 아닌 치환(주소·날짜·금액)
            continue

        token = _removed_placeholder(before, after) or tokens[0]
        key = (role, name)
        first = slot_of.setdefault(key, token)
        if first != token:
            dropped.append(f"'{name}'을(를) 다른 당사자 자리에도 넣은 치환 "
                           f"(이미 '{first}' 자리에 배정됨)")
            continue
        kept.append(r)
    return kept, dropped


def _apply_confirmed_names_to_extracted(extracted: dict, applicant_name: str = "",
                                        opponent_name: str = "") -> tuple:
    """추출정보의 당사자 이름을 상담원이 확인한 이름으로 바꾼다.

    치환값만 고치면 당사자란은 맞는데 본문은 틀린 문서가 나온다. 서술 문단을
    새로 쓰는 단계(_rewrite_examples)와 표를 채우는 단계는 치환 목록이 아니라
    추출정보를 보기 때문이다 — 실제로 "채 권 자 남기훈"과 "신청인 김분석과
    피신청인 박분석은 협의이혼을 하였습니다"가 한 문서에 같이 나왔다.
    이름이 섞인 초안은 틀린 이름 하나보다 나쁘다. 상담원이 어느 쪽이 맞는지
    알 수 없고, 고칠 자리를 다 찾지도 못한다.

    그래서 모든 단계가 보기 전에 출처를 고친다. 상담원이 이름을 고쳤다는 것은
    AI가 요약문에서 잘못 뽑았다는 뜻이므로, 추출정보 쪽이 틀린 것이다.

    원본은 건드리지 않는다 — 호출부(core-api)가 넘겨준 dict라 여기서 바꾸면
    같은 분석 결과를 쓰는 다른 경로까지 영향을 받는다."""
    # 이름이 아닌 값은 '확인된 이름'으로 받지 않는다. 프론트가 화면 표시용으로 쓰는
    # 문구("이름 미입력")가 상담 등록 때 clientName으로 저장돼 여기까지 넘어온다.
    # 그걸 확정값으로 받으면, 분석이 제대로 뽑아낸 청구인 이름(문가영)을 덮어써서
    # 서식에 "청구인(상속인) 이름 미입력"이 인쇄된다 — 실측된 사고다.
    pairs = [(LIVING_KEY_RE, (applicant_name or "").strip()),
             (OPPONENT_KEY_RE, (opponent_name or "").strip())]
    pairs = [(rx, nm) for rx, nm in pairs if nm and _is_person_name(nm)]
    if not pairs or not isinstance(extracted, dict):
        return extracted, 0

    fixed = dict(extracted)
    changed = 0

    parties = fixed.get("당사자")
    if isinstance(parties, (list, tuple)):
        new_parties = []
        for party in parties:
            if isinstance(party, dict):
                role = str(party.get("역할", ""))
                for rx, name in pairs:
                    if rx.search(role) and str(party.get("이름", "")).strip() != name:
                        party = {**party, "이름": name}
                        changed += 1
                        break
            new_parties.append(party)
        fixed["당사자"] = new_parties

    # {"청구인": "김분석"}처럼 평평하게 적힌 모양도 함께 고친다.
    for key, value in list(fixed.items()):
        if key == "당사자" or not isinstance(value, str):
            continue
        for rx, name in pairs:
            if rx.search(key) and value.strip() != name:
                fixed[key] = name
                changed += 1
                break

    return fixed, changed


# ══════════════════════════════════════
# 서식 작성용 연락처 (주소·전화)
# ══════════════════════════════════════
# 법원 서식의 당사자 주소는 송달을 위한 법정 필수 기재사항이라, 비어 있으면 상담원이
# 초안을 받아 손으로 다시 채워야 한다. 상담 접수 때 동의를 받고 적어둔 값이 있으면
# 그걸 옮겨 적는다 — 이름·날짜와 같은 이유로 판단이 아니라 옮겨 적기다.
#
# 값은 core-api가 넘겨준다. 동의가 없으면 Consultation이 아예 값을 갖지 않아서
# 빈 문자열이 오므로, 여기서 동의를 다시 검사하지 않는다.

# 줄 첫머리의 라벨. 서식마다 "주소 :", "주소", "전화․휴대폰번호:"처럼 모양이 다르고,
# "(연락처 :        )"처럼 라벨째 괄호에 들어간 것도 있다 — 여는 괄호를 허용하지
# 않으면 ^\s* 다음에 "("를 만나 통째로 놓친다(양육비 직접지급명령 신청서에서 실측).
ADDRESS_LABEL_RE = re.compile(
    r"^\s*\(?\s*(?:주\s*소|현\s*주\s*소|송\s*달\s*장\s*소)\s*[:：]?")
# 긴 것부터 늘어놓아야 한다. 정규식 선택지는 앞에서부터 맞춰보므로 "전화"를
# 먼저 두면 "전화․휴대폰번호:"가 "전화"까지만 먹고 나머지를 값으로 오인해
# 영영 안 채워진다(이 파일의 docstring 예시가 실제로는 동작하지 않고 있었다).
PHONE_LABEL_RE = re.compile(
    r"^\s*\(?\s*(?:전화[․·、]?\s*휴대폰번호|전\s*화|연\s*락\s*처|휴\s*대\s*폰)"
    r"(?:\s*번\s*호)?\s*[:：]?")

# 라벨 전체가 괄호에 싸여 홀로 한 줄을 차지하는 서식이 있다("(주소)").
# 이건 라벨이 아니라 "여기에 주소를 적어라"는 자리표시자다 — 통째로 값이 된다.
# 라벨로 보고 뒤에 이어 붙이면 "(주소) 서울특별시…"처럼 안내문구가 인쇄된다.
BARE_ADDRESS_PAREN_RE = re.compile(
    r"^(\s*)\(\s*(?:주\s*소|현\s*주\s*소|송\s*달\s*장\s*소)\s*\)\s*$")
BARE_PHONE_PAREN_RE = re.compile(
    r"^(\s*)\(\s*(?:전\s*화(?:\s*번\s*호)?|연\s*락\s*처|휴\s*대\s*폰)\s*\)\s*$")

# A단계 치환에서 걷어낼 주소·전화칸의 라벨(_drop_contact_fills). 공백을 지운
# before와 맞춘다. 등록기준지·최후주소는 애초에 상담에서 받지 않는 값이라,
# A단계가 뭔가 채웠다면 그건 지어낸 것이거나 남의 주소다.
CONTACT_SLOT_LABEL_RE = re.compile(
    r"^\(?(?:주소|현주소|송달장소|등록기준지|최후주소|본적"
    r"|전화번호|전화|연락처|휴대폰번호|휴대폰)")

# 이 라벨이 붙은 주소칸은 청구인 것이 아니다. 사망자의 최후주소·등록기준지에
# 청구인 주소를 넣으면 사람이 뒤바뀐다.
FOREIGN_ADDRESS_LABEL_RE = re.compile(r"등록기준지|최후\s*주소|본적|사무소|영업소")

# 당사자 구획의 시작. 이 라벨이 나오면 '지금부터 누구 칸인지'가 바뀐다.
APPLICANT_BLOCK_RE = re.compile(r"청\s*구\s*인|신\s*청\s*인|원\s*고|채\s*권\s*자")
OTHER_BLOCK_RE = re.compile(
    r"상\s*대\s*방|피\s*신\s*청\s*인|피\s*고|채\s*무\s*자"
    r"|사\s*건\s*본\s*인|피\s*상\s*속\s*인|유\s*언\s*자|사\s*망\s*자|망\s*인")


# 값 뒤에 남겨야 하는 안내 괄호. 자리표시자가 들어 있지 않은 괄호는 채울 칸이
# 아니라 "여기에 무엇을 적어라"는 안내다.
TRAILING_NOTE_RE = re.compile(r"(\([^()]*\))\s*$")


def _fill_labeled_slot(text: str, label_match, value: str) -> str:
    """라벨 뒤의 주소·전화 자리를 값으로 바꾼다. 빈 칸이면 라벨 뒤에 이어 붙인다.

    "주소 : ○○시 ○○구 ○○길 ○○"                -> "주소 : 서울시 강남구 …"
    "주소 : ○○시 ○○구 ○○길 ○○번지(○○동, ○○아파트)" -> "주소 : 서울시 강남구 …"
    "주소 ○○시 ○○구 ○○길 ○○(우편번호)"          -> "주소 서울시 강남구 …(우편번호)"
    "전화․휴대폰번호:"                          -> "전화․휴대폰번호: 010-0000-0000"

    자리표시자 구간을 '첫 조각부터 마지막 조각까지'로 잡으면 안 된다. 서식은
    "○○번지(○○동, ○○아파트)"처럼 자리표시자 사이에 '번지'·'아파트' 같은 글자를
    끼워 두는데, 그것들도 주소 템플릿의 일부라 남기면 "테헤란로 123아파트)"가 된다
    (실측). 첫 자리표시자부터 줄 끝까지를 통째로 값으로 바꾼다.

    다만 끝에 붙은 안내 괄호는 남긴다 — "(우편번호)"를 지우면 상담원이 우편번호를
    따로 적어야 한다는 것을 알 수 없다. 자리표시자가 든 괄호는 안내가 아니라
    채울 칸이므로 함께 지운다."""
    head_end = label_match.end()
    rest = text[head_end:]

    first = PLACEHOLDER_RE.search(rest)
    if first:
        body = rest[first.start():]
        keep = ""
        note = TRAILING_NOTE_RE.search(body)
        if note and not PLACEHOLDER_RE.search(note.group(1)):
            keep = note.group(1)
            body = body[:note.start()]
        head, gap = text[:head_end], rest[:first.start()]
        # 라벨과 자리표시자가 붙어 있는 서식이 있다("주소○○시 ○○구"). 그대로 두면
        # "주소서울특별시"가 되어 라벨과 값이 한 낱말로 읽힌다.
        if not gap and head and not head[-1].isspace():
            gap = " "
        return _balance_parens(head + gap + value + keep)

    # 빈 칸인 경우. 뒤에 다른 글자가 이미 있으면 건드리지 않는다 — 값이 두 번 찍힌다.
    # 다만 "(연락처 :        )"처럼 닫는 괄호만 남은 것은 빈 칸이다. 이걸 '글자가
    # 있다'로 보면 라벨째 괄호에 든 전화칸을 영영 못 채운다.
    tail = rest.strip()
    if tail and tail != ")":
        return text
    return text[:head_end] + " " + value + tail


def _balance_parens(text: str) -> str:
    """라벨이 괄호 안에 있을 때 값으로 지워진 닫는 괄호를 되살린다.

    "(주소 : ○○시 ○○구)"는 라벨 매칭이 "(주소 :"까지 먹고, 자리표시자부터
    줄 끝까지를 값으로 바꾸면서 닫는 괄호도 함께 지운다."""
    if text.count("(") > text.count(")"):
        return text + ")"
    return text


def _fill_contact_line(text: str, bare_re, label_re, value: str) -> str:
    """주소·전화 한 줄을 값으로 채운다. 못 채우면 원문 그대로 돌려준다.

    괄호로만 된 자리표시자를 먼저 본다. "(주소)"는 ADDRESS_LABEL_RE에도 걸리는데,
    라벨로 처리하면 "(주소) 서울특별시…"가 되어 안내문구가 남는다."""
    m = bare_re.match(text)
    if m:
        return m.group(1) + value
    m = label_re.match(text)
    if m:
        return _fill_labeled_slot(text, m, value)
    return text


def _fill_contact_info(doc, address: str = "", phone: str = "") -> tuple:
    """청구인의 주소·전화칸을 상담에서 받아둔 값으로 채운다.

    '청구인 것'만 채우는 게 핵심이다. 서식에는 주소칸이 여럿 있는데(청구인 주소,
    사망자 최후주소, 등록기준지) 전부 같은 자리표시자를 쓴다. 라벨만 보고 채우면
    살아 있는 청구인의 주소가 사망자의 최후주소로 들어간다.

    그래서 문단을 순서대로 읽으며 '지금 누구 구획인지'를 따라간다. 청구인 라벨이
    나오면 그 아래가 청구인 칸이고, 상대방·사건본인 라벨이 나오면 거기서 끝난다.

    각각 첫 칸만 채운다. 서식은 흔히 청구인 자리를 2개 두는데(공동청구인 대비)
    한 명인 사건에서 두 칸을 같은 주소로 채우면 없는 사람이 하나 생긴다
    (FIELD_PROMPT 8번과 같은 이유). 남는 칸은 C단계가 표시해 상담원에게 넘긴다.

    반환: (채운 칸 수, 바뀐 문단 텍스트 집합)"""
    address = (address or "").strip()
    phone = (phone or "").strip()
    if not address and not phone:
        return 0, set()

    filled, written = 0, set()
    address_done = not address
    phone_done = not phone

    for sec in doc.sections:
        in_applicant_block = False
        for p in sec.paragraphs:
            if address_done and phone_done:
                break
            runs = getattr(p, "runs", [])
            if not runs:
                continue
            text = "".join(getattr(x, "text", "") or "" for x in runs)
            if not text.strip():
                continue

            # 구획 판정은 라벨이 줄 앞쪽에 있을 때만 한다. "청구인들은 피상속인 망
            # △△△의 재산상속인으로서…" 같은 본문 문장이 구획을 바꾸면 안 된다.
            head = re.sub(r"\s+", "", text)[:12]
            if OTHER_BLOCK_RE.search(head):
                in_applicant_block = False
            elif APPLICANT_BLOCK_RE.search(head):
                in_applicant_block = True

            if not in_applicant_block:
                continue
            if FOREIGN_ADDRESS_LABEL_RE.search(text):
                continue

            new_text = text
            if not address_done:
                new_text = _fill_contact_line(
                    text, BARE_ADDRESS_PAREN_RE, ADDRESS_LABEL_RE, address)
                if new_text != text:
                    address_done = True
            if new_text == text and not phone_done:
                new_text = _fill_contact_line(
                    text, BARE_PHONE_PAREN_RE, PHONE_LABEL_RE, phone)
                if new_text != text:
                    phone_done = True

            if new_text != text and _set_paragraph_text(p, new_text):
                filled += 1
                written.add(new_text)

    return filled, written


# 상담에서 이름을 받지 않는 제3자의 칸. 급여를 주는 회사(소득세원천징수의무자),
# 예금을 가진 은행(제3채무자) 자리다. 당사자가 아니라서 extracted_json의 당사자
# 목록에 없고, 상담에도 상호만 스쳐 지나갈 뿐 법인명·대표자가 확정되지 않는다.
THIRD_PARTY_SLOT_RE = re.compile(r"소득세원천징수의무자|원천징수의무자|제3채무자|제삼채무자")

# 서식 맨 뒤 안내표의 행 이름. 관할·법규·수수료를 적어 둔 인쇄물이지 채울 칸이
# 아닌데, '기타'처럼 짧은 라벨이 당사자 칸처럼 보여 A단계가 이름을 넣는다.
#
# 라벨 전체가 일치할 때만 잡는다(219개 서식에 이런 행이 있어서 느슨하게 잡으면
# 정상 치환까지 휩쓴다). '첨부서류'는 넣지 않는다 — 아래에 실제로 채워야 하는
# 서류 목록이 붙는 진짜 항목이라, 안내표 행과 생김새만 같다.
FORM_GUIDE_ROW_RE = re.compile(
    r"^\(?(?:기타|관할법원|관련법규|제출부수|비용|불복절차|불복절차및기간)\s*[:：]?$")


def _drop_label_erasing_fills(replacements: list) -> tuple:
    """당사자 라벨을 지워버리는 A단계 치환을 버린다.

    라벨은 서식에 인쇄된 글자다. 이름은 그 옆 자리표시자에 들어가야 하는데,
    A단계가 라벨 자체를 이름으로 갈아치우는 일이 있다 — 양육비 직접지급명령
    신청서의 서명란에서 실측했다.

        원본:  채권자                󰂙 (서명    )
        맞음:  채권자                정미래 (서명    )
        틀림:  정미래                󰂙 (서명    )      ← 라벨이 사라졌다

    라벨이 없어지면 그 줄이 누구의 서명인지 알 수 없다. 당사자가 여럿인 서식에서는
    누구 칸인지 가릴 방법이 아예 없어진다.

    반환: (남길 치환 목록, 버린 자리 설명 목록)"""
    kept, dropped = [], []
    for r in replacements:
        before = re.sub(r"\s+", "", r.get("before", "") or "")
        after = re.sub(r"\s+", "", r.get("after", "") or "")
        lost = [rx.search(before).group(0)
                for rx in (APPLICANT_BLOCK_RE, OTHER_BLOCK_RE)
                if rx.search(before) and not rx.search(after)]
        if lost:
            dropped.append(f"당사자 라벨 삭제({'·'.join(lost)}): {r.get('before', '')[:30]}")
            continue
        kept.append(r)
    return kept, dropped


def _drop_third_party_slot_fills(replacements: list) -> tuple:
    """제3자 칸과 안내표 행을 채우는 A단계 치환을 버린다.

    양육비 직접지급명령 신청서에서 실측했다 — 소득세원천징수의무자 칸과 안내표의
    '기타' 행에 채무자 이름(한도현)이 들어갔다. 원천징수의무자는 급여를 주는
    회사(한빛물산)라 사람 이름이 올 자리가 아니다. 그 칸이 틀리면 압류명령이
    엉뚱한 상대에게 나간다 — _drop_contact_fills가 주소에서 막아 둔 사고가
    이름으로 재발한 것이다.

    회사명을 대신 채우지는 않는다. 상담에 "한빛물산"이 나왔더라도 법인명·대표자가
    확정되지 않았고 extracted_json에 그 칸이 없다. 이 파일이 주소에서 택한 것과
    같은 판단이다 — 틀린 값보다 빈 칸이 낫다. 비워 두면 C단계가
    [예시:확인필요]를 붙여 상담원에게 넘긴다.

    반환: (남길 치환 목록, 버린 자리 설명 목록)"""
    kept, dropped = [], []
    for r in replacements:
        before = r.get("before", "") or ""
        compact = re.sub(r"\s+", "", before)
        if THIRD_PARTY_SLOT_RE.search(compact):
            dropped.append(f"제3자 칸(상담에서 확정되지 않음): {before[:30]}")
            continue
        if FORM_GUIDE_ROW_RE.match(compact):
            dropped.append(f"안내표 행(채울 칸이 아님): {before[:30]}")
            continue
        kept.append(r)
    return kept, dropped


def _drop_contact_fills(replacements: list, *values: str) -> tuple:
    """주소·전화를 채우는 A단계 치환을 버린다. _fill_contact_info가 전담한다.

    A단계는 doc.replace_text_in_runs로 '일치하는 곳을 전부' 바꾼다. 그런데
    서식의 주소칸은 청구인 것도 채무자 것도 회사 것도 같은 모양이라("(주소)"),
    치환 하나가 세 칸을 전부 청구인 주소로 만든다. 양육비 직접지급명령
    신청서에서 실측했다 — 채무자와 소득세원천징수의무자(회사)의 주소가 전부
    채권자 집주소가 됐다. 압류명령이 회사로 가지 않고 채무자에게 송달도
    안 되는 문서다. _apply_repeated_name_slots가 이름칸에서 막아둔 것과
    똑같은 사고가 주소로 재발했다.

    원인은 프롬프트가 아니라 치환 방식이라 여기서 걷어낸다. 상담에서 받는
    주소·전화는 상담자 본인 것뿐이고(상대방이 어디 사는지는 모른다), 그 한
    칸은 당사자 구획을 따라가는 _fill_contact_info가 채운다. 나머지 칸은
    예전처럼 C단계가 [예시:확인필요]로 표시해 상담원에게 넘긴다.

    버린 치환은 unfilled에 넣지 않는다 — '못 채운 칸'이 아니라 뒤에서 제대로
    채우는 칸이라, 올리면 상담원에게 거짓 경고가 된다.

    반환: (남길 치환 목록, 버린 자리 설명 목록 — 로그·집계용)"""
    known = [re.sub(r"\s+", "", v) for v in values if v and len(v.strip()) >= 6]
    kept, dropped = [], []
    for r in replacements:
        before, after = r.get("before", "") or "", r.get("after", "") or ""
        reason = ""
        if CONTACT_SLOT_LABEL_RE.match(re.sub(r"\s+", "", before)):
            reason = "주소·전화칸"
        else:
            # GPT가 주소를 잘라 넣는 경우가 있어("경기도 수원시 팔달구 인계로 178")
            # 양쪽 방향으로 본다. 짧은 값은 우연히 겹친다 — "수원"만으로 지우면
            # "수원가정법원"을 채우는 정상 치환까지 버린다.
            a = re.sub(r"\s+", "", after)
            if len(a) >= 6 and any(v in a or a in v for v in known):
                reason = "상담자 연락처"
        if reason:
            dropped.append(f"{reason}(당사자 구획 보고 채움): {before[:30]}")
            continue
        kept.append(r)
    return kept, dropped


# ══════════════════════════════════════
# 본인이 직접 적는 칸
# ══════════════════════════════════════
# 주민등록번호는 시스템에 저장하지 않는다. 개인정보 보호법 제24조의2는 주민등록번호를
# 동의가 아니라 '법령에 구체적 근거가 있을 때'만 처리하도록 하고 있어서, 내담자가
# 동의해도 우리가 보관할 수 없다.
#
# 그런데 그냥 비워두면 초안을 받은 사람은 그 칸이 이미 처리된 것인지, AI가 놓친
# 것인지 알 수 없다. [예시:확인필요]와 구분되는 표시를 붙여 '일부러 비워둔 자리'임을
# 밝힌다 — 본인 확인(신분증·가족관계증명서)을 거쳐 손으로 적어야 하는 값이다.
SELF_WRITTEN_TAG = " [직접 기재]"

# 줄 안 어디에 있든 잡는다. 이름 뒤에 괄호로 붙는 경우("○ ○ ○(주민등록번호)")와
# 한 줄짜리 항목("주민등록번호 :             -") 둘 다 있다.
SELF_WRITTEN_FIELD_RE = re.compile(r"주민\s*등록\s*번호|주민번호")


# 서식 배포처가 붙여 둔 표시. 신청서 내용이 아니라 서식집을 위한 꼬리표라,
# 법원에 내는 문서에 찍히면 안 된다. 자리표시자가 없어 C단계 정규식에 안 걸리고
# 서술체가 아니라 B단계 탐지에도 안 걸려서 그대로 남았다.
#
#   맨 끝  "●●●분류표시 : 가사소송 >> 양육비직접지급명령"   (291개 중 7개)
#   맨 앞  "[서식 예] 양육비 직접지급명령 신청서"            (표본 60개 중 58개)
FORM_METADATA_RE = re.compile(r"^[\s●○■□▶◆·]*분류표시\s*[:：]")
FORM_SAMPLE_HEAD_RE = re.compile(r"^\s*[\[【]\s*서식\s*[^\]】]{0,12}[\]】]\s*")


def _norm_ws(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def _remove_form_metadata_lines(doc) -> int:
    """서식집용 표시를 걷어낸다.

    표시만 붙이지 않고 지우는 이유: 상담원이 판단할 여지가 없는 줄이다.
    [확인필요]를 달아 두면 "무엇을 확인하라는 거지"를 매번 되묻게 된다.

    머리줄("[서식 예] …")은 두 경우로 갈린다. 뒤에 같은 제목이 다시 나오는
    서식(표본 18개)은 줄째로 지우고, 머리줄이 유일한 제목인 서식(표본 40개)은
    표시만 떼고 제목을 남긴다 — 통째로 지우면 제목 없는 문서가 된다."""
    paragraphs = [p for sec in doc.sections for p in sec.paragraphs]
    texts = ["".join(getattr(r, "text", "") or "" for r in getattr(p, "runs", []))
             for p in paragraphs]
    removed = 0
    for index, (p, text) in enumerate(zip(paragraphs, texts)):
        if not getattr(p, "runs", []):
            continue
        if FORM_METADATA_RE.match(text):
            if _set_paragraph_text(p, ""):
                removed += 1
            continue
        head = FORM_SAMPLE_HEAD_RE.match(text)
        if not head:
            continue
        title = text[head.end():].strip()
        elsewhere = {_norm_ws(t) for i, t in enumerate(texts) if i != index}
        keep_title = bool(title) and _norm_ws(title) not in elsewhere
        if _set_paragraph_text(p, title if keep_title else ""):
            removed += 1
    return removed


def _tag_self_written_fields(doc) -> int:
    """주민등록번호 칸에 '직접 기재' 표시를 붙인다.

    이 표시는 C단계(_mark_unresolved_examples)보다 먼저 붙여야 한다. 그래야
    같은 줄에 [예시:확인필요]가 겹쳐 붙지 않는다 — C단계는 태그가 있는 문단을
    건너뛴다."""
    marked = 0
    for sec in doc.sections:
        for p in sec.paragraphs:
            runs = getattr(p, "runs", [])
            if not runs:
                continue
            text = "".join(getattr(r, "text", "") or "" for r in runs)
            if not SELF_WRITTEN_FIELD_RE.search(text):
                continue
            if SELF_WRITTEN_TAG.strip() in text or PARA_EXAMPLE_TAG.strip() in text:
                continue
            _tag_paragraph(runs)
            # _tag_paragraph는 [예시:확인필요]를 붙인다. 여기서는 다른 표시를 써야
            # 하므로 방금 붙인 것을 바꿔 단다.
            runs[-1].text = (runs[-1].text or "").replace(
                PARA_EXAMPLE_TAG, SELF_WRITTEN_TAG)
            marked += 1
    return marked


# 서식의 날짜 라벨 ← 분석이 뽑는 날짜 '항목' 이름. 항목명은 사건마다 달라서
# (사망 / 사망일 / 사망일자 …) 포함으로 맞춘다.
DATE_LABEL_KEYS = (
    ("사망일자", ("사망",)),
    ("사망일", ("사망",)),
    ("생년월일", ("생년월일", "출생")),
    ("혼인일자", ("혼인", "결혼")),
    ("계약일자", ("계약",)),
    ("계약일", ("계약",)),
)

# "20○○. ○. ○." / "20○○년 ○월 ○일" 두 모양을 쓴다. 어느 쪽이든 원래 모양을 지켜 채운다.
DATE_PLACEHOLDER_DOT_RE = re.compile(r"(?:19|20)○○\s*\.\s*○+\s*\.\s*○+\s*\.?")
DATE_PLACEHOLDER_KOR_RE = re.compile(r"(?:19|20)○○\s*년\s*○+\s*월\s*○+\s*일")


def _extracted_dates(extracted: dict) -> list:
    """추출정보의 날짜 목록을 (항목, 연, 월, 일)로 정규화한다."""
    out = []
    for item in (extracted or {}).get("날짜", []) or []:
        if not isinstance(item, dict):
            continue
        label = str(item.get("항목", "")).strip()
        raw = str(item.get("값", "")).strip()
        m = re.search(r"((?:19|20)\d\d)\D+(\d{1,2})\D+(\d{1,2})", raw)
        if not (label and m):
            continue    # 연·월·일이 다 있어야 채운다. "7월 초" 같은 값은 못 쓴다.
        out.append((label, int(m.group(1)), int(m.group(2)), int(m.group(3))))
    return out


def _fill_known_dates(doc, extracted: dict) -> int:
    """라벨이 분명한 날짜칸을 추출된 날짜로 채운다.

    라벨 없이 홀로 있는 날짜칸(서명란 위 작성일자)은 건드리지 않는다 — 그건 사건
    사실이 아니라 상담원이 제출하는 날 직접 적는 칸이라, 임의로 채우면 안 된다
    (FIELD_PROMPT 6번과 같은 이유). 라벨을 요구하는 것으로 자연히 걸러진다."""
    dates = _extracted_dates(extracted)
    if not dates:
        return 0

    filled = 0
    for sec in doc.sections:
        for p in sec.paragraphs:
            runs = getattr(p, "runs", [])
            if not runs:
                continue
            text = "".join(getattr(r, "text", "") or "" for r in runs)
            compact = re.sub(r"\s+", "", text)
            for form_label, keys in DATE_LABEL_KEYS:
                if form_label not in compact:
                    continue
                hit = next((d for d in dates
                            if any(k in d[0] for k in keys)), None)
                if not hit:
                    continue
                _, y, mo, d = hit
                if DATE_PLACEHOLDER_DOT_RE.search(text):
                    new_text = DATE_PLACEHOLDER_DOT_RE.sub(
                        f"{y}. {mo}. {d}.", text, count=1)
                elif DATE_PLACEHOLDER_KOR_RE.search(text):
                    new_text = DATE_PLACEHOLDER_KOR_RE.sub(
                        f"{y}년 {mo}월 {d}일", text, count=1)
                else:
                    break
                if new_text != text and _set_paragraph_text(p, new_text):
                    filled += 1
                break
    return filled


def _fill_known_role_names(doc, replacements: list, seeded: dict = None) -> int:
    """이미 확정된 역할별 이름으로, 아직 남은 같은 역할의 이름칸을 채운다.

    GPT가 당사자란은 채우고 서명란("위 신청인 ○ ○ ○ (인)")은 빠뜨리는 일이
    잦다. 같은 문서에서 같은 역할이면 같은 사람이므로, 이건 판단이 아니라
    복사다 — 코드가 한다.

    라벨이 있는 문단만 대상으로 하고, 이름 자리표시자 형태에만 쓴다.
    "유 언 자 □ □ □"처럼 우리가 역할을 모르는 칸은 건드리지 않는다."""
    # 상담 기록의 확정 값이 먼저다. GPT가 요약문에서 추론한 값보다 믿을 수 있다.
    role_names = dict(seeded or {})
    for r in replacements:
        role = (r.get("role") or "").strip()
        if role not in ROLE_LABELS:
            continue
        name = _inserted_name(r.get("before", ""), r.get("after", ""))
        # 이름이 아니라 주소·날짜 조각이 잡히는 경우를 걸러낸다.
        if name and 2 <= len(name) <= 20 and not PLACEHOLDER_RE.search(name):
            role_names.setdefault(role, name)

    if not role_names:
        return 0

    filled = 0
    for sec in doc.sections:
        for p in sec.paragraphs:
            runs = getattr(p, "runs", [])
            if not runs:
                continue
            text = "".join(getattr(r, "text", "") or "" for r in runs)
            if not NAME_PLACEHOLDER_RE.search(text):
                continue
            if NON_NAME_LINE_RE.search(text):
                continue    # "신청인 주소 : ○○시 ○○구" 같은 줄에 이름을 넣지 않는다
            # 서식은 라벨 글자 사이를 벌려 쓴다("청 구 인", "상 대 방").
            # 공백을 걷어내고 비교하지 않으면 못 알아본다 — 실제로 친권 일부제한
            # 심판청구서에서 "사건본인"(붙어 있음)만 채워지고 "청 구 인"·"상 대 방"이
            # 빈 채로 나갔다.
            # 자리표시자 바로 앞에 사망 표시가 있으면 그 칸의 주인은 사망자다.
            # "청구인들의 망 ○○○에 대한 재산상속포기 신고는 이를 수리한다"는 줄에
            # '청구인'이 들어 있다는 이유로 청구인 이름을 넣으면, 살아 있는 청구인이
            # 자기 상속을 포기당하는 문서가 된다(실측 사고).
            #
            # 잘라낸 앞부분에서 찾으면 안 된다 — DECEASED_LABEL_RE의 '망'은 뒤에 이름이나
            # 자리표시자가 와야 성립하는데, 자리표시자를 잘라내면 그 조건이 깨져 못 찾는다.
            # 자리표시자까지 포함해 찾고, 그 앞에서 시작했는지로 판단한다.
            ph = NAME_PLACEHOLDER_RE.search(text)
            slot_deceased = False
            if ph:
                dm = DECEASED_LABEL_RE.search(text[:ph.end()])
                slot_deceased = bool(dm and dm.start() < ph.start())

            compact = re.sub(r"\s+", "", text)
            for role, name in role_names.items():
                # 사망자 칸에는 산 사람 역할(청구인·상대방)을 넣지 않는다.
                # 사건본인은 서식에 따라 사망자 본인이므로 그대로 채운다.
                if slot_deceased and role in ("청구인", "상대방"):
                    continue
                if not any(label in compact for label in ROLE_LABELS[role]):
                    continue
                # 이미 이름이 들어 있으면 건드리지 않는다. A단계가 자리표시자를
                # 다 지우지 못한 채 이름만 끼워 넣는 경우가 있어("신 청 인 남기훈
                # ○ ○ ○"), 그대로 두면 "신 청 인 남기훈  남기훈"이 된다.
                if name in text:
                    break
                new_text = NAME_PLACEHOLDER_RE.sub(name, text, count=1)
                if new_text != text and _set_paragraph_text(p, new_text):
                    filled += 1
                break
    return filled


# ══════════════════════════════════════
# 메인
# ══════════════════════════════════════
def draft(form_name, extracted, summary="", applicant_name="", opponent_name="",
          applicant_address="", applicant_phone=""):
    """applicant_name / opponent_name은 상담 접수 때 적어둔 확정 값이다
    (core-api Consultation.clientName / opponentName). 주면 이름칸을 코드가
    직접 채우고, 안 주면 지금까지처럼 GPT 결과에서 역할별 이름을 뽑아 쓴다.

    applicant_address / applicant_phone도 같은 성격이다. 다만 이 둘은 서식 작성에
    대한 동의를 받았을 때만 core-api가 값을 갖고 있어서, 동의가 없으면 빈 문자열이
    온다 — 여기서 동의를 다시 검사하지 않는 이유다.

    주민등록번호는 인자로 받지 않는다. 개인정보 보호법 제24조의2가 동의가 아니라
    법령 근거를 요구해서 저장 자체를 하지 않고, 그 칸은 '직접 기재' 표시만 붙인다."""
    src = find_hwpx(form_name)
    if src is None:
        return {"file": None, "error": f"서식 파일 없음: {form_name}",
                "applied": 0, "missed": [], "unfilled": [],
                "rewritten_count": 0, "rewrite_rejected": []}

    doc = HwpxDocument.open(str(src))
    md = _extract_markdown(doc)

    # 서식과 무관한 덩치(분석 응답 사본·STT 원문 등)를 먼저 걷어낸다.
    extracted, dropped_keys = _trim_extracted_for_draft(extracted)

    # 상담원이 확인한 이름을 가장 먼저 반영한다. 이 아래 모든 단계(치환 생성,
    # 표 채우기, 서술 문단 작성)가 추출정보를 각자 다시 읽으므로, 여기서 안
    # 고치면 단계마다 다른 이름이 들어가 한 문서에 두 사람이 섞인다.
    extracted, name_corrections = _apply_confirmed_names_to_extracted(
        extracted, applicant_name, opponent_name)

    # ── A. 정형 치환 ──
    gpt = _generate_fields(md, extracted, summary)
    reps = gpt.get("replacements", [])
    unfilled = gpt.get("unfilled", [])

    # 역할을 모른 채 이름칸을 채운 치환은 버린다(엉뚱한 사람이 올라간다).
    reps, dropped_names = _drop_unidentified_name_fills(reps, extracted)
    unfilled.extend(dropped_names)

    # 이름칸에 이름이 아닌 지칭어가 들어간 치환은 버린다("첫째, 둘째").
    reps, dropped_nonname = _drop_non_name_person_fills(reps)
    unfilled.extend(dropped_nonname)

    # 자리표시자를 지우는 대신 뒤에 이어 붙이는 치환은 버린다
    # ("신 청 인" → "신 청 인 남기훈"). 정상 치환과 겹치면 이름이 두 번 들어간다.
    reps = _drop_append_only_fills(reps)

    # 상담에 없는 연도·금액을 채우는 치환은 버린다. 지어낸 값은 자리표시자를
    # 지워버려서 C단계 표시조차 안 붙는다 — 확정된 값처럼 보이는 게 제일 위험하다.
    reps, dropped_values = _drop_unfounded_value_fills(reps, extracted, summary)
    unfilled.extend(dropped_values)

    # 서류를 내는 사람을 사망자 자리에 넣는 치환은 버린다(청구인=피상속인 모순).
    # 상담기록의 확정 청구인 이름과 추출정보의 청구인도 함께 넘긴다 — GPT 치환에만
    # 기대면 그 이름이 치환에 안 잡힌 경우 필터가 통째로 꺼진다.
    reps, dropped_contra = _drop_self_contradicting_fills(
        reps, _known_names_by_role(extracted, LIVING_KEY_RE) | {applicant_name})
    unfilled.extend(dropped_contra)

    # 사망자 이름은 추출정보에 명시됐을 때만 채운다. 관계만 적힌 상담("부친이
    # 사망")에서 LLM이 다른 등장인물을 끌어다 쓰는 사고가 반복됐다.
    reps, dropped_dead = _drop_unfounded_deceased_fills(reps, extracted)
    unfilled.extend(dropped_dead)

    # 주소·전화는 A단계에 맡기지 않는다. 일괄 치환이 당사자를 구분하지 못해
    # 청구인 주소가 채무자·회사 칸까지 번진다(_drop_contact_fills 주석 참고).
    # unfilled에 올리지 않는다 — 아래 _fill_contact_info가 청구인 칸을 채운다.
    reps, dropped_contact = _drop_contact_fills(
        reps, applicant_address, applicant_phone)

    # 원천징수의무자(회사)·제3채무자 칸과 안내표 행에는 사람 이름을 넣지 않는다.
    # 여기는 unfilled에 올린다 — 뒤에서 대신 채우는 단계가 없어 정말로 빈 칸이고,
    # 상담원이 회사명을 확인해 적어야 하는 자리다.
    reps, dropped_third = _drop_third_party_slot_fills(reps)
    unfilled.extend(dropped_third)

    # 라벨을 이름으로 갈아치우는 치환은 버린다("채권자 󰂙" → "정미래 󰂙").
    # 버린 뒤에도 그 칸은 비지 않는다 — _fill_known_role_names가 라벨을 보고
    # 자리표시자 쪽에 이름을 넣는다. unfilled에 올리지 않는 이유다.
    reps, dropped_label = _drop_label_erasing_fills(reps)

    # TODO: 서식의 예시 당사자가 실제 당사자보다 많을 때 남는 자리를 같은 사람으로
    # 메우는 문제(_drop_surplus_person_fills)는 아직 연결하지 않는다. 중복 치환을
    # 버리는 것까지는 정확히 동작하지만, 그렇게 비운 자리를 뒤의 모양 기반 채우기
    # (_grow_name_slot_groups)가 역할을 보지 않고 다음 이름으로 메워버린다 —
    # 유류분반환청구의 소에서 원고 2번 자리에 피고(장대우)가 들어갔다.
    # 한 사람이 여러 자리를 차지하는 것보다 상대방이 청구인 자리에 오는 쪽이
    # 훨씬 위험하므로, 채우기 단계가 역할을 인식하게 고친 뒤에 함께 켠다.

    # 이 사건의 당사자 이름을 문서 순서대로. 칸을 나눌 때도, 칸이 모자라 늘릴
    # 때도 같은 목록을 써야 순서가 어긋나지 않는다.
    people = _collect_person_names(reps)

    # 같은 문구가 여러 줄 반복되는 이름칸(공동상속인 서명란 등)은 사람별로
    # 나눠 채운다. _apply_fields의 일괄 치환에 맡기면 전원이 같은 이름이 된다.
    repeated_handled, repeated_filled, repeated_texts, slot_overflow = (
        _apply_repeated_name_slots(doc, reps))
    reps = [r for r in reps if r not in repeated_handled]
    unfilled.extend(slot_overflow)

    applied, missed = _apply_fields(doc, reps)
    applied += repeated_filled

    # 확정된 역할 이름으로 같은 역할의 남은 이름칸을 채운다(서명란 등).
    # GPT가 빠뜨리는 자리라, 판단이 아니라 복사인 부분만 코드가 맡는다.
    role_filled = _fill_known_role_names(
        doc, reps, _seed_role_names(applicant_name, opponent_name, extracted))
    applied += role_filled

    # 라벨이 분명한 날짜칸("사망일자   20○○. ○. ○.")을 추출된 날짜로 채운다.
    # 이름과 같은 이유다 — GPT가 자주 빠뜨리는데, 추출정보에 값이 있으면 판단이
    # 아니라 옮겨 적기다.
    date_filled = _fill_known_dates(doc, extracted)
    applied += date_filled

    # 긴 서술 문단 안에 남은 이름칸을 확정된 이름으로 채운다(A단계는 긴 문단을
    # 대상에서 빼고, B단계는 법조문·신청취지에서 손을 떼므로 그 사이가 빈다).
    narr_filled, narr_texts = _fill_names_in_narrative(doc, reps)
    applied += narr_filled

    # 청구취지·청구원인의 "망 △△△"처럼 사망 표시 뒤에 남은 이름칸을 채운다.
    # 문장은 건드리지 않는다 — 청구취지는 정형 문구라 다시 쓰면 청구가 사라진다.
    deceased_filled, deceased_texts = _fill_deceased_name_slots(doc, extracted)
    applied += deceased_filled

    # 청구인의 주소·전화칸. 법원 서식의 당사자 주소는 송달을 위한 법정 필수
    # 기재사항이라, 비어 있으면 상담원이 초안을 받아 손으로 다시 채워야 한다.
    #
    # 값은 core-api가 넘겨준 것만 쓴다. 분석이 상담에서 뽑아낸 값(extracted_json의
    # 주소·전화번호)은 화면에서 상담원이 확인·수정한 뒤 core-api에 저장되고, 그것이
    # 여기로 온다 — 받아쓰기가 숫자를 자주 틀려서 사람이 한 번 보는 단계를 거친다.
    contact_filled, contact_texts = _fill_contact_info(
        doc, applicant_address, applicant_phone)
    applied += contact_filled

    narr_texts = set(narr_texts) | deceased_texts | contact_texts

    # 값이 다 들어간 뒤, 사람 수보다 칸이 적으면 마지막 칸을 복제해 늘린다.
    # (상속인 4명인데 성명칸·배분항목이 3벌뿐인 협의서 등)
    grown_texts, grown_slots = _grow_name_slot_groups(doc, people)
    applied += grown_slots
    repeated_texts = set(repeated_texts) | grown_texts | narr_texts

    # ── E. 표 셀 채우기 ──
    # 표 안 문단은 A/B/C/D 어느 단계도 못 본다(별도 구조) — 문서 순서로
    # 표 객체를 수집해 읽기(get_table_map)/쓰기(set_cell_text) 인덱스를 맞춘다.
    table_objs = _collect_tables(doc)
    tables_meta = doc.get_table_map().get("tables", []) if table_objs else []
    table_gpt = _generate_table_fields(tables_meta, extracted, summary)
    table_applied, table_missed, table_filled_keys = _apply_table_fields(
        table_objs, table_gpt.get("cell_replacements", []), tables_meta)
    # 채운 뒤에도 남은 표 셀(자리표시자·원본 예시 인물 등) 표시.
    # tables_meta는 채우기 전 스냅샷이라 안전장치는 여기서 최신 상태를
    # 다시 읽어 판단해야 하지만, set_cell_text로 바뀐 셀은 filled_keys로
    # 이미 제외되므로 기존 tables_meta 그대로 써도 무방하다.
    table_marked = _mark_unresolved_table_cells(
        table_objs, tables_meta, table_filled_keys, extracted, summary)

    # ── B. 예시문단 재서술 ──
    examples = _find_example_paragraphs(doc)   # [(para, text), ...]
    rewritten_count = 0
    rewrite_rejected = []
    # A단계에서 사람별로 나눠 채운 이름칸도 '우리가 쓴 줄'이다. 여기 안 넣으면
    # C단계가 "성 명  조민석"을 서식 제작자의 예시 인물로 오인해 방금 채운
    # 값에 [예시:확인필요]를 붙인다 — 실제로 그렇게 나왔다.
    rewritten_texts = set(repeated_texts)
    blanked_count = 0

    # 예시 문단 사이에 낀 한두 줄(증거 인용 등)도 원본 사연의 일부다.
    # 서술체가 아니라 B단계 탐지에 안 걸리고, 자리표시자도 없어 C단계
    # 정규식에도 안 걸린다. 실제로 "｛갑 제1 호증의 1,2 (각 혼인관계증명서)...｝"가
    # 우리 사건 문단 사이에 그대로 남았다 — 우리가 내지도 않을 증거를
    # 가리키는 줄이다. 표시만 붙여 상담원이 보게 한다.
    #
    # 아래 재서술보다 먼저 해야 한다. 재서술이 끝나면 예시 문단의 텍스트가
    # 새 내용으로 바뀌어, 어디가 예시 블록이었는지 되짚을 수 없다.
    interstitial_marked = _tag_interstitial_examples(doc, {t for (_, t) in examples})

    if examples:
        texts = [t for (_, t) in examples]
        new_texts = _rewrite_examples(texts, extracted, summary, _detect_party_terms(doc))
        new_texts = _selfcheck_and_revise(new_texts, extracted, summary)
        years, money = _allowed_facts(extracted, summary)
        for (para, orig_text), new_text in zip(examples, new_texts):
            # 재서술에 실패한 문단은 '원본을 그대로 두는' 게 가장 나쁜 선택이다.
            # 원본은 서식 제작자가 넣은 남의 사연이라, 그대로 남으면 우리 사건
            # 문장 사이에 남의 사실이 섞여 들어간다. 실제로 친권행사자 변경
            # 서식에서 "협의 이혼시 청구인은 경제적 능력이 없어..."라는 원본
            # 문단이 남아, 바로 아래 우리 사건 문단("월 소득 300만 원")과
            # 정면으로 모순됐다. 비어 있는 것보다 나쁘다 — 상담원이 읽어도
            # 우리 사건 서술로 보이기 때문에 걸러낼 수가 없다.
            #
            # 그래서 실패하면 자리를 비우고 표시만 남긴다. 근거 없는 문단을
            # 지어내지 않는다는 원칙은 그대로 지키면서, 남의 사실이 남는 것만
            # 막는다.
            if not new_text or not new_text.strip():
                unfilled.append(f"서술문단(근거부족·상담원작성): {orig_text[:25]}")
                if _set_paragraph_text(para, NARRATIVE_UNFILLED_TEXT):
                    blanked_count += 1
                continue
            viol = _verify_rewrite(new_text, years, money)
            if viol:
                rewrite_rejected.append({"orig": orig_text[:25], "violations": viol})
                unfilled.append(f"서술문단(검증탈락·상담원작성): {orig_text[:25]}")
                if _set_paragraph_text(para, NARRATIVE_UNFILLED_TEXT):
                    blanked_count += 1
                continue
            # 항번호는 검증을 통과한 뒤에 되살린다 — 앞에 붙이면 _verify_rewrite가
            # 그 숫자를 본문의 금액·연도로 오인할 수 있다.
            new_text = _keep_list_number(orig_text, new_text)
            if _set_paragraph_text(para, new_text):
                rewritten_count += 1
                rewritten_texts.add(new_text)

    # 예시 문장 없이 비워둔 서술란(청구이유 등)에 사건 내용을 써넣는다.
    # B단계는 '있는 문장을 바꾸는' 일만 하므로 빈 칸은 여기서 채운다.
    empty_section_filled = _fill_empty_narrative_section(doc, extracted, summary)

    # 주민등록번호 칸은 시스템이 채우지 않는다 — 저장하지 않는 값이라 채울 수가 없다.
    # C단계보다 먼저 표시해야 [예시:확인필요]와 겹치지 않는다(C단계는 태그가 붙은
    # 문단을 건너뛴다). '못 채운 것'이 아니라 '일부러 비워둔 것'임을 밝히는 표시다.
    self_written_marked = _tag_self_written_fields(doc)

    # 서식 배포처의 관리용 표시를 지운다. C단계보다 먼저 지워야 빈 줄에
    # [예시:확인필요]가 붙지 않는다.
    metadata_removed = _remove_form_metadata_lines(doc)

    # ── C. 최후 안전장치: 처리 후에도 남아있는 원본 예시 표시 ──
    marked_examples = _mark_unresolved_examples(doc, rewritten_texts, extracted, summary)

    out = OUTPUT / f"{src.stem}_초안.hwpx"
    try:
        doc.save_to_path(str(out))
    except PermissionError:
        out = OUTPUT / f"{src.stem}_초안_{time.strftime('%H%M%S')}.hwpx"
        doc.save_to_path(str(out))

    # ── D. 인명·지명 환각 최종 점검 ──
    # 지금까지의 검증은 날짜·금액(정규식)과 예시 사연 잔존(자리표시자/GPT분류)만
    # 다뤘다 — 사람 이름·지명·기관명이 새로 지어지는 건 사각지대였다.
    # 초안 전체를 GPT에게 다시 보여줘 문맥적으로 한 번 더 점검한다.
    judge = llm_judge(str(out), extracted, summary)

    return {"file": str(out), "error": None,
            "applied": applied, "missed": missed, "unfilled": unfilled,
            "rewritten_count": rewritten_count, "rewrite_rejected": rewrite_rejected,
            # 재서술이 안 돼 원본을 지우고 "상담원 작성" 자리로 바꾼 문단 수.
            # rewritten_count와 합치면 예시 문단이 몇 개였는지가 된다.
            "blanked_count": blanked_count,
            # 예시 문장 없이 비어 있던 서술란에 새로 써넣은 칸 수.
            "empty_section_filled": empty_section_filled,
            # 예시 문단 사이에 끼어 있어 표시만 붙인 줄 수(증거 인용 등).
            "interstitial_marked": interstitial_marked,
            # 지운 서식 관리용 표시 줄 수("●●●분류표시 : …").
            "metadata_removed": metadata_removed,
            # 역할별 이름으로 코드가 직접 채운 칸 수(서명란 등)와,
            # 역할을 몰라 채우지 않고 비워둔 이름칸 수.
            "role_filled": role_filled,
            # 사망 표시 뒤 이름칸("망 △△△")에 사망자 이름을 채운 횟수.
            "deceased_filled": deceased_filled,
            # 청구인 주소·전화칸을 채운 수. 0이 계속 나오면 동의를 안 받았거나
            # core-api가 값을 안 보내고 있다는 신호다.
            "contact_filled": contact_filled,
            # A단계가 주소·전화칸에 손대려던 것을 걷어낸 수. 0이 아니어도
            # 정상이다 — 그 칸은 _fill_contact_info가 청구인 것만 채운다.
            "contact_fills_dropped": len(dropped_contact),
            # 주민등록번호처럼 시스템이 채우지 않고 표시만 붙인 칸 수.
            "self_written_marked": self_written_marked,
            # 상담원이 확인한 이름으로 분석값을 고친 횟수.
            # 0이 계속 나오면 core-api가 이름을 안 보내고 있다는 신호다.
            "name_corrections": name_corrections,
            # 서식과 무관해서 프롬프트에서 걷어낸 추출정보 키 수.
            "trimmed_keys": dropped_keys,
            "dropped_name_fills": len(dropped_names),
            "gpt_count": len(reps), "field_generation_error": gpt.get("error"),
            "marked_examples": marked_examples,
            "llm_hallucination": judge.get("hallucination", []),
            "llm_role_swap": judge.get("role_swap", []),
            "table_count": len(table_objs), "table_applied": table_applied,
            "table_missed": table_missed, "table_marked": table_marked,
            "table_generation_error": table_gpt.get("error")}


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    extracted = {
        "청구인": {"이름": "박지연", "관계": "처"},
        "상대방": {"이름": "최민호", "관계": "부"},
        "사건본인": {"이름": "최서준", "나이": 8},
        "혼인일": "2016-05-14", "위자료청구액": 30000000,
        "이혼사유": "도박, 폭언",
    }
    summary = ("혼인 10년차. 배우자의 도박과 지속적 폭언으로 혼인관계 파탄. "
               "이혼과 함께 위자료 3천만원 청구 희망. 8세 자녀 1명 양육권도 원함.")
    print(json.dumps(draft("이혼 및 위자료 조정신청서", extracted, summary),
                     ensure_ascii=False, indent=2))
