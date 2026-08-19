// 상태 단어(승인/반려/완료/보류 등)를 색 톤으로 매핑하는 "단일 기준"입니다.
// 화면마다 톤 판정 로직이 흩어지면 같은 단어가 다른 색으로 보이므로,
// 상태→색의 규칙은 반드시 이 파일 한 곳에서만 관리합니다. (응집도)
//
// 톤의 의미:
// - success(초록): 승인·완료처럼 긍정적으로 마무리된 상태
// - danger(빨강): 반려·거절처럼 부정적으로 마무리된 상태
// - warn(주황): 보류·수정 요청·추가자료 요청처럼 사람의 추가 조치가 필요한 상태
// - info(파랑): 진행 중·검토 중처럼 흐름이 이어지는 중간 상태
// - muted(회색): 아직 시작 전이거나 값이 없는 상태
//
// 앞에 있는 규칙이 먼저 매칭됩니다. (예: '승인 반려'처럼 섞여도 '반려'를 우선 판정)
const TONE_RULES = [
  // '비대상 후보'는 구조 대상 표기를 확정형에서 후보형으로 바꾸면서 생긴 값입니다
  // (행정기본법 제20조). 키워드를 안 넣으면 색이 muted로 떨어져 눈에 안 띕니다.
  { tone: 'danger', keywords: ['반려', '거절', '부적합', '비대상'] },
  { tone: 'success', keywords: ['승인', '완료'] },
  { tone: 'warn', keywords: ['보류', '수정 요청', '추가자료 요청'] },
  // '확인 필요'는 예전 '검토 필요'를 후보형으로 바꾼 값입니다. 안 넣으면 파란 톤을
  // 잃고 회색으로 떨어집니다. 넓게 '확인'으로 잡으면 '확인불가' 같은 값까지 물어서
  // 문구 그대로 씁니다.
  { tone: 'info', keywords: ['진행', '검토', '확인 필요', '접수', '분석 중', '상담 중', '시작'] },
];

// 상태 문자열을 톤 키워드(success/danger/warn/info/muted)로 변환합니다. (단일 책임)
// 이 파일 내부(statusChipClass)에서만 쓰여 더 이상 export하지 않습니다(외부 import 없음).
function resolveStatusTone(status) {
  if (!status) return 'muted';
  const matched = TONE_RULES.find((rule) => rule.keywords.some((keyword) => status.includes(keyword)));
  return matched ? matched.tone : 'muted';
}

// 상태 칩(span)에 그대로 넣을 수 있는 className을 돌려줍니다.
export function statusChipClass(status) {
  return `statusChip tone-${resolveStatusTone(status)}`;
}
