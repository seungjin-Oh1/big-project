import { isKnownCaseType } from '../../../data/domain.js';
import { summarizeAttachmentModalities } from './attachmentHelpers.js';

// 긴급도 등급별 점수 대역. 같은 등급 안에서도 사건마다 다른 값이 나오도록 '고정값'이 아니라 '구간'으로 둡니다.
const URGENCY_BAND = { 상: [0.66, 0.97], 중: [0.36, 0.65], 하: [0.05, 0.35] };

// 긴급 신호 키워드. 상담 내용에 있을수록 점수가 올라갑니다.
// (백엔드 ai-api의 긴급도 판단 기준 프롬프트와 같은 맥락: 생명·신체 위험, 시효·집행 임박 등)
const HIGH_URGENCY_SIGNALS = ['강제집행', '소멸시효', '시효', '임박', '즉시', '당장', '폭행', '협박', '생명', '위독', '위험', '구속', '체포', '경매', '압류', '가압류', '퇴거', '명도', '자살', '실종'];
const MID_URGENCY_SIGNALS = ['소송', '기일', '재판', '조정', '최고', '내용증명', '합의', '미지급', '체불', '연체', '독촉', '이혼', '양육비', '상속', '기한'];

// 긴급도 등급 → 근거 문장. 등급 하나에서만 나오게 해 등급과 근거가 어긋나지 않게 합니다.
export function emergencyReason(level) {
  return level === '상'
    ? '즉시 대응이 필요한 정황(기한 임박·금전 피해 등)으로 보입니다.'
    : level === '중'
      ? '수일~수주 내 대응이 필요한 사안으로 보입니다.'
      : '특별한 시한 압박은 낮은 것으로 보입니다.';
}

// 0~1 점수를 등급으로 변환.
export function levelFromRatio(ratio) {
  return ratio >= URGENCY_BAND.상[0] ? '상' : ratio >= URGENCY_BAND.중[0] ? '중' : '하';
}

// 점수가 등급 대역을 벗어나면 그 대역 안으로 보정합니다. (백엔드가 등급만 줄 때 등급-점수 일관성 유지)
export function fitRatioToLevel(ratio, level) {
  const band = URGENCY_BAND[level] || URGENCY_BAND.하;
  return Number(Math.min(band[1], Math.max(band[0], ratio)).toFixed(2));
}

// 긴급도(등급/점수/근거)를 상담 내용과 첨부자료의 여러 신호를 종합해 계산합니다.
// 등급별 고정 점수가 아니라, 신호를 가중합한 연속 점수를 내고 그 점수로 등급을 정합니다.
// → 같은 '상'이라도 사건마다 점수가 다르고, 사건 내용이 다르면 등급도 갈립니다.
// (백엔드 AI가 case_emergency_ratio를 주면 그 값을 우선 쓰고, 이 로컬 계산은 백엔드가 없을 때만 씁니다.)
export function computeCaseEmergency(selectedCase) {
  const text = `${selectedCase?.title || ''} ${selectedCase?.memo || ''}`;
  const attachments = selectedCase?.attachments || [];
  const hasMultimodalEvidence = summarizeAttachmentModalities(attachments).some((item) => item.count > 0);

  let score = 0.12; // 단순 문의 수준의 기본선
  HIGH_URGENCY_SIGNALS.forEach((keyword) => { if (text.includes(keyword)) score += 0.17; });
  MID_URGENCY_SIGNALS.forEach((keyword) => { if (text.includes(keyword)) score += 0.08; });
  // 금액 규모: 자릿수가 클수록(만원→억) 가중
  const amounts = text.match(/\d[\d,]{2,}/g);
  if (amounts) {
    const maxDigits = Math.max(...amounts.map((value) => value.replace(/\D/g, '').length));
    score += Math.min(0.2, maxDigits * 0.03);
  }
  // 근거 자료가 많을수록 사안이 구체적이라고 보고 미세 가중
  if (hasMultimodalEvidence) score += 0.08;
  score += Math.min(0.1, attachments.length * 0.03);
  score += Math.min(0.06, (selectedCase?.memo || '').length / 2000);

  // 같은 키워드 조합이라도 사건마다 점수가 똑같이 겹쳐 보이지 않도록 사건 식별자 기반의 작은 흔들림을 더합니다.
  // caseNo/id로 만든 결정론적 값이라 새로고침해도 점수가 바뀌지 않습니다.
  const seed = String(selectedCase?.caseNo || selectedCase?.id || text).split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  score += ((seed % 7) - 3) * 0.01; // -0.03 ~ +0.03

  const ratio = Number(Math.max(0.05, Math.min(0.97, score)).toFixed(2));
  const level = levelFromRatio(ratio);
  return { level, ratio, reason: emergencyReason(level) };
}

