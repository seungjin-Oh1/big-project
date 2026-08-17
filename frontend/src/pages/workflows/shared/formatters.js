// 경과 초를 "1:05" 모양으로. 1분이 넘어가면 초만 보여줘서는 얼마나 지났는지 감이 안 옵니다.
export function formatElapsed(totalSeconds) {
  if (!totalSeconds) return '';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}초`;
}
// STT 개인정보 마스킹(한현우 STT Privacy Filter 파트) 미리보기용 mock 마스커.
// 실제 마스킹은 ai-api STT 단계에서 수행되며, 프론트는 원문/마스킹본 토글로 검토자에게 보여줍니다.
//
// TODO(규제): 아직 어느 단계에서도 실제 마스킹이 일어나지 않습니다.
//   ai-api 쪽에 마스킹 코드가 없고(app 전체 검색 0건), 아래 sttPreview는 고정 예시 문장이라
//   어느 상담을 열어도 같은 문장이 나옵니다. 실제 녹취록은 이 화면을 지나지 않습니다.
//   보호조치 기준 제10조(개인정보 표시 제한) 항목이며, 담당 파트가 붙기 전까지는
//   화면의 해당 카드에 "예시"임을 표시해 실제 동작으로 오해되지 않게 하는 편이 안전합니다.
//   가이드 30쪽: 상담원 화면과 변호사 화면이 서로 다른 방식으로 가리면 두 화면을 조합해
//   원본을 복원할 수 있으므로, 실제 적용 시 두 화면의 마스킹 방식을 통일해야 합니다.
export function maskSensitiveText(text = '') {
  return text
    .replace(/\d{6}\s*-\s*\d{7}/g, '[RRN]') // 주민등록번호
    .replace(/01[016789]\s*-?\s*\d{3,4}\s*-?\s*\d{4}/g, '[PHONE]') // 휴대전화
    .replace(/\d{2,4}\s*-\s*\d{3,4}\s*-\s*\d{4}/g, '[PHONE]'); // 유선전화
}
// 통화 시간을 "3:07"처럼 분:초로 보여줍니다. 실제 통화(텔레포니) 연동 전까지는 이 타이머가
// 상담원에게 "지금 통화가 진행 중이다"를 보여주는 유일한 신호라 정확히 맞춰둡니다.
export function formatCallDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
// 상담원이 통화 중 무엇을 더 물어볼지 놓치지 않도록, 지금까지 적은 메모에서 키워드를 찾아
// 물어보면 좋을 질문을 제안합니다. 클릭해서 '질문함'으로 표시하는 것 외에는 아무 것도 자동으로 하지 않고,
// 실제로 무엇을 물을지는 상담원이 판단합니다(참고용 제안일 뿐, 자동화된 응답이 아닙니다).
const FOLLOWUP_QUESTION_RULES = [
  { keyword: '계약', question: '계약서를 직접 갖고 계신가요? 계약 체결일과 조건을 확인해 주시겠어요?' },
  { keyword: '연락', question: '상대방과 마지막으로 연락한 날짜와 방법을 알려주시겠어요?' },
  { keyword: '금액', question: '정확한 금액과 지급 기한을 확인해 주시겠어요?' },
  { keyword: '폭행', question: '진단서나 상해를 확인할 수 있는 자료가 있으신가요?' },
  { keyword: '이혼', question: '혼인 신고일과 별거를 시작한 시점을 알려주시겠어요?' },
  { keyword: '체불', question: '근로계약서와 임금 명세서를 갖고 계신가요?' },
];

const DEFAULT_FOLLOWUP_QUESTIONS = [
  '사건이 발생한 정확한 날짜를 알려주시겠어요?',
  '상대방의 연락처나 주소를 알고 계신가요?',
  '관련된 증빙 자료(계약서, 문자, 녹취 등)를 갖고 계신가요?',
];

export function buildSuggestedQuestions(memoText) {
  const matched = FOLLOWUP_QUESTION_RULES.filter((rule) => memoText.includes(rule.keyword)).map((rule) => rule.question);
  const suggestions = matched.length ? matched : DEFAULT_FOLLOWUP_QUESTIONS;
  return Array.from(new Set(suggestions)).slice(0, 4);
}
export function generatedFileName(path = '') {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).at(-1) || path;
}

// 서버 가림본을 받을 수 없을 때도 원문을 가림 탭에 그대로 보이지 않게 하는 화면 전용 대체값입니다.
// 상담원·변호사 화면이 같은 규칙을 써서, 서로 다른 가림본을 조합하는 위험도 막습니다.
// 주의: 화면 표시에는 더 이상 쓰지 않습니다(2026-08-17 기준 호출부 없음).
//
// 서버 가림 결과 위에 이 함수가 겹쳐 걸리면 글이 깨집니다. 여기서 주민번호를
// '[주민등록번호]'라는 '글자'로 바꾸는데, 그 글자에 서버 가림이 다시 걸리면서 '주'와
// '번호'가 각각 [1], [2]로 잡혀 변호사 검토 화면에 '[[1]민등록[2]]'가 떴습니다.
// 가림은 stt-mask 게이트웨이 한 곳에서만 하고, 없으면 없다고 적습니다.
// 다시 쓰실 일이 있으면 서버 가림을 거치지 않은 글에만 쓰세요.
export function maskConsultationText(text = '') {
  return String(text)
    .replace(/\d{6}\s*-\s*\d{7}/g, '[주민등록번호]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일]')
    .replace(/01[016789]\s*-?\s*\d{3,4}\s*-?\s*\d{4}/g, '[연락처]')
    .replace(/\d{2,4}\s*-?\s*\d{3,4}\s*-?\s*\d{4}/g, '[연락처]')
    .replace(/(?:19\d{2}|20[0-2]\d)년\s*\d{1,2}월\s*\d{1,2}일(?=입니다|이에요|예요|입니다\.|이에요\.|예요\.)/g, '[생년월일]')
    .replace(/((?:현재\s*)?주소는?\s*)([^\n.]{4,100})(?=(?:입니다|이에요|예요)?[.?!]|$)/g, '$1[주소]')
    .replace(/(안녕하세요,\s*)[가-힣]{2,4}(?=(?:입니다|이에요|예요)[.!]?)/g, '$1[이름]');
}
