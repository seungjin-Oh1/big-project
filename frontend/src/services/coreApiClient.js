const CORE_API_BASE_URL = import.meta.env.VITE_CORE_API_BASE_URL || '/core-api';
const CORE_API_ERROR_CODE = {
  CONNECTION_FAILED: 'CORE_CONNECTION_FAILED',
  SCHEMA_MISMATCH: 'CORE_SCHEMA_MISMATCH',
  ENCRYPTION_DATA_ISSUE: 'CORE_ENCRYPTION_DATA_ISSUE',
  REQUEST_FAILED: 'CORE_REQUEST_FAILED',
};

function extractCoreErrorMessage(bodyText, fallback) {
  try {
    const parsed = bodyText ? JSON.parse(bodyText) : null;
    return parsed?.message || parsed?.error || fallback;
  } catch {
    return bodyText || fallback;
  }
}

function buildCoreApiError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isSchemaMismatchMessage(message = '') {
  return message.includes('approval_status') && (message.includes('칼럼') || message.includes('column') || message.includes('移쇰읆'));
}

function isEncryptionDataIssueMessage(message = '') {
  return [
    'Error attempting to apply AttributeConverter',
    'AttributeConverter',
    'AEADBadTagException',
    'Illegal base64 character',
    'Last unit does not have enough valid bits',
  ].some((keyword) => message.includes(keyword));
}

function classifyCoreError(message, status) {
  if (isSchemaMismatchMessage(message)) {
    return {
      code: CORE_API_ERROR_CODE.SCHEMA_MISMATCH,
      message: 'Core API는 실행 중이지만 DB users 테이블에 approval_status 컬럼이 없습니다. 현재 프론트는 가능한 기능에서 ai-api/로컬 검토 큐 fallback을 사용합니다.',
    };
  }

  if (isEncryptionDataIssueMessage(message)) {
    return {
      code: CORE_API_ERROR_CODE.ENCRYPTION_DATA_ISSUE,
      message: 'Core API는 실행 중이지만 암호화 컬럼 복호화에 실패했습니다. backend/core-api의 PII_ENCRYPTION_KEY 또는 DB의 users.name, users.email, consultation.client_name 데이터를 점검해야 합니다.',
    };
  }

  return {
    code: CORE_API_ERROR_CODE.REQUEST_FAILED,
    message: message || `Core API 요청 실패 (HTTP ${status})`,
  };
}

function normalizeCoreErrorMessage(message, status) {
  if (message?.includes('approval_status') && message?.includes('칼럼 없음')) {
    return 'Core API는 실행 중이지만 DB users 테이블에 approval_status 컬럼이 없습니다. 현재 프론트는 가능한 기능에서 ai-api/로컬 검토 큐 fallback을 사용합니다.';
  }
  return message || `Core API 요청 실패 (HTTP ${status})`;
}

