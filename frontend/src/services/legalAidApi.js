import { attachmentTypes, legalTemplateSeed } from '../data/domain.js';

// 백엔드 연동 전 프론트엔드 화면을 완성하기 위한 임시 서비스 계층입니다.
// 실제 API가 준비되면 아래 apiEndpoints 주소를 기준으로 fetch/axios 호출로 교체하면 됩니다.

// 실제 백엔드 응답 대기 시간을 흉내내는 임시 헬퍼입니다. (로딩 오버레이 동작 확인용)
// 각 함수가 실제 fetch 호출로 교체되면 이 지연도 자연스럽게 사라집니다.
export function simulateBackendLatency(durationMs = 2400) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export const apiEndpoints = {
  core: {
    consultations: '/api/consultations',
    reviews: '/api/reviews',
    users: '/api/users',
    auditLogs: '/api/audit-logs',
  },
  ai: {
    stt: '/ai/stt',
    analysis: '/ai/analysis',
    references: '/ai/references',
  },
  document: {
    templates: '/document/templates',
    generate: '/document/generate',
    parse: '/document/parse',
  },
};

// 파일 업로드 UI에서 선택한 파일을 S3 업로드 전 단계의 메타데이터로 변환합니다.
export function createAttachmentMetadata(file, categoryLabel) {
  const matchedType = attachmentTypes.find((item) => item.label === categoryLabel);
  return {
    id: `${categoryLabel}-${file.name}-${file.lastModified}`,
    category: categoryLabel,
    storageBucket: matchedType?.storageBucket || 'misc-documents',
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    localObjectUrl: URL.createObjectURL(file),
    // fileKey: S3에 올라간 파일의 키(위치). 백엔드 DB(Attachment)에 기록할 링크값입니다.
    // uploadedUrl: 열람용 접근 경로. 둘 다 S3 직접 업로드가 성공해야 채워집니다.
    fileKey: null,
    uploadedUrl: null,
    extractedText: '',
    status: '로컬 선택',
    file,
  };
}

// AI 분석 요청 시 backend/ai-api로 전달할 데이터 형태를 한곳에서 관리합니다.
function normalizeAttachmentForApi(item = {}) {
  return {
    category: item.category || '',
    name: item.name || '',
    size: item.size || 0,
    mimeType: item.mimeType || '',
    storageBucket: item.storageBucket || '',
    fileKey: item.fileKey || '',
    uploadedUrl: item.uploadedUrl || '',
    extractedText: item.extractedText || '',
    status: item.status || '',
  };
}

// 첨부자료 하나에서 'AI가 실제로 열어볼 수 있는 위치' 한 개만 골라 링크 목록을 만듭니다.
// S3 키가 있으면 그것이 가장 정확하고, 없으면 열람 URL, 그것도 없으면 파일명으로 내려갑니다.
// 여러 곳에서 같은 우선순위를 다시 쓰지 않도록 이 함수 하나로 모읍니다.
export function toSubmittedFileLinks(attachments = []) {
  return attachments
    .map((item) => item.fileKey || item.uploadedUrl || item.fileUrl || item.name || item.fileName)
    .filter(Boolean);
}

export function createAnalysisPayload(consultation) {
  const attachments = (consultation.attachments || []).map(normalizeAttachmentForApi);
  const submittedFileLinks = toSubmittedFileLinks(attachments);

  return {
    consultationId: consultation.id,
    inputText: consultation.memo || consultation.title || '',
    attachments,
    submittedFileLinks,
    requestedOutputs: [
      'summary',
      'case_type',
      'urgency_level',
      'eligibility',
      'missing_info_json',
      'checklist_json',
      'timeline_json',
      'recommendation_json',
    ],
  };
}

// AI_ANALYSIS 계약(contracts/ai_analysis_mock.json, snake_case + 한글 키)으로 온 응답을
// 프론트 내부에서 쓰는 analysis 객체 모양(camelCase)으로 옮겨 담는 책임만 담당합니다.
export function mapContractAnalysisResponse(contractResult) {
  const eligibilityLabel = {
    대상후보: '검토 필요',
    비대상후보: '부적합',
    확인필요: '검토 필요',
  };
  return {
    summary: contractResult.summary || '',
    caseType: contractResult.case_type || '미분류',
    caseSubtype: contractResult.case_subtype || '',
    urgency: contractResult.urgency_level || contractResult.case_emergency_level || '하',
    // 백엔드 AI가 사건별 긴급도 점수(0.0~1.0)를 주면 그대로 전달합니다. (계약 mock에는 아직 없어 보통 null)
    emergencyRatio: typeof contractResult.case_emergency_ratio === 'number' ? contractResult.case_emergency_ratio
      : typeof contractResult.urgency_ratio === 'number' ? contractResult.urgency_ratio : null,
    eligibility: eligibilityLabel[contractResult.eligibility] || '검토 필요',
    missingInfo: contractResult.missing_info_json || [],
    checklist: (contractResult.checklist_json || []).map((item) => ({
      label: item['항목'],
      checked: item['결과'] === '충족',
    })),
    timeline: (contractResult.timeline_json || []).map((item) => ({
      date: item['날짜'],
      text: item['내용'],
    })),
    extractedJson: contractResult.extracted_json || {},
  };
}

