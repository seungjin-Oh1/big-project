import io
import os
import re
import base64
import numpy as np
from pathlib import Path
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from faster_whisper import WhisperModel
from pydub import AudioSegment
from transformers import pipeline

app = FastAPI()

# 운영 배포 전 반드시 CORS_ALLOWED_ORIGINS 환경변수로 실제 프론트엔드 도메인으로 교체할 것.
# 여러 개는 콤마로 구분. 미설정 시 로컬 Vite 개발 서버(5173) 기준으로 동작한다.
_cors_origins = [
    origin.strip()
    for origin in os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent
HTML_PATH = BASE_DIR / "index.html"

# Load the speech-to-text model. 운영(Modal, modal/backend.py)은 GPU에서 large-v3를 그대로 쓰지만,
# 로컬 개발 PC는 CUDA GPU가 없는 경우가 많아 기본값을 CPU에서도 바로 도는 base 모델로 낮춰둔다.
# GPU가 있는 로컬 환경이면 환경변수로 large-v3/cuda를 그대로 지정해서 쓸 수 있다.
WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "base")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8" if WHISPER_DEVICE == "cpu" else "float16")

model = WhisperModel(WHISPER_MODEL_SIZE, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)

# Whisper에 이 대화가 어떤 분야인지 미리 알려주는 문장. 디코딩할 때 여기 나온 표현 쪽으로
# 확률이 기울어서, 모델을 키우지 않고도 도메인 용어 오인식을 상당히 줄일 수 있다.
#
# base 모델이 실제로 틀린 것들이 근거다:
#   대한법률구조공단 -> "대한범유구조 공단"    채권자 -> "제권자"/"재권자"
#   빚 -> "빛"                                  주민등록번호 -> "주민 등록 가면"
#   사업 빚 -> "4업 비치"                       한정승인/유류분 등 제도명 전반
# 이 단어들이 틀리면 뒤의 AI 분석이 사건 유형부터 잘못 잡을 수 있고, 화면에 그대로 노출되어
# 상담원이 STT를 신뢰하지 못하게 된다.
#
# 길이를 실측으로 정했다. 길수록 프롬프트 쪽 표현으로 끌려가 멀쩡하던 말이 망가진다.
# 같은 녹취 10건 기준:
#   없음  용어 3/5, 오인식 6개
#   짧게  용어 4/5, 오인식 2개 — '빚은'이 '비즈는'으로 되돌아감
#   중간  용어 5/5, 오인식 2개 — 아래 값. 회귀는 '사고로'->'사굴로' 하나뿐
#   길게  용어 5/5, 오인식 2개 — 그러나 내담자 이름 '가영님'이 '가형님'으로 깨짐
# 이름이 깨지면 서식 초안의 당사자가 틀어지므로 길게는 쓸 수 없다. 용어를 더 넣고 싶으면
# 반드시 같은 방식으로 회귀를 확인할 것.
WHISPER_INITIAL_PROMPT = os.environ.get(
    "WHISPER_INITIAL_PROMPT",
    "대한법률구조공단 법률상담입니다. 채권자, 채무, 빚, 상속포기, 한정승인, 유류분, 주민등록번호.",
)

# Load the OpenAI Privacy Filter
print("Loading OpenAI Privacy Filter...")
privacy_filter = pipeline(
    "token-classification", 
    model="openai/privacy-filter", 
    aggregation_strategy="simple"
)
print("Models loaded successfully.")

@app.get("/")
async def serve_frontend():
    return FileResponse(HTML_PATH)

# ── 한국어 규칙 기반 보완 ────────────────────────────────────────────────────
#
# openai/privacy-filter는 영어에는 정확하지만 한국어 상담 발화에서는 뚫린다. 실측:
#   "문가영입니다."                 -> 검출 없음        (이름이 그대로 노출)
#   "남편 백승현이 ... 사망했습니다" -> 검출 없음
#   "남편은 백승현입니다"            -> 백승현을 person이 아니라 address로 잡음
#   "010-1234-5678"                -> "010-1234-567" + "8" 두 조각으로 쪼갬
# 영어("My name is John Smith")는 정확히 잡는 걸로 보아 모델이 영어 위주로 학습된 탓이다.
#
# 화면은 "개인정보는 자동으로 가려집니다"라고 약속하고 원문/마스킹 전환 버튼까지 두고 있어서,
# 여기가 뚫리면 약속이 거짓이 된다. 모델을 바꾸는 건 큰 일이라, 모델 결과는 그대로 두고
# 한국어에서 확실히 잡히는 것만 규칙으로 얹어 합친다.
#
# 특히 주민등록번호는 말로 하면 STT가 "011216 삼삼삼삼삼삼삼"처럼 뒷자리를 한글로 적어서
# 숫자 정규식만으로는 절반만 가려진다. 한글 숫자 낱말이 이어지는 구간도 같이 잡는다.