async function requestCoreJson(path, options = {}) {
  let response;
  try {
    response = await fetch(`${CORE_API_BASE_URL}${path}`, {
      headers: options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
  } catch {
    throw new Error('Core API 서버에 연결할 수 없습니다. Spring Boot 서버가 켜져 있는지 확인해주세요.');
  }

  if (response.status === 204) return null;
  if (!response.ok) {
    // 백엔드가 JSON(message/error) 또는 텍스트로 내려주는 오류를 한 번 정리한 뒤,
    // 사용자 화면에 그대로 노출하기 어려운 JDBC 원문은 진단 가능한 짧은 문장으로 치환합니다.
    const bodyText = await response.text().catch(() => '');
    const rawMessage = extractCoreErrorMessage(bodyText, `Core API 요청 실패 (HTTP ${response.status}): ${response.statusText}`);
    throw new Error(normalizeCoreErrorMessage(rawMessage, response.status));
  }

  return response.json();
}

// 프론트 역할 키(counselor/lawyer/admin) ↔ 백엔드 UserRole(CONSULTANT/LAWYER/ADMIN) 변환.
// 예전엔 admin이 아니면 무조건 CONSULTANT로 보내서 변호사 계정도 상담원 권한으로 등록되는 문제가 있었습니다.
function toCoreRole(role) {
  if (role === 'admin') return 'ADMIN';
  if (role === 'lawyer') return 'LAWYER';
  return 'CONSULTANT';
}

function toFrontendRole(coreRole) {
  if (coreRole === 'ADMIN') return 'admin';
  if (coreRole === 'LAWYER') return 'lawyer';
  return 'counselor';
}

function authHeader(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// POST /api/auth/register — 이름/역할/이메일/비밀번호만 백엔드로 보냅니다.
// (소속기관·부서·연락처는 아직 백엔드 스키마에 없어 프론트 로컬 저장소에만 별도로 보관합니다)
export function registerCoreUser({ name, role, email, password }) {
  return requestCoreJson('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, role: toCoreRole(role), email, password }),
  });
}

// POST /api/auth/login — 실패 시 백엔드가 내려주는 문구(이메일/비밀번호 불일치, 승인 대기, 거절)를 그대로 씁니다.
export function loginCoreUser({ email, password }) {
  return requestCoreJson('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

// POST /api/users/{id}/approve, /reject — 관리자 전용(JWT 필요). SecurityConfig가 ADMIN 역할만 허용합니다.
export function approveCoreUser(backendId, token) {
  return requestCoreJson(`/api/users/${backendId}/approve`, { method: 'POST', headers: authHeader(token) });
}

export function rejectCoreUser(backendId, token) {
  return requestCoreJson(`/api/users/${backendId}/reject`, { method: 'POST', headers: authHeader(token) });
}

// login/register 응답(AuthResponse: token/userId/name/role/email)을 프론트에서 바로 쓰기 좋은 모양으로 바꿉니다.
// 승인 대기 중인 회원가입 응답은 token이 null로 옵니다(AuthService 참고) — 그대로 넘겨서
// 호출부가 "토큰이 없으면 아직 로그인할 수 없다"를 판단할 수 있게 합니다.
export function normalizeAuthResponse(response) {
  if (!response) return null;
  return {
    token: response.token || '',
    backendId: response.userId,
    name: response.name || '',
    role: toFrontendRole(response.role),
    email: response.email || '',
  };
}

function toCoreAttachmentRegistration(item = {}) {
  return {
    fileName: item.name || '',
    fileType: item.category || '',
    fileKey: item.fileKey || '',
    fileUrl: item.uploadedUrl || '',
    contentType: item.mimeType || '',
  };
}

function toCoreConsultationPayload({ userId, consultation }) {
  return {
    userId,
    title: consultation.title || consultation.caseNo || '상담 제목 미입력',
    // clientName(내담자 본인 이름)은 api.md 기준 필수 필드입니다. 예전엔 이 필드를 아예 안 보내고
    // 내담자 이름을 opponentName(상대방 이름) 자리에 잘못 넣고 있었습니다 — 분리해 각자 제자리로 보냅니다.
    clientName: consultation.name || consultation.clientName || '이름 미입력',
    inputText: consultation.memo || consultation.title || '',
    opponentName: consultation.opponentName || '',
    category: consultation.category || '',
    type: consultation.type || '',
    legalAidType: consultation.legalAidType || 'none',
    eligibilityEvidenceSubmitted: Boolean(consultation.eligibilityCheck?.evidenceSubmitted),
    // fileKey가 없는 항목(S3 업로드 실패로 로컬 폴백된 파일)은 서버에 등록할 실체가 없으므로 제외합니다.
    attachments: (consultation.attachments || [])
      .filter((item) => item.fileKey)
      .map(toCoreAttachmentRegistration),
  };
}

function normalizeAnalysisAttachment(item = {}) {
  return {
    category: item.category || item.fileType || '',
    fileName: item.name || item.fileName || '',
    fileType: item.mimeType || item.fileType || '',
    storageBucket: item.storageBucket || '',
    fileKey: item.fileKey || item.key || '',
    fileUrl: item.uploadedUrl || item.fileUrl || item.downloadUrl || '',
    status: item.status || '',
  };
}

function buildCoreExtractedJson(analysis = {}) {
  const extractedJson = { ...(analysis.extractedJson || {}) };
  const sourceAttachments = analysis.sourceAttachments?.length ? analysis.sourceAttachments : analysis.attachments || [];
  const attachmentLinks = sourceAttachments
    .map(normalizeAnalysisAttachment)
    .filter((item) => item.fileName || item.fileKey || item.fileUrl);

  if (attachmentLinks.length) {
    extractedJson.attachment_links = attachmentLinks;
    extractedJson.submitted_file_link = attachmentLinks
      .map((item) => item.fileKey || item.fileUrl)
      .filter(Boolean);
  }

  return extractedJson;
}

function toCoreAnalysisPayload(analysis = {}) {
  return {
    summary: analysis.summary || '',
    case_type: analysis.caseType || '',
    case_subtype: analysis.caseSubtype || '',
    urgency_level: analysis.urgency || '',
    eligibility: analysis.eligibility || '',
    extracted_json: buildCoreExtractedJson(analysis),
    missing_info_json: analysis.missingInfo || [],
    checklist_json: (analysis.checklist || []).map((item) => ({ 항목: item.label, 결과: item.checked ? '충족' : '미확인' })),
    recommendation_json: analysis.recommendation || { 법령: [], 판례: [], 유사사례: [] },
    timeline_json: (analysis.timeline || []).map((item) => ({ 날짜: item.date, 내용: item.text })),
    cluster_result_json: analysis.clusterResult || [],
    estimated_time: analysis.estimatedTime || null,
  };
}

function normalizeCoreConsultation(row) {
  return {
    coreId: row.id,
    coreUserId: row.userId,
    title: row.title,
    clientName: row.clientName || '',
    memo: row.inputText || '',
    opponentName: row.opponentName || '',
    coreStatus: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    coreAttachments: row.attachments || [],
  };
}

export async function ensureCoreUser(user) {
  const users = await requestCoreJson('/api/users');
  const existing = users.find((item) => item.email === user.email);
  if (existing) return existing;
  return requestCoreJson('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      name: user.name || user.email || '상담원',
      role: toCoreRole(user.role),
      email: user.email || `local-${Date.now()}@example.local`,
    }),
  });
}

export async function createCoreConsultation({ currentUser, consultation }) {
  const coreUser = await ensureCoreUser(currentUser || { name: '상담원', role: 'counselor', email: 'local-counselor@example.local' });
  const created = await requestCoreJson('/api/consultations', {
    method: 'POST',
    body: JSON.stringify(toCoreConsultationPayload({ userId: coreUser.id, consultation })),
  });
  return normalizeCoreConsultation(created);
}

export function fetchCoreConsultations() {
  return requestCoreJson('/api/consultations');
}

export function fetchCoreUsers() {
  return requestCoreJson('/api/users');
}

export function checkCoreApiStatus() {
  return Promise.all([fetchCoreUsers(), fetchCoreConsultations()]).then(([users, consultations]) => ({
    users,
    consultations,
    userCount: users.length,
    consultationCount: consultations.length,
  }));
}

export async function deleteCoreConsultation(coreId) {
  if (!coreId) return null;
  return requestCoreJson(`/api/consultations/${coreId}`, { method: 'DELETE' });
}

export async function updateCoreConsultation(coreId, changes) {
  if (!coreId) return null;
  return requestCoreJson(`/api/consultations/${coreId}`, {
    method: 'PUT',
    body: JSON.stringify(changes),
  });
}

export function updateCoreConsultationStatus(coreId, status) {
  return updateCoreConsultation(coreId, { status });
}

export async function createCoreAnalysis({ consultation, analysis }) {
  if (!consultation?.coreId) return null;
  return requestCoreJson(`/api/consultations/${consultation.coreId}/analyses`, {
    method: 'POST',
    body: JSON.stringify(toCoreAnalysisPayload(analysis)),
  });
}

// core-api가 서버 간(backend-to-backend)으로 ai-api의 /consult/analyze를 실행하고,
// 그 결과를 ai_analysis 테이블에 저장까지 마친 뒤 돌려주는 진입점.
// (예전에는 프론트가 ai-api를 직접 호출했지만, 이제 core-api가 오케스트레이션을 담당함)
export async function triggerCoreAnalysis(consultation) {
  if (!consultation?.coreId) {
    throw new Error('Core API에 동기화되지 않은 상담입니다.');
  }
  return requestCoreJson(`/api/consultations/${consultation.coreId}/analyze`, { method: 'POST' });
}

const CORE_ELIGIBILITY_LABEL = {
  대상: '구조 가능',
  비대상: '부적합',
  판단보류: '보류',
};

// ai-api relief_review_checklist(4대 평가기준 객체)를 화면의 고정 4개 체크리스트 항목으로 재구성합니다.
// 라벨 문자열은 workflows.jsx의 로컬 체크리스트/토글 로직과 그대로 맞춰야 함(레이블로 매칭하는 코드가 있음).
function mapCoreChecklist(relief = {}) {
  const eligibilityResult = relief.eligibility || {};
  return [
    { label: '법률구조 대상 여부 확인', checked: Boolean(eligibilityResult.eligible) },
    { label: '법률구조 대상자 증빙서류 제출 여부 확인', checked: eligibilityResult.evidence_status === '충족' },
    { label: '승소 가능성 기초자료 확인', checked: Boolean(relief.winnability) },
    { label: '추가자료 요청 필요 여부 확인', checked: Boolean(relief.appropriateness) },
  ];
}

// core-api에 저장된 AiAnalysisResponse(=/consult/analyze 결과가 반영된 형태)를 프론트 내부에서 쓰는
// analysis 객체 모양(camelCase)으로 옮겨 담습니다. mapContractAnalysisResponse(legalAidApi.js, 구 /analysis
// 계약용)와 같은 출력 형태를 만들어서, 이 함수를 호출하는 workflows.jsx의 나머지 병합 로직은 그대로 재사용합니다.
// 주의: AiAnalysisResponse는 @JsonNaming(SnakeCaseStrategy)라서 실제 JSON 키는 case_type/urgency_level/
// extracted_json처럼 snake_case로 옴 — fetch가 자동으로 camelCase 변환을 해주지 않으므로 여기서 snake_case
// 키를 그대로 읽어야 함 (eligibility/summary처럼 단어가 하나뿐인 필드는 우연히 안 틀림).
// timeline은 일부러 포함하지 않습니다 — /consult/analyze 응답엔 타임라인 데이터가 없어서, 빈 배열을 반환하면
// 호출부의 스프레드(...mapped)가 기존 로컬 타임라인을 지워버리기 때문입니다.
export function mapCoreAnalysisResponse(coreAnalysis = {}) {
  const caseAnalysis = coreAnalysis.extracted_json || {};
  const relief = coreAnalysis.checklist_json || {};
  const missingItems = Array.isArray(coreAnalysis.missing_info_json) ? coreAnalysis.missing_info_json : [];
  const topCase = caseAnalysis.case_list?.[0] || {};
  return {
    summary: coreAnalysis.summary || '',
    caseType: coreAnalysis.case_type || '미분류',
    caseTypeReason: topCase.case_type_reason || '',
    urgency: coreAnalysis.urgency_level || '하',
    emergencyRatio: typeof caseAnalysis.case_emergency_ratio === 'number' ? caseAnalysis.case_emergency_ratio : null,
    eligibility: CORE_ELIGIBILITY_LABEL[coreAnalysis.eligibility] || '검토 필요',
    missingInfo: missingItems.map((item) => item?.item || item?.reason || '').filter(Boolean),
    checklist: mapCoreChecklist(relief),
    extractedJson: caseAnalysis,
  };
}

// PUT /api/consultations/{id}/analyses/{analysisId} — 이미 저장된 분석을 같은 analysis_id에 덮어씁니다.
// AiAnalysisService.update()는 부분 업데이트(null이 아닌 필드만 반영)라 create와 같은 페이로드를 그대로 보내도 안전합니다.
// 이게 없으면 상담원이 분석을 수정해서 다시 저장할 때마다 analyses 테이블에 같은 상담 건의 새 행이 계속 쌓입니다.
export async function updateCoreAnalysis({ consultation, analysisId, analysis }) {
  if (!consultation?.coreId || !analysisId) return null;
  return requestCoreJson(`/api/consultations/${consultation.coreId}/analyses/${analysisId}`, {
    method: 'PUT',
    body: JSON.stringify(toCoreAnalysisPayload(analysis)),
  });
}

// POST /api/consultations/{id}/attachments — 실제 첨부파일 업로드(멀티파트).
// AttachmentController(backend/core-api)가 파일을 서버에 저장하고 DB에 메타데이터를 남깁니다.
// (예전에 프론트가 기대하던 presigned-URL 업로드는 백엔드에 없는 엔드포인트라 항상 실패했습니다 —
// 실제로 구현된 이 엔드포인트로 바꿉니다)
export function uploadCoreAttachment(consultationId, file, fileType) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('fileType', fileType || '기타');
  return requestCoreJson(`/api/consultations/${consultationId}/attachments`, {
    method: 'POST',
    body: formData,
  });
}

