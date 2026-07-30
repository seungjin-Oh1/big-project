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
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
client = OpenAI()

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

# extracted에서 "값을 모른다"를 뜻하는 표기들.
# schemas/analysis.py의 Party.이름이 "확인 불가능하면 '미상'"으로 정의돼 있어서,
# 이름을 모르는 당사자도 extracted에는 "미상"이라는 문자열로 들어온다.
# 프롬프트 규칙은 "extracted에 명시된 값만 사용"이라 모델이 이걸 실제 값으로 보고
# 문서에 써버린다 — 실제로 "미상시 미상구 미상동 미상 대 300㎡"가 나왔다.
# 값이 아니라 빈칸 표시로 취급해야 한다.
# 어디에 섞여 있어도 '모른다'는 뜻인 말. 문장 중간에 들어가도 걸러야 한다 —
# 치환값이 문장 통째로 오는 경우가 많아서(예: "대 200㎡는 미상의 소유로 한다"),
# 값 전체나 쉼표 조각만 비교하면 이런 게 그대로 문서에 박힌다.
_UNKNOWN_SUBSTRINGS = ("미상", "불명", "확인불가", "확인 불가", "알 수 없음")
# 값 전체가 이것과 같을 때만 '모른다'로 본다. "-"는 날짜(2026-05-15)에도 쓰이고
# "없음"은 정상 문장에도 나올 수 있어서 부분 일치로 막으면 오탐이 난다.
_UNKNOWN_EXACT = ("없음", "-", "해당없음", "해당 없음")

_UNKNOWN_VALUES = set(_UNKNOWN_SUBSTRINGS) | set(_UNKNOWN_EXACT)


def _is_unknown_value(value) -> bool:
    """치환값에 '모른다'는 표기가 들어있는지.

    값 전체가 "미상"인 경우뿐 아니라 문장 중간에 섞인 경우도 걸러낸다.
    실제로 나온 사례들:
      "이도영, 미상, 미상"                  당사자 세 명을 한 자리에 넣으면서
      "대 200㎡는 미상의 소유로 한다"        문장 통째로 치환하면서

    아는 사람만 남기고 나머지를 채우는 건 자리 특정이 안 되니,
    통째로 비워 상담원이 채우게 한다.
    """
    if value is None:
        return True
    text = re.sub(r"\s+", " ", str(value)).strip()
    if not text:
        return True
    if any(word in text for word in _UNKNOWN_SUBSTRINGS):
        return True
    return text in _UNKNOWN_EXACT