KOREAN_DIGIT_WORDS = "영공일이삼사오육륙칠팔구"

_KOREAN_TO_DIGIT = {"영": "0", "공": "0", "일": "1", "이": "2", "삼": "3", "사": "4",
                    "오": "5", "육": "6", "륙": "6", "칠": "7", "팔": "8", "구": "9"}

# 번호를 불러주면 whisper가 숫자가 아니라 한글로 받아쓴다("삼삼삼삼삼삼삼"). 사람이 읽어도
# 번호인 게 분명하니 숫자로 되돌린다 — 화면에 보기 좋고, 마스킹 정규식도 그대로 걸린다.
#
# 바꾸는 조건을 두 겹으로 건다. "숫자처럼 보이면 바꾼다"가 아니라 "번호인 게 확실할 때만
# 바꾼다"여야 상담 내용을 훼손하지 않는다. 잘못 바꾸면 원문이 왜곡되고, 그 원문이 그대로
# AI 분석 입력으로 들어간다.
#
#   1) 한글 숫자가 5자 이상 잇달아 나올 것.
#      "열살", "일곱살", "두 달", "육이오" 같은 평범한 말은 이 길이로 이어지지 않는다.
#   2) 그 자리가 번호 문맥일 것 — 바로 앞뒤에 숫자가 붙어 있거나("011216 삼삼삼삼삼삼삼"),
#      가까운 앞쪽에 번호를 가리키는 낱말이 있을 것.
#
# 조건 2를 못 채우면 바꾸지 않는다. 그래도 마스킹은 된다 — RULE_PATTERNS의 private_number가
# 한글 상태 그대로 가려주므로, 안 바꿔서 개인정보가 새는 일은 없다.
# 전화번호는 "공일공 일이삼사 오육칠팔"처럼 끊어 부르기 때문에 낱말 하나만 보면 3~4자밖에
# 안 된다. 사이의 공백·하이픈은 건너뛰고 세되, 합쳐서 5자 이상일 때만 번호로 본다.
_KOREAN_NUMBER_RUN = re.compile(
    rf"[{KOREAN_DIGIT_WORDS}](?:[ \-~]?[{KOREAN_DIGIT_WORDS}]){{4,}}")
_NUMBER_CUE = re.compile(r"주민\s*등록|주민번호|생년월일|전화|연락처|핸드폰|휴대폰|계좌|카드|"
                         r"사건\s*번호|등기|번호[는은가이]?\s*$")
_NUMBER_CUE_WINDOW = 25


def normalize_spoken_numbers(text: str) -> str:
    """한글로 받아쓴 '번호'만 숫자로 되돌린다."""
    def replace(m):
        before = text[max(0, m.start() - _NUMBER_CUE_WINDOW):m.start()]
        after = text[m.end():m.end() + 2]
        touching_digits = bool(re.search(r"\d\s*[-~]?\s*$", before)
                               or re.match(r"\s*[-~]?\s*\d", after))
        if not touching_digits and not _NUMBER_CUE.search(before):
            return m.group()
        return "".join(_KOREAN_TO_DIGIT[c] for c in m.group()
                       if c in _KOREAN_TO_DIGIT)

    return _KOREAN_NUMBER_RUN.sub(replace, text)

RULE_PATTERNS = [
    # 주민등록번호: 앞 6자리 + 뒤 7자리. 뒤가 한글 숫자로 적힌 경우까지 한 덩어리로 잡는다.
    (re.compile(rf"\d{{6}}\s*[-~]?\s*(?:\d{{7}}|[{KOREAN_DIGIT_WORDS}]{{7}})"), "private_rrn"),
    # 휴대전화/일반전화
    (re.compile(r"0\d{1,2}\s*[-)]?\s*\d{3,4}\s*[-]?\s*\d{4}"), "private_phone"),
    # 한글 숫자만 5자 이상 이어지는 구간 — 번호를 불러준 것으로 본다
    # (주민번호 뒷자리·계좌·전화 모두 이 형태로 STT된다). 4자 이하는 "삼사오" 같은
    # 일반 표현과 구분이 안 돼 오탐이 나므로 제외한다.
    (re.compile(rf"[{KOREAN_DIGIT_WORDS}]{{5,}}"), "private_number"),
    # 계좌번호로 볼 만한 긴 숫자열
    (re.compile(r"\d[\d-]{9,}\d"), "account_number"),
]

