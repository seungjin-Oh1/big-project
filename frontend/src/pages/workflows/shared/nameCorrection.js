// STT가 잘못 들은 내담자 이름을, 상담원이 확인해 입력한 이름으로 되돌립니다.
//
// 상담원이 이름칸을 고쳐도 받아쓰기 본문은 그대로 남습니다. 그 본문이 상담 저장 -> AI 분석 ->
// 서식 초안까지 그대로 흘러가기 때문에, 청구인 이름이 틀린 채로 법률 문서가 만들어집니다.
// 실제로 Whisper가 '문가영'을 '문경'으로, '이도영'을 '이도형'으로 듣는 일이 있었습니다.
//
// 반대 방향은 이미 막혀 있습니다 — analysisHelpers.runConsultationAnalysis는 AI가 뽑은 이름으로
// 상담원이 입력한 이름을 덮어쓰지 않습니다. 여기서는 그 짝을 맞춥니다: 사람이 확인한 이름이
// 본문 쪽으로도 반영되게 합니다.
//
// 소리가 비슷한지는 글자가 아니라 자모로 봅니다. '문경'과 '문가영'은 글자로는 '문' 하나만
// 겹치지만, 자모로 펴면 ㅁㅜㄴㄱ 까지 같고 ㅏㅇ 두 개만 빠진 것이라 아주 가깝습니다.

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;

const CHOSEONG = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];
const JUNGSEONG = [
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ',
  'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
];
const JONGSEONG = [
  '', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ',
  'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];

// 한 글자를 초성/중성/종성으로 폅니다. 종성이 없으면 두 개만 나옵니다.
function toJamo(text) {
  const jamo = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < HANGUL_START || code > HANGUL_END) {
      jamo.push(char);
      continue;
    }
    const offset = code - HANGUL_START;
    jamo.push(CHOSEONG[Math.floor(offset / 588)]);
    jamo.push(JUNGSEONG[Math.floor((offset % 588) / 28)]);
    const jongseong = JONGSEONG[offset % 28];
    if (jongseong) jamo.push(jongseong);
  }
  return jamo;
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

// 0(전혀 다름) ~ 1(같음). 자모 단위 편집거리를 긴 쪽 길이로 나눕니다.
function jamoSimilarity(left, right) {
  const leftJamo = toJamo(left);
  const rightJamo = toJamo(right);
  const longest = Math.max(leftJamo.length, rightJamo.length);
  if (!longest) return 0;
  return 1 - editDistance(leftJamo, rightJamo) / longest;
}

// 0.67(자모 3개 중 1개까지 틀려도 인정)에서 실제 사례가 갈립니다.
//   문경   vs 문가영 -> 0.75  (고쳐야 하는 것)
//   문자   vs 문가영 -> 0.50  (그냥 '문자'라는 낱말)
//   문의   vs 문가영 -> 0.50
//   문가족 vs 문가영 -> 0.625
const MIN_SIMILARITY = 0.67;

// 두 글자 이름은 손대지 않습니다. '김민'을 기준으로 삼으면 '기민(하게)' 같은 흔한 낱말이
// 0.83까지 나와서, 이름이 아닌 말을 이름으로 바꿔버립니다. 세 글자 이상이면 자모가 8개 넘게
// 늘어나 우연히 비슷해질 여지가 급격히 줄어듭니다. 한국 이름은 대부분 세 글자입니다.
const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 4;

const HANGUL_WORD_RE = /[가-힣]+/g;