# ══════════════════════════════════════
# A. 정형 치환용 GPT 프롬프트 (자리표시자 값 채우기만)
# ══════════════════════════════════════
FIELD_PROMPT = """너는 법률 서식의 자리표시자를 실제 값으로 바꾸는 치환목록을 만든다.

규칙:
1. 서식 원문 문구는 바꾸지 않는다. 자리표시자(○○○, ○ ○ ○, □□□, △△△,
   20○○ 등)만 값으로 치환한다.
2. extracted에 명시된 값만 사용. 없으면 unfilled에만 넣는다.
   날짜·금액·주소·주민번호는 정확한 값 없으면 절대 치환하지 않는다.
2-1. "미상", "불명", "확인불가", "알 수 없음"은 값이 아니라 '아직 모른다'는 표시다.
   이런 값으로는 절대 치환하지 말고 unfilled에 넣는다. 문서에 "미상"이라고
   적혀 나가면 안 된다. "미상(부친)"처럼 괄호 설명이 붙어 있어도 마찬가지다.
3. before는 자리표시자 주변 라벨을 포함해 원문에서 유일하게 특정되게 복사
   ("신 청 인   ○  ○  ○" 처럼). 여러 줄에 걸친 긴 서술 문단은 대상 아님
   (그건 별도 처리하므로 여기선 무시).
4. role을 반드시 붙인다: 청구인/상대방/사건본인/기타.
   신청인=청구인, 피신청인=상대방, 원고=청구인, 피고=상대방.
   청구인 자리에 상대방 값을 넣는 것은 최악의 오류다.
5. 같은 사람 이름이 당사자란과 서명란("위 신청인")에 각각 나오면
   각각 별도 항목으로 만든다 (각 위치의 주변 라벨을 before에 포함).
5-1. 다만 이름 자리가 여러 개라고 해서 같은 이름을 반복해 넣지 마라.
   상속재산분할협의서처럼 공동상속인 여러 명이 각자 서명하는 서식에서는
   성명 칸 3개가 서로 다른 세 사람이다. extracted의 당사자와 1:1로 맞을 때만
   채우고, 누구 자리인지 특정할 수 없으면 통째로 unfilled로 남긴다.
   한 사람 이름을 여러 사람 자리에 복사하는 것은 사실을 왜곡하는 오류다.
6. 서명란 바로 위의 작성일자("20○○년   ○월   ○일" 형태로 "위 신청인/원고 (인)"
   바로 앞에 있는 날짜)는 절대 채우지 않는다. 이건 사건 사실의 날짜가 아니라
   상담원이 실제 제출하는 날 직접 적는 칸이다. 임의로 오늘 날짜 비슷한 값을
   지어내 채우는 것은 명백한 오류이며, 다른 어떤 규칙보다 우선한다.
7. 자리표시자가 요구하는 정밀도(연/월/일)까지 extracted에 정확히 다 있을 때만
   채운다. extracted에 "2026-01"처럼 연-월까지만 있는데 자리표시자가
   "20○○. ○. ○."처럼 일(day)까지 요구하면, 없는 일자를 지어내 채우지 말고
   통째로 unfilled로 남긴다. 부분적으로 아는 값의 나머지를 추측하는 것도
   지어내는 것과 같은 오류다.

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
        resp = client.chat.completions.create(
            model=MODEL,
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
1-1. "미상", "불명", "확인불가", "알 수 없음"은 값이 아니라 '아직 모른다'는 표시다.
   이런 값으로는 채우지 않는다. 문서에 "미상"이라고 적혀 나가면 안 된다.
1-2. 값 셀이 여러 개라고 같은 값을 반복해 넣지 않는다. 공동상속인처럼 여러 사람이
   각자 칸을 갖는 표에서는 각 칸이 서로 다른 사람이다. 누구 자리인지 특정할 수
   없으면 비워둔다.
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
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "system", "content": TABLE_FIELD_PROMPT},
                      {"role": "user", "content": user_msg}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        return {"cell_replacements": [], "error": f"{type(e).__name__}: {e}"}


def _apply_table_fields(table_objs: list, replacements: list) -> tuple:
    """GPT가 제안한 셀 치환을 실제로 적용. 범위를 벗어나거나 실패하면
    조용히 건너뛴다(표 하나 잘못됐다고 전체가 죽으면 안 됨).
    반환: (적용건수, 실패목록, 이번에 채운 (table_index,row,col) 집합)."""
    applied, missed, filled_keys = 0, [], set()
    for r in replacements:
        idx, row, col, value = r.get("table_index"), r.get("row"), r.get("col"), r.get("value")
        if idx is None or row is None or col is None or not value:
            continue
        if _is_unknown_value(value):
            # _apply_fields와 같은 이유 — "미상"은 확인 불가 표시라 문서에 쓰면 안 된다.
            missed.append(r)
            continue
        if not (0 <= idx < len(table_objs)):
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
        resp = client.chat.completions.create(
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
        resp = client.chat.completions.create(
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
        resp = client.chat.completions.create(
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
        is_narr = [_is_narrative(t) for t in texts]
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
3-1. "미상", "불명", "확인불가"는 값이 아니라 '모른다'는 표시다. 문장에 그 글자를
   그대로 쓰지 마라. 이름을 모르는 사람은 서식 역할명(상대방, 공동상속인 등)으로
   지칭한다.
4. 허용되는 것: 상담에 있는 사실을 법률 문체로 다듬고 자연스럽게 잇는 것.
   상담에 있는 사실로부터의 직접적 요약(예: "도박으로 경제적 어려움")은 가능.

## 문체·형식
- 법률 문서 문체("~하였습니다/~입니다"). 당사자는 서식 역할명
  (신청인/피신청인)으로 지칭.
- 서술란은 여러 문단(가. 나. 다. ...)으로 나뉘어 있을 수 있고, 문단 개수가
  주어진다. 있는 사실을 그 개수에 맞춰 자연스럽게 배분한다.
  단, 사실이 적으면 억지로 문단을 채우지 말고 앞 문단들에만 쓰고
  나머지는 빈 문자열로 둔다. (없는 내용으로 칸을 메우지 마라)
- 마지막에 사실이 부족하면 "(구체적 경위는 상담을 통해 보완이 필요합니다.)"로
  한 번만 맺는다.

## 입력
- [서술란 성격]: 이 란이 무슨 내용을 적는 곳인지 (예: 혼인 파탄 경위)
- [문단 개수]: 채워야 할 문단 수 N
- [상담 요약], [추출정보]: 쓸 수 있는 사실의 전부. 이 밖의 것은 없다.
  (원본 예시 문구는 제공하지 않는다. 참고할 남의 사연이 없으니 오직
   상담 사실로만 쓴다.)

## 출력 JSON (문단 N개, 순서대로. 못 채우는 문단은 "")
{"paragraphs": ["문단1", "문단2", ...]}"""


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