# 이름은 모델이 가장 자주 놓치는데, 한국어에서는 앞뒤 표현으로 꽤 정확히 잡을 수 있다.
# 다만 "관계어 + 무언가" 형태만 보면 "남편이 사고로"의 '사고'까지 이름으로 잡힌다.
# 그래서 후보의 첫 글자가 성씨일 때만 인정한다 — 성씨는 닫힌 집합이라 이 조건 하나로
# 오탐이 크게 준다(v1에서 겪은 '친권자·제한·동의' 오탐 폭발이 이런 종류였다).
# 흔한 성씨만 넣는다. 희귀 성씨(사·즙·삼 등)까지 넣으면 다시 일반 명사가 걸린다.
SURNAMES = ("김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허남심노하"
            "곽성차주우구민진지엄채원천방공현함변염여추도소석선설마길연위표명기")

# 관계어 뒤에 오는 말을 이름으로 볼 때는 성씨를 더 좁힌다.
# "동생 소식을", "채권자 연락이", "원고 주장이", "아내 마음이"가 전부 이름으로 잡혔다 —
# 소·연·주·마가 성씨이긴 하나 드물어서, 그 자리에 오는 건 이름보다 일반 명사일 때가 훨씬 많다.
# 흔한 성씨로만 좁히면 이 오탐이 한 번에 사라진다.
COMMON_SURNAMES = "김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허남심"

# "이름이 아닌 말"을 나열하는 건 끝이 없다. 반대로 "이름처럼 생겼는가"를 본다.
#
# 한국 이름에 쓰이는 음절은 상당히 정해져 있다(대부분 한자 인명용 음). 반면 '야기'(이야기),
# '편'(남편), '류'(서류)처럼 일반 명사를 이루는 음절은 이름에 거의 안 쓰인다. 그래서 성씨를
# 뗀 나머지가 전부 이 집합 안에 있을 때만 이름으로 본다.
#
# 길이로 자르는 방법(3글자만 인정)도 검토했지만 쓰지 않았다. 오탐 대부분이 2글자인 건 맞지만
# 두 글자 이름(김구 등)이 영영 안 가려지게 된다 — 그 사람 이름만 노출되는 셈이라 오탐보다 나쁘다.
NAME_SYLLABLES = set(
    "가강건경계고관광구권규균근금기길나남내노누다단담대덕도동두라란람래량려력련렬"
    "렴령례로록롱료룡루류륜률륭름릉리린립만매면명모목묘무묵문미민바박반방배백범법"
    "변별병보복본봉부빈빙사산삼상새생서석선설섭성세소솔송수숙순숭슬승시식신실심아"
    "안애야양어언업여연열염엽영예오옥온올옹완요용우운웅원월위유윤율은을음의이익인"
    "일임자작장재전정제조종주준중지진질집차찬창채천철청초총최추춘출충치칠침쾌타탁"
    "탄태택하학한해행향헌혁현형혜호홍화환황회효후훈휘흠희"
)

# 음절 검사로도 안 걸러지는 것들. '정도'(도는 이름 음절), '전화'(화도 이름 음절)처럼
# 이름 음절로만 이루어진 일반 명사가 여기 해당한다. 오탐이 보이면 한 줄씩 추가하면 된다.
# 실제 이름을 여기 넣으면 안 가려지니 주의할 것.
NOT_NAME_WORDS = {
    "이야기", "이유", "이름", "이번", "이제", "이상", "이혼", "이자", "이사", "이후",
    "이전", "이력", "이의", "이행", "이체", "이송",
    "정말", "정도", "정리", "정보", "정신", "정식", "정지", "정산",
    "조금", "조치", "조사", "조정", "조건", "조언", "최근", "최초", "최종",
    "문제", "문의", "문서", "서류", "서명", "서울", "신청", "신고", "신용", "신분",
    "고민", "고소", "고발", "고지", "강제", "강의", "권리", "권한",
    "남편", "남자", "심리", "한번", "한달", "안내", "안건",
    "임대", "임차", "전세", "전부", "전화", "전달", "오늘", "오전", "오후",
    "백만", "김치", "장소", "장기", "장남", "윤리", "손해", "손실", "배상", "배우",
    "허가", "허락",
    # 절차 이름. "가사소송이라고 해요"의 '소송'(소=성씨), "조정신청이라고 합니다"의
    # '조정신청'(조=성씨)이 이름으로 잡혔다 — 상담에서 매번 나오는 말이라 그대로 두면
    # 마스킹본이 "[PRIVATE_PERSON]이라고 합니다"가 되어 무슨 사건인지 읽을 수 없다.
    "소송", "조정신청", "심판청구", "지급명령", "이행명령", "가압류", "가처분",
    "성본변경", "친권상실", "면접교섭", "재산분할", "위자료청구", "유류분반환",
}


