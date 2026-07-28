const CORE_API_BASE_URL = import.meta.env.VITE_CORE_API_BASE_URL || '/core-api';

const CORE_API_ERROR_CODE = {
  CONNECTION_FAILED: 'CORE_CONNECTION_FAILED',
  SCHEMA_MISMATCH: 'CORE_SCHEMA_MISMATCH',
  ENCRYPTION_DATA_ISSUE: 'CORE_ENCRYPTION_DATA_ISSUE',
  REQUEST_FAILED: 'CORE_REQUEST_FAILED',
};

const CORE_ELIGIBILITY_LABEL = {
  eligible: '구조 가능',
  ineligible: '부적합',
  pending: '검토 필요',
  '구조 가능': '구조 가능',
  부적합: '부적합',
  보류: '검토 필요',
  대상후보: '검토 필요',
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
  const normalized = message.toLowerCase();
  return normalized.includes('approval_status')
    && (normalized.includes('column') || normalized.includes('does not exist'));
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
      message: 'Core API는 실행 중이지만 DB users 테이블에 approval_status 컬럼이 없습니다.',
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

async function requestCoreJson(path, options = {}) {
  let response;
  try {
    response = await fetch(`${CORE_API_BASE_URL}${path}`, {
      headers: options.body instanceof FormData
        ? options.headers
        : { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
  } catch {
    throw buildCoreApiError(
      CORE_API_ERROR_CODE.CONNECTION_FAILED,
      'Core API 서버에 연결할 수 없습니다. Spring Boot 서버가 켜져 있는지 확인해주세요.',
    );
  }

  if (response.status === 204) return null;
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    const rawMessage = extractCoreErrorMessage(
      bodyText,
      `Core API 요청 실패 (HTTP ${response.status}): ${response.statusText}`,
    );
    const normalized = classifyCoreError(rawMessage, response.status);
    throw buildCoreApiError(normalized.code, normalized.message);
  }

  return response.json();
}

function toCoreRole(role) {
  if (role === 'admin' || role === 'ADMIN') return 'ADMIN';
  if (role === 'lawyer' || role === 'LAWYER') return 'LAWYER';
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

export function registerCoreUser({ name, role, email, password }) {
  return requestCoreJson('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, role: toCoreRole(role), email, password }),
  });
}

export function loginCoreUser({ email, password }) {
  return requestCoreJson('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function approveCoreUser(backendId, token) {
  return requestCoreJson(`/api/users/${backendId}/approve`, {
    method: 'POST',
    headers: authHeader(token),
  });
}

export function rejectCoreUser(backendId, token) {
  return requestCoreJson(`/api/users/${backendId}/reject`, {
    method: 'POST',
    headers: authHeader(token),
  });
}

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
    fileName: item.name || item.fileName || '',
    fileType: item.category || item.fileType || '',
    fileKey: item.fileKey || '',
    fileUrl: item.uploadedUrl || item.fileUrl || '',
    contentType: item.mimeType || item.contentType || '',
  };
}

function toCoreConsultationPayload({ userId, consultation }) {
  return {
    userId,
    title: consultation.title || consultation.caseNo || '상담 제목 미입력',
    clientName: consultation.name || consultation.clientName || '이름 미입력',
    inputText: consultation.memo || consultation.title || '',
    opponentName: consultation.opponentName || '',
    category: consultation.category || '',
    type: consultation.type || '',
    legalAidType: consultation.legalAidType || 'none',
    eligibilityEvidenceSubmitted: Boolean(consultation.eligibilityCheck?.evidenceSubmitted),
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
  const sourceAttachments = analysis.sourceAttachments?.length
    ? analysis.sourceAttachments
    : (analysis.attachments || []);
  const attachmentLinks = sourceAttachments
    .map(normalizeAnalysisAttachment)
    .filter((item) => item.fileName || item.fileKey || item.fileUrl);

  if (!attachmentLinks.length) return extractedJson;

  return {
    ...extractedJson,
    attachment_links: attachmentLinks,
    submitted_file_link: attachmentLinks
      .map((item) => item.fileKey || item.fileUrl)
      .filter(Boolean),
  };
}

function normalizeChecklistItem(item = {}) {
  return {
    label: item.label || item.name || '',
    checked: Boolean(item.checked),
  };
}

function normalizeTimelineItem(item = {}) {
  return {
    date: item.date || '',
    text: item.text || item.description || '',
  };
}

function toCoreAnalysisPayload(analysis = {}) {
  return {
    summary: analysis.summary || '',
    case_type: analysis.caseType || '',
    case_subtype: analysis.caseSubtype || '',
    urgency_level: analysis.urgency || '',
    eligibility: analysis.eligibility || '',
    extracted_json: buildCoreExtractedJson(analysis),
    missing_info_json: Array.isArray(analysis.missingInfo) ? analysis.missingInfo : [],
    checklist_json: (analysis.checklist || []).map(normalizeChecklistItem),
    recommendation_json: analysis.recommendation || {},
    timeline_json: (analysis.timeline || []).map(normalizeTimelineItem),
    cluster_result_json: analysis.clusterResult || [],
    estimated_time: analysis.estimatedTime || null,
  };
}

function normalizeCoreConsultation(row = {}) {
  return {
    coreId: row.id,
    coreUserId: row.userId,
    title: row.title || '',
    clientName: row.clientName || '',
    memo: row.inputText || '',
    opponentName: row.opponentName || '',
    coreStatus: row.status || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
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
  const coreUser = await ensureCoreUser(
    currentUser || { name: '상담원', role: 'counselor', email: 'local-counselor@example.local' },
  );
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
  return Promise.all([fetchCoreUsers(), fetchCoreConsultations()])
    .then(([users, consultations]) => ({
      users,
      consultations,
      userCount: users.length,
      consultationCount: consultations.length,
    }))
    .catch((error) => {
      const isReachableCoreApi =
        error?.code === CORE_API_ERROR_CODE.SCHEMA_MISMATCH
        || error?.code === CORE_API_ERROR_CODE.ENCRYPTION_DATA_ISSUE;

      if (!isReachableCoreApi) throw error;

      return {
        users: [],
        consultations: [],
        userCount: 0,
        consultationCount: 0,
        reachable: true,
        detail: error.message,
      };
    });
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

export async function triggerCoreAnalysis(consultation) {
  if (!consultation?.coreId) {
    throw new Error('Core API에 저장되지 않은 상담입니다.');
  }
  return requestCoreJson(`/api/consultations/${consultation.coreId}/analyze`, {
    method: 'POST',
  });
}

function normalizeMissingInfoItem(item) {
  if (typeof item === 'string') return item;
  return item?.item || item?.reason || item?.name || '';
}

function mapCoreChecklist(rawChecklist = []) {
  if (!Array.isArray(rawChecklist)) return [];
  return rawChecklist.map((item) => ({
    label: item?.label || item?.name || item?.item || '',
    checked: Boolean(item?.checked),
  }));
}

export function mapCoreAnalysisResponse(coreAnalysis = {}) {
  const extractedJson = coreAnalysis.extracted_json || {};
  const emergencyRatio = typeof extractedJson.case_emergency_ratio === 'number'
    ? extractedJson.case_emergency_ratio
    : null;

  return {
    summary: coreAnalysis.summary || '',
    caseType: coreAnalysis.case_type || '',
    caseSubtype: coreAnalysis.case_subtype || '',
    caseTypeReason: extractedJson.case_list?.[0]?.case_type_reason || '',
    urgency: coreAnalysis.urgency_level || '',
    emergencyRatio,
    eligibility: CORE_ELIGIBILITY_LABEL[coreAnalysis.eligibility] || coreAnalysis.eligibility || '검토 필요',
    missingInfo: (coreAnalysis.missing_info_json || []).map(normalizeMissingInfoItem).filter(Boolean),
    checklist: mapCoreChecklist(coreAnalysis.checklist_json),
    recommendation: coreAnalysis.recommendation_json || {},
    timeline: coreAnalysis.timeline_json || [],
    clusterResult: coreAnalysis.cluster_result_json || [],
    extractedJson,
    status: coreAnalysis.status || '',
    analysisId: coreAnalysis.analysis_id || coreAnalysis.id || '',
  };
}

export async function updateCoreAnalysis({ consultation, analysisId, analysis }) {
  if (!consultation?.coreId || !analysisId) return null;
  return requestCoreJson(`/api/consultations/${consultation.coreId}/analyses/${analysisId}`, {
    method: 'PUT',
    body: JSON.stringify(toCoreAnalysisPayload(analysis)),
  });
}

export function uploadCoreAttachment(consultationId, file, fileType) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('fileType', fileType || '기타');
  return requestCoreJson(`/api/consultations/${consultationId}/attachments`, {
    method: 'POST',
    body: formData,
  });
}

export function recommendCoreForms(consultationId, analysisId) {
  return requestCoreJson(`/api/consultations/${consultationId}/analyses/${analysisId}/recommend-forms`, {
    method: 'POST',
  });
}

export function generateCoreDraft(consultationId, analysisId, formName) {
  return requestCoreJson(`/api/consultations/${consultationId}/analyses/${analysisId}/generate-draft`, {
    method: 'POST',
    body: JSON.stringify({ form_name: formName }),
  });
}

export function fetchCoreDocuments(consultationId) {
  return requestCoreJson(`/api/consultations/${consultationId}/documents`);
}

export function buildCoreDocumentDownloadUrl(consultationId, documentId) {
  if (!consultationId || !documentId) return '';
  return `${CORE_API_BASE_URL}/api/consultations/${consultationId}/documents/${documentId}/download`;
}

export function submitCoreDocumentForReview(consultationId, documentId) {
  return requestCoreJson(`/api/consultations/${consultationId}/documents/${documentId}/submit-for-review`, {
    method: 'POST',
  });
}

export function approveCoreDocument(consultationId, documentId, note, token) {
  return requestCoreJson(`/api/consultations/${consultationId}/documents/${documentId}/approve`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ note: note || '' }),
  });
}

export function requestCoreDocumentRevision(consultationId, documentId, note, requestedMaterials, token) {
  return requestCoreJson(`/api/consultations/${consultationId}/documents/${documentId}/request-revision`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({
      note: note || '',
      requested_materials: requestedMaterials || [],
    }),
  });
}

export function submitCoreAnalysisForReview(consultationId, analysisId) {
  return requestCoreJson(`/api/consultations/${consultationId}/analyses/${analysisId}/submit-for-review`, {
    method: 'POST',
  });
}

export function approveCoreAnalysis(consultationId, analysisId, note, token) {
  return requestCoreJson(`/api/consultations/${consultationId}/analyses/${analysisId}/approve`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ note: note || '' }),
  });
}

export function requestCoreAnalysisRevision(consultationId, analysisId, note, token) {
  return requestCoreJson(`/api/consultations/${consultationId}/analyses/${analysisId}/request-revision`, {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ note: note || '' }),
  });
}

export function fetchCoreAnalyses(consultationId) {
  return requestCoreJson(`/api/consultations/${consultationId}/analyses`);
}

export function fetchCoreAdminStats(token) {
  return requestCoreJson('/api/admin/stats', {
    headers: authHeader(token),
  });
}

export { CORE_API_BASE_URL };