// 상담 등록 단계에서 확인한 대상 유형·증빙 제출 여부로 구조대상 여부를 판정합니다.
// 대상 후보이면서 증빙까지 제출됐으면 '구조 가능', 대상 후보인데 증빙 미제출이면 '검토 필요',
// 애초에 대상 후보가 아니면 '부적합'으로 봅니다.
export function resolveEligibilityFromCase(selectedCase, fallbackCheck) {
  const memoText = `${selectedCase?.memo || ''} ${selectedCase?.inpersonMemo || ''}`;
  const attachmentNames = (selectedCase?.attachments || [])
    .map((item) => item.name || item.fileName || '')
    .join('\n');
  // 시연 대본에 기초생활수급 사실이 명시되고 수급자 증명서가 첨부되면, 별도의 등록 폼
  // 입력이 없어도 무료 법률구조 대상 후보와 증빙 제출 상태를 일관되게 표시합니다.
  const hasBasicLivelihoodStatus = memoText.includes('기초생활수급자');
  const hasBasicLivelihoodCertificate = attachmentNames.includes('기초생활수급자증명서');
  const inferredEligibilityCheck = hasBasicLivelihoodStatus ? {
    isTargetCandidate: true,
    evidenceSubmitted: hasBasicLivelihoodCertificate || Boolean(selectedCase?.eligibilityCheck?.evidenceSubmitted),
    requiredEvidence: '기초생활수급자증명서',
    applicantType: '기초생활수급자',
  } : null;
  const eligibilityCheck = inferredEligibilityCheck || selectedCase?.eligibilityCheck || fallbackCheck || null;
  const isTargetCandidate = Boolean(eligibilityCheck?.isTargetCandidate);
  const evidenceSubmitted = Boolean(eligibilityCheck?.evidenceSubmitted);
  const eligibility = isTargetCandidate ? (evidenceSubmitted ? '구조 가능' : '검토 필요') : '부적합';
  return { eligibilityCheck, isTargetCandidate, evidenceSubmitted, eligibility };
}
// 상담 목록을 최신순으로 돌려줍니다.
//
// 예전에는 정렬이 아예 없어서, 서버에서 이번에 처음 받아온 상담이 맨 앞에 오고 그 뒤에
// 브라우저에 있던 것이 붙는 순서였습니다(App의 [...additions, ...mergedItems]). 화면은
// 그 0번을 기본 선택으로 쓰기 때문에, 새 브라우저로 열면 제일 오래된 상담이 먼저 떴습니다.
//
// 이 함수는 기본 선택(각 workbench)과 목록 표시(CasePicker)가 모두 거쳐가는 자리라,
// 여기서 한 번 정렬하면 화면마다 따로 맞출 필요가 없습니다.
//
// 접수일(date, YYYY-MM-DD)과 접수시각(registeredTime, HH:MM)을 이어 붙여 문자열로 비교합니다
// — 둘 다 앞자리가 큰 자리라 사전순 비교가 곧 시간순입니다. 서버에서 복원한 상담은
// registeredTime이 비어 있어 같은 날짜 안에서는 뒤로 가는데, 그때는 id로 가릅니다
// (로컬에서 나중에 만들수록 id가 큽니다).
export function caseOptions(consultations) {
  if (!consultations.length) {
    return [{ id: 'empty', caseNo: '상담 선택', title: '등록된 상담이 없습니다.' }];
  }
  const receivedAt = (item) => `${item?.date || ''} ${item?.registeredTime || ''}`.trim();
  // 원본을 건드리지 않습니다 — React 상태 배열이라 제자리 정렬하면 렌더가 어긋납니다.
  return [...consultations].sort((left, right) => {
    const compared = receivedAt(right).localeCompare(receivedAt(left));
    if (compared !== 0) return compared;
    return Number(right?.id || 0) - Number(left?.id || 0);
  });
}

// 서식 추천(legalTemplateSeed)과 법령·판례 검색은 소분류(caseSubtype) 단위로 데이터가 연결돼 있습니다.
// (legalTemplateSeed의 caseType 필드가 실제로는 '가사소송일반' 같은 소분류 값입니다.)
// AI 분석은 대분류(caseType)와 소분류(caseSubtype)를 따로 주므로, 소분류가 있으면 그걸 우선 쓰고
// 없거나 이 시스템이 모르는 값이면 대분류로, 그마저 없으면 상담 등록 때 고른 유형으로 내려갑니다.
export function resolveConfirmedCaseType(selectedCase) {
  const analysis = selectedCase?.analysis;
  if (isKnownCaseType(analysis?.caseSubtype)) return analysis.caseSubtype;
  if (isKnownCaseType(analysis?.caseType)) return analysis.caseType;
  return selectedCase?.type;
}

export function casePickerFields(item) {
  return [
    item.caseNo,
    item.name,
    item.title,
    item.type,
    item.subtype,
    item.date,
    item.registeredTime,
  ].filter(Boolean);
}

export function matchesCasePickerQuery(item, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return casePickerFields(item).some((field) => String(field).toLowerCase().includes(normalizedQuery));
}

export function casePickerDateLabel(item) {
  if (!item?.date) return '등록일시 미기록';
  return `${item.date}${item.registeredTime ? ` ${item.registeredTime}` : ''}`;
}
