const REQUIRED_ANALYSIS_FIELDS = [
  ['summary', (value) => typeof value === 'string' && value.trim().length > 0],
  ['case_type', (value) => typeof value === 'string' && value.trim().length > 0],
  ['urgency_level', (value) => typeof value === 'string' && value.trim().length > 0],
  ['eligibility', (value) => typeof value === 'string' && value.trim().length > 0],
  ['extracted_json', isPlainObject],
  ['missing_info_json', Array.isArray],
  ['checklist_json', (value) => Array.isArray(value) || isPlainObject(value)],
  ['timeline_json', Array.isArray],
];

const TOKEN_STOP_WORDS = new Set([
  '그리고', '그러나', '그래서', '관련', '대한', '대해서', '경우', '부분', '상황',
  '내용', '확인', '필요', '가능', '있습니다', '없습니다', '합니다', '됩니다',
  '상담원', '내담자', '말씀', '오늘', '현재', '정도', '통해', '위해',
]);

const KOREAN_TOKEN_SUFFIXES = [
  '했습니다', '되었습니다', '있습니다', '없습니다', '합니다', '입니다',
  '해야', '했고', '하고', '되는', '되어', '된다', '이며', '이고',
  '에서', '으로', '에게', '까지', '부터', '처럼', '보다',
  '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도',
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) output.push(trimmed);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output));
    return output;
  }
  if (isPlainObject(value)) Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !TOKEN_STOP_WORDS.has(token));
}

function normalizeKoreanToken(token) {
  const suffix = KOREAN_TOKEN_SUFFIXES.find((item) => (
    token.endsWith(item) && token.length - item.length >= 2
  ));
  return suffix ? token.slice(0, -suffix.length) : token;
}

function buildClaimTexts(coreAnalysis) {
  const extracted = coreAnalysis.extracted_json || {};
  const timeline = (coreAnalysis.timeline_json || []).flatMap((item) => collectStrings(item));
  return [coreAnalysis.summary, extracted['사건개요'], ...timeline]
    .filter((value) => typeof value === 'string' && value.trim());
}

function calculateEvidenceSupport(coreAnalysis) {
  const sourceTokens = new Set(
    tokenize(collectStrings(coreAnalysis.raw_input_json || {}).join(' ')).map(normalizeKoreanToken),
  );
  const claimTokens = [...new Set(
    tokenize(buildClaimTexts(coreAnalysis).join(' ')).map(normalizeKoreanToken),
  )];

  if (sourceTokens.size === 0 || claimTokens.length === 0) {
    return { grounded: false, supportRatio: 0, reason: sourceTokens.size === 0 ? 'source_text_missing' : 'claims_missing' };
  }

  const supportRatio = claimTokens.filter((token) => sourceTokens.has(token)).length / claimTokens.length;
  return {
    grounded: supportRatio >= 0.3,
    supportRatio,
    reason: supportRatio >= 0.3 ? null : 'weak_transcript_support',
  };
}

// 서버 검증이 근거 검색 실패 등으로 unavailable을 돌려줄 때만 실행합니다. 서버의 E5/MLP
// 결과를 덮어쓰지 않고, 브라우저가 받은 분석 계약과 상담 원문으로 세 표시를 안전하게 채웁니다.
export function buildClientOutputValidation(coreAnalysis = {}, unavailableResult = {}) {
  const missingFields = REQUIRED_ANALYSIS_FIELDS
    .filter(([field, validate]) => !validate(coreAnalysis[field]))
    .map(([field]) => field);
  const format = missingFields.length === 0;
  const evidence = calculateEvidenceSupport(coreAnalysis);
  // 화면 계약의 누락은 형식 확인 대상으로 분리합니다. 출력 모양이 맞지 않는다고 해서
  // 상담 원문에 없는 사실을 만들어 냈다는 뜻은 아니므로, 환각 위험을 자동으로 높이지 않습니다.
  const decision = !format || !evidence.grounded ? 'review_required' : 'safe';
  const hallucinationRisk = decision === 'review_required' ? 'review' : 'low';
  const hasSourceMaterial = Boolean(
    coreAnalysis?.raw_input_json
    || coreAnalysis?.extracted_json?.사건개요
    || coreAnalysis?.extracted_json?.attachment_links?.length,
  );

  return {
    available: true,
    format,
    grounded: evidence.grounded,
    hallucinationRisk,
    formatLabel: format ? '통과' : '확인 필요',
    evidenceLabel: evidence.grounded ? '근거 확인' : hasSourceMaterial ? '자료 확인 참고' : '근거 보강 필요',
    riskLabel: hallucinationRisk === 'high' ? '높음' : hallucinationRisk === 'review' ? (hasSourceMaterial ? '참고 확인' : '검토 필요') : '낮음',
    decision,
    reviewReasons: [
      ...missingFields.map((field) => `missing required field: ${field}`),
      ...(evidence.reason ? [evidence.reason] : []),
    ],
    supportRatio: evidence.supportRatio,
    executionMode: 'client_fallback',
    serverUnavailableReason: unavailableResult?.reason || 'validation_result_missing',
  };
}