def _looks_like_name(candidate: str) -> bool:
    """성씨를 뗀 나머지가 전부 이름에 쓰이는 음절인가."""
    if candidate in NOT_NAME_WORDS:
        return False
    return all(ch in NAME_SYLLABLES for ch in candidate[1:])

NAME_PATTERNS = [
    # "제 이름은 김철수이고", "저는 문가영입니다"
    re.compile(rf"(?:제\s*이름은|성함은|저는|본인은)\s*([{SURNAMES}][가-힣]{{1,3}})"
               rf"(?=\s*(?:이고|입니다|이라|예요|이에요|요))"),
    # "남편은 백승현입니다", "남편 백승현이 2025년에" — 이름 뒤 조사까지 허용하되
    # 성씨 조건이 있어서 '사고로'·'재산은' 같은 일반 명사는 걸리지 않는다.
    re.compile(rf"(?:남편|아내|배우자|아버지|어머니|아들|딸|형|누나|동생|오빠|언니|"
               rf"피고|원고|상대방|망인|피상속인|채무자|채권자)\s*(?:은|는|이|가|의)?\s*"
               rf"([{COMMON_SURNAMES}][가-힣]{{1,3}})(?=\s*(?:은|는|이|가|을|를|와|과|의|께서|씨|님|입니다|이고|이라))"),
    # 문장 첫머리에 이름만 말하는 경우 — "문가영입니다."
    re.compile(rf"^([{SURNAMES}][가-힣]{{1,3}})(?=입니다)"),
    # "백승현 씨가", "문가영 님은"
    re.compile(rf"([{SURNAMES}][가-힣]{{1,3}})(?=\s*(?:씨가|씨는|씨를|씨의|씨와|님이|님은|님을))"),
    # "정미래라고 합니다", "문가영이라고 해요" — 상담에서 이름을 대는 가장 흔한 방식인데
    # 위 네 패턴 어디에도 안 걸렸다. 실측: '저는 한도현입니다'·'박영희입니다'는 가려지는데
    # '정미래라고 합니다'·'문가영이라고 해요'는 그대로 남았다. 상담 첫머리에서 이름을
    # 묻고 답하는 자리라 거의 모든 상담이 이 형태로 시작한다 — 화면은 "개인정보는
    # 자동으로 가려집니다"라고 적어 두고 정작 이름이 그대로 나가고 있었다.
    #
    # 앞의 성씨 조건과 _looks_like_name 검사는 그대로 쓴다. '그러니까 뭐라고 합니다'
    # 처럼 앞말이 이름이 아니면 걸러진다.
    # 비탐욕({1,3}?)이어야 한다. 탐욕적으로 두면 "가사소송이라고"에서 '소송'이 아니라
    # '소송이'를 잡아, NOT_NAME_WORDS에 적어 둔 '소송'을 빠져나간다(실측). 짧은 후보를
    # 먼저 시도하면 '소송'으로 걸려 정상적으로 제외되고, "문가영이라고"는 '문가'가
    # 뒤의 '이라고'와 안 맞아 '문가영'까지 늘어난다.
    re.compile(rf"([{SURNAMES}][가-힣]{{1,3}}?)"
               rf"(?=이?\s*라고\s*(?:합니다|해요|하는데|하고|해서|불러|부릅니다))"),
]