// ── 서식 추천 · 초안 생성 · 변호사 검토 워크플로우 ──
// GeneratedDocumentController(backend/core-api)와 짝을 이루는 함수들입니다.
// 이 컨트롤러의 응답 DTO는 전부 @JsonNaming(SnakeCaseStrategy)라 필드가 snake_case로 옵니다.
// (예: documentId -> document_id) — 호출부에서 응답을 읽을 때 이 점을 유의해야 합니다.

// POST /api/consultations/{id}/analyses/{analysisId}/recommend-forms — DB에 저장하지 않는 추천만 조회.
// 분석 저장이 core-api에 안 됐다면(coreId/analysisId 없음) 호출부가 아예 부르지 않아야 합니다.
export function recommendCoreForms(consultationId, analysisId) {
  return requestCoreJson(`/api/consultations/${consultationId}/analyses/${analysisId}/recommend-forms`, { method: 'POST' });
}

// POST /api/consultations/{id}/analyses/{analysisId}/generate-draft — 실제 초안 파일을 생성하고
// DRAFTED 상태로 저장. 응답의 document_id가 이후 검토 요청/승인/반려 호출의 기준이 됩니다.
export function generateCoreDraft(consultationId, analysisId, formName) {
  return requestCoreJson(`/api/consultations/${consultationId}/analyses/${analysisId}/generate-draft`, {
    method: 'POST',
    body: JSON.stringify({ form_name: formName }),
  });
}