def _rewrite_examples(example_texts: list, extracted: dict, summary: str) -> list:
    """원본 예시 문구는 GPT에 넘기지 않는다(베낌 방지).
    '무슨 란인지' + '문단 개수' + 우리 사실만 주고 서술하게 한다."""
    n = len(example_texts)
    label = _infer_field_label(example_texts)
    user_msg = (f"[서술란 성격]\n{label}\n\n"
                f"[문단 개수]\n{n}\n\n"
                f"[상담 요약]\n{summary}\n\n"
                f"[추출정보]\n{json.dumps(extracted, ensure_ascii=False, indent=2)}\n\n"
                f"위 사실만으로 문단 {n}개를 작성하라. 사실이 부족하면 뒤 문단은 \"\".")
    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "system", "content": REWRITE_PROMPT},
                      {"role": "user", "content": user_msg}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        out = json.loads(resp.choices[0].message.content)
        paras = out.get("paragraphs", [])
    except Exception:
        # 응답이 깨지면 근거 없이 채우느니 전부 미기재 처리 — 원본은 그대로
        # 남고 draft()가 "서술문단(근거부족·상담원작성)"으로 unfilled에 기록한다.
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
        resp = client.chat.completions.create(
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
    # "미상"은 값이 아니라 '확인 불가' 표시다. 재서술 경로도 막아야 한다.
    # 여기선 부분 일치만 본다 — "없음"은 정상 서술문에도 나올 수 있어서
    # (예: "제출된 증빙자료는 없음") 재서술을 통째로 버릴 이유가 안 된다.
    for word in _UNKNOWN_SUBSTRINGS:
        if word in text:
            v.append(f"미상표기:{word}")
            break
    return v


def _set_paragraph_text(p, text: str):
    """문단 객체의 첫 run에 text, 나머지 run 비움."""
    runs = getattr(p, "runs", [])
    if not runs:
        return False
    runs[0].text = text
    for r in runs[1:]:
        r.text = ""
    return True


# 표 안전장치(TABLE_EXAMPLE_TAG)와 같은 이유로 짧은 태그를 쓴다 — 원래
# 긴 태그("[서식 예시—실제 값으로 교체 필요] ")를 앞에 붙이면 "국 적    중화민국"
# 같이 라벨-값 사이 간격을 맞춰둔 줄의 정렬이 밀려서 서식이 이상해 보였다.
# 그래서 (1) 짧은 태그로 바꾸고 (2) 앞이 아니라 뒤에 붙여서 원래 간격을
# 그대로 보존한다.
PARA_EXAMPLE_TAG = " [예시:확인필요]"


def _tag_paragraph(runs) -> None:
    runs[-1].text = (runs[-1].text or "") + PARA_EXAMPLE_TAG


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
        resp = client.chat.completions.create(
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
            elif len(text) >= 4 and re.search(r"\s{2,}", text):
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
                    run.text = t.replace(target, value, 1)
                    return 1
    return 0


def _apply_fields(doc, replacements, skip_texts=()):
    """skip_texts: 예시 문단으로 판별된 원문들. 이 문단은 건드리지 않는다.

    원래는 정형 치환을 먼저 하고 예시 판별을 나중에 했다. 그래서 "예시인 걸 알기
    전에 이미 채워버려서", 서식 제작자가 인쇄해둔 남의 사연 안에 우리 사건의 이름이
    들어갔다 — "대 300㎡는 이도영의 소유로 한다" 뒤에 [예시:확인필요]가 붙는 식.
    예시 문단은 B단계에서 통째로 재서술하거나 표시할 대상이라 여기서 손대면 안 된다.
    """
    skip = [t for t in (skip_texts or ()) if t and t.strip()]
    applied, missed = 0, []
    for r in replacements:
        before, after = r.get("before", ""), r.get("after", "")
        if not before or not after:
            continue
        if any(before in t for t in skip):
            missed.append(before)
            continue
        if _is_unknown_value(after):
            # "미상"은 값이 아니라 '확인 불가' 표시다(schemas/analysis.py의 Party.이름).
            # 프롬프트로만 막으면 새어나가서, 실제 문서에 "미상시 미상구 미상동"처럼
            # 박혀버린다. 빈칸으로 남기고 보완 목록에 올린다.
            missed.append(before)
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
# 메인
# ══════════════════════════════════════
def draft(form_name, extracted, summary=""):
    src = find_hwpx(form_name)
    if src is None:
        return {"file": None, "error": f"서식 파일 없음: {form_name}",
                "applied": 0, "missed": [], "unfilled": [],
                "rewritten_count": 0, "rewrite_rejected": []}

    doc = HwpxDocument.open(str(src))
    md = _extract_markdown(doc)

    # ── A. 정형 치환 ──
    gpt = _generate_fields(md, extracted, summary)
    reps = gpt.get("replacements", [])
    unfilled = gpt.get("unfilled", [])
    applied, missed = _apply_fields(doc, reps)

    # ── E. 표 셀 채우기 ──
    # 표 안 문단은 A/B/C/D 어느 단계도 못 본다(별도 구조) — 문서 순서로
    # 표 객체를 수집해 읽기(get_table_map)/쓰기(set_cell_text) 인덱스를 맞춘다.
    table_objs = _collect_tables(doc)
    tables_meta = doc.get_table_map().get("tables", []) if table_objs else []
    table_gpt = _generate_table_fields(tables_meta, extracted, summary)
    table_applied, table_missed, table_filled_keys = _apply_table_fields(
        table_objs, table_gpt.get("cell_replacements", []))
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
    rewritten_texts = set()
    if examples:
        texts = [t for (_, t) in examples]
        new_texts = _rewrite_examples(texts, extracted, summary)
        new_texts = _selfcheck_and_revise(new_texts, extracted, summary)
        years, money = _allowed_facts(extracted, summary)
        for (para, orig_text), new_text in zip(examples, new_texts):
            if not new_text or not new_text.strip():
                unfilled.append(f"서술문단(근거부족·상담원작성): {orig_text[:25]}")
                continue
            viol = _verify_rewrite(new_text, years, money)
            if viol:
                rewrite_rejected.append({"orig": orig_text[:25], "violations": viol})
                unfilled.append(f"서술문단(검증탈락·상담원작성): {orig_text[:25]}")
                continue
            if _set_paragraph_text(para, new_text):
                rewritten_count += 1
                rewritten_texts.add(new_text)

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