def _rule_spans(text: str) -> list:
    """정규식으로 확실히 잡히는 한국어 개인정보 구간."""
    spans = []
    for pattern, label in RULE_PATTERNS:
        for m in pattern.finditer(text):
            spans.append({"start": m.start(), "end": m.end(), "entity_group": label})
    for pattern in NAME_PATTERNS:
        for m in pattern.finditer(text):
            # 그룹 1이 이름 본체 — 단서 표현("제 이름은")까지 가리면 문장이 읽히지 않는다.
            if not _looks_like_name(m.group(1)):
                continue
            spans.append({"start": m.start(1), "end": m.end(1),
                          "entity_group": "private_person"})
    return spans


_SPAN_JOINERS = set(" \t-~.")

# 모델이 개인정보로 잘못 잡는 일반 명사들. 실측에서 '남편'을 private_address로 붙였다.
# 가족 관계·당사자 지칭은 그 자체로는 개인정보가 아니고, 오히려 가려버리면 마스킹본이
# "[PRIVATE_ADDRESS]은 [PRIVATE_PERSON]입니다"가 되어 변호사가 누구 이야기인지 못 읽는다.
NOT_PII_WORDS = {
    "남편", "아내", "배우자", "아버지", "어머니", "아버님", "어머님", "부친", "모친",
    "아들", "딸", "형", "누나", "언니", "오빠", "동생", "자녀", "아이", "부모",
    "본인", "저", "제", "상대방", "피고", "원고", "채권자", "채무자",
    "피상속인", "상속인", "망인", "신청인", "청구인",
}


def _merge_spans(spans: list, text: str) -> list:
    """겹치거나 구분자만 사이에 둔 구간을 하나로 합친다.

    모델이 aggregation_strategy='simple'로도 "010-1234-567" + "8"처럼 끊어서 내놓는데,
    그대로 치환하면 [PRIVATE_PHONE][PRIVATE_PHONE]가 되어 읽을 수 없다. 규칙 결과와
    모델 결과가 같은 자리를 가리키는 경우도 여기서 하나로 정리된다.

    사이에 무엇이 있든 붙이면 안 된다 — "남편은 백승현입니다"에서 모델이 '남편'을
    주소로 잘못 잡는데, 조사 '은'을 건너뛰고 이름과 합치면 "[PRIVATE_PERSON]입니다"가
    되어 누구 이야기인지가 사라진다. 공백·하이픈 같은 구분자일 때만 잇는다.

    라벨이 다르면 더 구체적인 규칙 쪽(private_rrn 등)을 남긴다 — 모델이 사람 이름을
    address로 잘못 붙이는 일이 있어서, 규칙이 있으면 규칙을 믿는다."""
    if not spans:
        return []
    priority = {"private_rrn": 5, "private_phone": 4, "account_number": 3,
                "private_person": 2, "private_number": 1}
    # 모델 구간은 앞뒤 공백까지 물고 오는 일이 잦다("  김철"). 그대로 가리면 단어가
    # 서로 붙어버리므로 실제 값 범위로 좁힌다.
    trimmed = []
    for span in spans:
        start, end = span["start"], span["end"]
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if start >= end:
            continue
        # 규칙이 잡은 건 그대로 믿는다. 걸러내는 건 모델 오탐뿐이다 — 규칙은 '남편'을
        # 애초에 이름으로 잡지 않으므로 여기 걸릴 일이 없지만, 순서상 명시해 둔다.
        if text[start:end].strip() in NOT_PII_WORDS:
            continue
        trimmed.append({**span, "start": start, "end": end})

    ordered = sorted(trimmed, key=lambda s: (s["start"], -s["end"]))
    merged = [dict(ordered[0])]
    for span in ordered[1:]:
        last = merged[-1]
        gap = text[last["end"]:span["start"]]
        if span["start"] <= last["end"] or all(c in _SPAN_JOINERS for c in gap):
            last["end"] = max(last["end"], span["end"])
            if priority.get(span["entity_group"], 0) > priority.get(last["entity_group"], 0):
                last["entity_group"] = span["entity_group"]
        else:
            merged.append(dict(span))
    return merged


def redact_text(text: str, spans: list) -> str:
    """Replaces detected PII spans with their label placeholders."""
    result = list(text)
    # Sort descending so earlier string replacements don't shift later indexes
    for span in sorted(_merge_spans(spans, text), key=lambda s: s["start"], reverse=True):
        label = f"[{span['entity_group'].upper()}]"
        # Replace the characters spanning start:end with the characters of the label
        result[span["start"]:span["end"]] = list(label)
    return "".join(result)