// GET /api/consultations/{id}/documents — 이 상담에 생성된 서식 초안 전체(상태 무관).
export function fetchCoreDocuments(consultationId) {
  return requestCoreJson(`/api/consultations/${consultationId}/documents`);
}

// GET /api/consultations/{id}/documents/{documentId}/download — 생성된 hwpx 원본 다운로드 URL.
// core-api에 실제로 저장된 문서(=documentId가 DB row인 경우)만 유효합니다. ai-api를 직접 호출했거나
// 브라우저에서 즉석 생성한 로컬 전용 문서(source: ai-api-local/text-local/client-hwpx)는 이 URL로
// 못 받습니다 — 그런 경우는 호출부가 이 함수를 아예 안 쓰고 기존 draft_file_path(blob: 등)를 씁니다.
export function buildCoreDocumentDownloadUrl(consultationId, documentId) {
  if (!consultationId || !documentId) return '';
  return `${CORE_API_BASE_URL}/api/consultations/${consultationId}/documents/${documentId}/download`;
}

// POST .../documents/{documentId}/submit-for-review — 상담원: 변호사에게 검토 요청.
export function submitCoreDocumentForReview(consultationId, documentId) {
  return requestCoreJson(`/api/consultations/${consultationId}/documents/${documentId}/submit-for-review`, { method: 'POST' });
}