// 확정된 사건 소분류에 맞는 서식만 골라 돌려줍니다. (소분류가 같은 서식 + 모든 사건에 쓰는 '공통' 서식)
// 맞는 서식이 하나도 없을 때 '전체 291개'를 돌려주면 추천이 잘 된 것처럼 보이지만
// 실제로는 사건과 무관한 서식이 늘어섭니다. 없으면 없다고 빈 목록을 돌려주고, 안내는 화면이 합니다.
export function recommendTemplates(caseType) {
  if (!caseType) return [];
  return legalTemplateSeed.filter((template) => template.caseType === caseType || template.caseType === '공통');
}

export function validateAnalysisResult(result) {
  const requiredKeys = ['summary', 'caseType', 'urgency', 'eligibility', 'missingInfo', 'checklist', 'timeline'];
  return requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(result, key));
}

// document-api 연결 전까지 서식 초안 미리보기를 생성하는 임시 함수입니다.
// caseType은 화면에서 '이 서식 체계에 실제로 존재하는 유형'으로 걸러서 넘겨줍니다.
// (분석 결과를 여기서 직접 꺼내 쓰면, 서식과 맞지 않는 유형이 초안 본문에 그대로 박힙니다)
export function generateDraftText({ templateName, consultation, analysis, caseType }) {
  const missing = analysis?.missingInfo?.length ? analysis.missingInfo.join(', ') : '없음';
  return [
    `${templateName} 초안`,
    '',
    `사건명: ${consultation?.title || '상담 미선택'}`,
    `사건유형: ${caseType || consultation?.type || '미분류'}`,
    `요약: ${analysis?.summary || '상담 분석 후 자동 입력됩니다.'}`,
    `누락자료: ${missing}`,
    '',
    '청구 취지와 사실관계는 담당자가 검토 후 확정해야 합니다.',
  ].join('\n');
}

export function searchReferenceCandidates({ type, query = '', caseType = '' }) {
  // 가사법 4대 분류(친족/상속/가사소송/가족관계등록)에 맞춰 참고 판례·법령 예시를 구성했습니다.
  // 실제 법령·판례 추천 API가 붙기 전까지 쓰는 임시 후보 목록입니다.
  const precedent = [
    { id: 'P-001', title: '재판상 이혼 사유(부당한 대우) 인정 판례', source: '국가법령정보센터', caseType: '재판상이혼 등' },
    { id: 'P-002', title: '재산분할 대상 및 기여도 산정 판례', source: '국가법령정보센터', caseType: '이혼 및 재산분할청구권' },
    { id: 'P-003', title: '양육비 산정기준 적용 판례', source: '국가법령정보센터', caseType: '양육비' },
    { id: 'P-004', title: '유류분 반환범위 관련 판례', source: '국가법령정보센터', caseType: '유류분' },
    { id: 'P-005', title: '친양자 입양 요건 판단 판례', source: '국가법령정보센터', caseType: '입양, 파양, 친양자' },
  ];
  const statute = [
    { id: 'L-001', title: '민법 제4편 친족', source: '국가법령정보센터', caseType: '공통' },
    { id: 'L-002', title: '민법 제5편 상속', source: '국가법령정보센터', caseType: '공통' },
    { id: 'L-003', title: '가사소송법', source: '국가법령정보센터', caseType: '공통' },
    { id: 'L-004', title: '가족관계의 등록 등에 관한 법률', source: '국가법령정보센터', caseType: '공통' },
    { id: 'L-005', title: '양육비 산정기준표(대법원 가정법원)', source: '국가법령정보센터', caseType: '양육비' },
  ];
  // 유사 상담사례 추천(요구사항 AI-05-01-01): 법령·판례가 아니라 과거 유사 상담 이력을 매칭하는 별도 소스입니다.
  const similar = [
    { id: 'S-001', title: '[유사사례] 협의이혼 후 양육비 미지급 상담', source: '법률구조공단 상담이력', caseType: '양육비' },
    { id: 'S-002', title: '[유사사례] 재산분할 대상 재산 은닉 상담', source: '법률구조공단 상담이력', caseType: '이혼 및 재산분할청구권' },
    { id: 'S-003', title: '[유사사례] 상속재산분할 협의 불성립 상담', source: '법률구조공단 상담이력', caseType: '상속재산분할' },
    { id: 'S-004', title: '[유사사례] 면접교섭 불이행 상담', source: '법률구조공단 상담이력', caseType: '면접교섭권' },
  ];
  const source = type === 'precedent' ? precedent : type === 'similar' ? similar : statute;
  return source.filter((item) => {
    const matchesQuery = !query || item.title.includes(query);
    const matchesCase = !caseType || item.caseType === caseType || item.caseType === '공통';
    return matchesQuery && matchesCase;
  });
}

export function checkTemplateRevision() {
  return {
    checkedAt: new Date().toISOString(),
    source: 'helplaw24',
    changedTemplates: [],
    message: '현재 로컬 프로토타입에서는 변경된 서식이 없습니다.',
  };
}