// 이름 뒤에 붙을 수 있는 조사·어미. '문경시청'을 '문가영시청'으로 만들지 않기 위한 장치입니다 —
// 소리만 보면 '문경'은 '문가영'과 충분히 가깝지만, 뒤에 '시청'이라는 딴 낱말이 붙어 있으면
// 그건 사람 이름이 아닙니다.
//
// 목록에 없으면 그냥 안 고칩니다. 못 고치고 넘어가는 쪽(사람이 나중에 고치면 됨)이 멀쩡한
// 본문을 망치는 쪽보다 낫기 때문에, 넓게 잡지 않고 확실한 것만 넣습니다.
const NAME_PARTICLES = new Set([
  '',
  '이', '가', '은', '는', '을', '를', '와', '과', '랑', '이랑', '하고',
  '도', '만', '의', '에게', '한테', '께', '께서', '부터', '까지', '보다',
  '이라고', '라고', '이라는', '라는', '이란', '란', '이나', '나',
  '입니다', '이에요', '예요', '이야', '야', '아', '이요', '요',
  '이고', '이며', '인데', '이라서', '라서', '이지만', '지만', '이라도', '라도',
]);
const NAME_TITLES = ['씨', '님', '군', '양'];

function isNameSuffix(suffix) {
  const title = NAME_TITLES.find((item) => suffix.startsWith(item));
  return NAME_PARTICLES.has(title ? suffix.slice(title.length) : suffix);
}

// 이름이 아닌데 이름 자리에 저장된 값들. 이걸 기준으로 삼으면 상담 원문의 진짜 이름을
// 가짜 이름으로 덮어씁니다 — 고칠 자리를 다 찾지도 못해서 이름이 섞인 기록이 남습니다.
//
// '아무개'는 이름 없이 접수한 상담의 clientName에 예전 프론트가 넣던 값입니다. 지금은
// 빈 값을 그대로 보내지만(coreApiClientV2 toCoreConsultationPayload), 그 전에 저장된
// 상담이 남아 있습니다. 아래 형태 검사(한글 2~n자)로는 진짜 이름과 구별되지 않습니다.
const NOT_A_NAME = ['미입력', '아무개'];

// 이 이름을 기준으로 본문을 고쳐도 되는지. 화면 표시용 문구('이름 미입력')나 영문·공백 섞인
// 값이 들어오면 기준으로 쓸 수 없습니다.
export function isCorrectableName(name) {
  const value = (name || '').trim();
  return (
    value.length >= MIN_NAME_LENGTH
    && value.length <= MAX_NAME_LENGTH
    && /^[가-힣]+$/.test(value)
    && !NOT_A_NAME.some((mark) => value.includes(mark))
  );
}

// 본문에서 확인된 이름과 소리가 비슷한 부분을 그 이름으로 바꿉니다.
//
// 한글 덩어리(띄어쓰기로 끊긴 단위)의 '맨 앞'에서만 찾습니다. 뒤에 붙는 조사·호칭은 그대로
// 두고 이름만 갈아끼우기 위해서입니다("문경이랑" -> "문가영이랑", "문경 씨" -> "문가영 씨").
// 덩어리 중간까지 뒤지면 '문경시청' 같은 말의 안쪽을 건드리게 되어 오히려 본문이 망가집니다.
export function correctClientName(text, name) {
  if (!text || !isCorrectableName(name)) return text;
  const confirmed = name.trim();

  return text.replace(HANGUL_WORD_RE, (word) => {
    let best = null;
    // 한 글자 더 짧게/길게 들은 경우까지 봅니다('문가영'을 '문경'으로 줄여 듣거나
    // '문가영이'처럼 늘여 듣는 경우).
    for (let length = Math.max(2, confirmed.length - 1); length <= confirmed.length + 1; length += 1) {
      if (length > word.length) break;
      const candidate = word.slice(0, length);
      if (candidate === confirmed) return word; // 이미 맞게 적혀 있음
      if (!isNameSuffix(word.slice(length))) continue;
      const score = jamoSimilarity(candidate, confirmed);
      // 점수가 같으면 짧은 쪽을 씁니다 — 뒤에 붙은 글자를 덜 건드립니다.
      if (score >= MIN_SIMILARITY && (!best || score > best.score)) best = { candidate, score };
    }
    return best ? confirmed + word.slice(best.candidate.length) : word;
  });
}