// POST .../documents/{documentId}/approve — 변호사 전용(JWT 필요, SecurityConfig가 LAWYER만 허용).
export function approveCoreDocument(consultationId, documentId, note, token) {
  return requestCoreJson(`/api/consultations/${consultationId}/documents/${documentId}/approve`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ note: note || '' }),
  });
}

// POST .../documents/{documentId}/request-revision — 변호사 전용(JWT 필요). note는 반려 사유(필수),
// requestedMaterials는 상담원에게 추가로 요청하는 자료 목록(선택).
export function requestCoreDocumentRevision(consultationId, documentId, note, requestedMaterials, token) {
  return requestCoreJson(`/api/consultations/${consultationId}/documents/${documentId}/request-revision`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ note, requested_materials: requestedMaterials || [] }),
  });
}

// ── AI 분석 결과 검토 워크플로우 ──
// AiAnalysisController(backend/core-api)가 새로 추가한 검토 엔드포인트(2026-07-27 push)와 짝을 이루는
// 함수들입니다. 서식 초안 검토(DocumentReviewStatus)와 상태 이름은 같지만 AnalysisReviewStatus는
// 별개 도메인이고, 응답도 같은 @JsonNaming(SnakeCaseStrategy)라 필드가 snake_case로 옵니다.

// POST .../analyses/{analysisId}/submit-for-review — 상담원: 확인/수정 끝난 분석 결과를 검토 요청.
export function submitCoreAnalysisForReview(consultationId, analysisId) {
  return requestCoreJson(`/api/consultations/${consultationId}/analyses/${analysisId}/submit-for-review`, { method: 'POST' });
}