@app.post("/redact")
async def redact_typed_text(payload: dict):
    """이미 글자로 있는 상담 내용에 개인정보 가림만 적용한다.

    /transcribe는 오디오를 받아야만 동작해서, 상담원이 메모칸에 직접 적거나 붙여넣은
    내용은 가림을 거칠 데가 없었다 — 마스킹본이 실시간 녹음 경로에서만 만들어졌다
    (실측: 상담 30건 중 28건이 마스킹본 0건). 그러면 core-api가 ai-api로 보내는
    anonymized_text가 비고, RAG가 근거를 한 건도 못 찾는다.

    가림 로직은 /transcribe와 같은 것을 쓴다. 받아쓰기·오디오 인코딩만 없다.
    """
    text = str(payload.get("text") or "")
    if not text.strip():
        return {"text": text, "redacted_text": ""}
    # 불러준 번호를 숫자로 되돌린 뒤에 가린다(/transcribe와 같은 순서). 타이핑한 글에는
    # 보통 해당이 없지만, 녹취를 옮겨 적은 메모에는 "공일공"이 그대로 남아 있곤 한다.
    normalized = normalize_spoken_numbers(text)
    spans = list(privacy_filter(normalized)) + _rule_spans(normalized)
    return {"text": normalized, "redacted_text": redact_text(normalized, spans)}


@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """Receives audio, transcribes it, runs the privacy filter, and returns the data."""
    try:
        audio_bytes = await file.read()
        
        audio_file = io.BytesIO(audio_bytes)
        audio_segment = AudioSegment.from_file(audio_file)
        audio_segment = audio_segment.set_frame_rate(16000).set_channels(1)

        samples = np.array(audio_segment.get_array_of_samples(), dtype=np.float32)
        # sample_width는 보통 2바이트(16비트)지만, 하드코딩된 32768.0 대신 실제 폭 기준으로
        # 정규화한다 — 폭이 다르면 값이 잘못 스케일링돼(클리핑/왜곡) STT 품질이 나빠진다.
        max_value = float(1 << (8 * audio_segment.sample_width - 1))
        audio_array = samples / max_value

        # 1. Run transcription
        # vad_filter=True: 무음/저음량 구간을 Whisper에 그대로 넘기지 않고 먼저 걸러낸다.
        # 5초마다 MediaRecorder를 stop/restart하는 구조라 각 조각 앞부분에 무음(마이크 워밍업)이
        # 섞이기 쉬운데, 이걸 무음 없이 그대로 넣으면 작은 모델(base)이 "아, 그.." 같은 반복
        # 필러를 환각(hallucination)으로 만들어낸다 — 이게 신고된 증상과 정확히 일치한다.
        segments, _ = model.transcribe(audio_array, language="ko", vad_filter=True,
                                       initial_prompt=WHISPER_INITIAL_PROMPT)
        full_text = " ".join([segment.text for segment in segments]).strip()
        # 불러준 번호를 숫자로 되돌린 뒤에 마스킹한다 — 순서가 바뀌면 주민등록번호 정규식이
        # 한글로 적힌 뒷자리를 못 만나 절반만 가려진다.
        full_text = normalize_spoken_numbers(full_text)
        
        # 2. Run Privacy Filter
        # 모델 결과에 한국어 규칙 결과를 더한다 — 모델은 한국어 이름·주민번호를 자주
        # 놓치고, 규칙은 문맥을 모른다. 둘을 합친 뒤 _merge_spans가 겹침을 정리한다.
        if full_text:
            spans = list(privacy_filter(full_text)) + _rule_spans(full_text)
            redacted_text = redact_text(full_text, spans)
        else:
            redacted_text = ""
        
        # 3. Export audio to WAV format
        wav_io = io.BytesIO()
        audio_segment.export(wav_io, format="wav")
        wav_bytes = wav_io.getvalue()
        encoded_audio = base64.b64encode(wav_bytes).decode("utf-8")
        
        return {
            "text": full_text,
            "redacted_text": redacted_text,
            "audio_base64": encoded_audio
        }
        
    except Exception as e:
        # FastAPI는 (본문, 상태코드) 튜플을 Flask처럼 해석하지 않는다 — 그대로 반환하면
        # [{"error": "..."}, 500] 배열이 HTTP 200으로 나가버려 호출하는 쪽(core-api)이 진짜
        # 에러 메시지를 못 읽는다. JSONResponse로 상태코드와 본문을 명시적으로 지정해야 한다.
        return JSONResponse(status_code=500, content={"error": f"{type(e).__name__}: {e}"})