// POST .../analyses/{analysisId}/approve — 변호사 전용(JWT 필요, SecurityConfig가 LAWYER만 허용).
export function approveCoreAnalysis(consultationId, analysisId, note, token) {
  return requestCoreJson(`/api/consultations/${consultationId}/analyses/${analysisId}/approve`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ note: note || '' }),
  });
}

// POST .../analyses/{analysisId}/request-revision — 변호사 전용(JWT 필요).
// note는 반려 사유(AnalysisReviewRequest.note) — 서식 반려(RequestRevisionRequest.note)와 달리 필수 아님.
export function requestCoreAnalysisRevision(consultationId, analysisId, note, token) {
  return requestCoreJson(`/api/consultations/${consultationId}/analyses/${analysisId}/request-revision`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ note: note || '' }),
  });
}

// GET .../analyses — 사건의 분석 이력 전체(재분석 포함). 변호사 대시보드가 SUBMITTED_FOR_REVIEW 건만
// 추려 보여줄 때 씁니다.
export function fetchCoreAnalyses(consultationId) {
  return requestCoreJson(`/api/consultations/${consultationId}/analyses`);
}

// ── 관리자 대시보드 통계 ──
// GET /api/admin/stats [ADMIN] — 요약 카드(전체 상담/활성 사용자/분석 처리율/승인 대기) +
// 사건유형별 통계 + 분석 처리 현황을 한 번에 내려줍니다. 목록(표) 데이터는 이 API가 아니라
// 기존 /api/consultations, .../analyses 등을 따로 호출해야 합니다(api.md 참고).
export function fetchCoreAdminStats(token) {
  return requestCoreJson('/api/admin/stats', { headers: authHeader(token) });
}

export { CORE_API_BASE_URL };
