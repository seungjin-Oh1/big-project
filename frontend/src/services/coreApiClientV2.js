import { readTextStorage, storageKeys } from './storage.js';

const CORE_API_BASE_URL = import.meta.env.VITE_CORE_API_BASE_URL || '/core-api';

const CORE_API_ERROR_CODE = {
  CONNECTION_FAILED: 'CORE_CONNECTION_FAILED',
  SCHEMA_MISMATCH: 'CORE_SCHEMA_MISMATCH',
  ENCRYPTION_DATA_ISSUE: 'CORE_ENCRYPTION_DATA_ISSUE',
  AUTH_FAILED: 'CORE_AUTH_FAILED',
  REQUEST_FAILED: 'CORE_REQUEST_FAILED',
};

// AiAnalysisResponse.eligibility는 ai-api EligibilityRuleResult.eligible의 값을 그대로 받아서
// "대상"/"비대상"/"판단보류" 셋 중 하나로 옵니다(backend/ai-api/app/agents/consult/schemas.py 참고).
// 예전엔 이 세 값이 매핑에 없어서, 실제 백엔드 응답을 받아도 화면 전체가 쓰는 라벨
// (구조 가능/부적합/검토 필요)로 안 바뀌고 "대상"/"비대상"/"판단보류"가 그대로 노출됐습니다.
const CORE_ELIGIBILITY_LABEL = {
  eligible: '구조 가능',
  ineligible: '부적합',
  pending: '검토 필요',
  '구조 가능': '구조 가능',
  부적합: '부적합',
  보류: '검토 필요',
  대상후보: '검토 필요',
  대상: '구조 가능',
  비대상: '부적합',
  판단보류: '검토 필요',
};

function extractCoreErrorMessage(bodyText, fallback) {
  try {
    const parsed = bodyText ? JSON.parse(bodyText) : null;
    return parsed?.message || parsed?.error || fallback;
  } catch {
    return bodyText || fallback;
  }
}

function buildCoreApiError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status != null) error.status = status;
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

  // Spring Security가 인증 자체를 막을 때(토큰 없음/무효)는 응답 본문에 JSON이 아니라 "Forbidden"
  // 같은 HTTP 상태 문구만 담겨 와서, 그 원문 영어 문구가 그대로 화면에 노출됐습니다. 다만 로그인처럼
  // 백엔드가 직접 사유를 JSON으로 내려주는 403(예: "관리자 승인 대기 중인 계정입니다")까지 이걸로
  // 덮어쓰면 더 유용한 메시지를 지워버리게 되므로, 진짜로 본문이 빈 HTTP 상태 문구일 때만 바꿉니다.
  const isBareHttpReasonPhrase = /^(forbidden|unauthorized|access denied)$/i.test((message || '').trim());
  if ((status === 401 || status === 403) && isBareHttpReasonPhrase) {
    return {
      code: CORE_API_ERROR_CODE.AUTH_FAILED,
      message: '권한이 없습니다. 관리자 권한이 있는 계정으로 로그인했는지 확인해주세요.',
    };
  }

  return {
    code: CORE_API_ERROR_CODE.REQUEST_FAILED,
    message: message || `Core API 요청 실패 (HTTP ${status})`,
  };
}

// 로그인할 때 받아둔 JWT를 꺼내옵니다(App.jsx persistAuthToken이 저장).
// 로그인 전이거나 로그아웃 상태면 빈 값이라 헤더를 붙이지 않습니다.
export function coreAuthHeader() {
  const token = readTextStorage(storageKeys.authToken, '');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function requestCoreJson(path, options = {}) {
  const { headers, ...restOptions } = options;
  let response;
  try {
    // 토큰을 여기 한 곳에서 붙입니다.
    //
    // 예전에는 승인·반려처럼 SecurityConfig가 이미 막아둔 9개 함수만 각자 authHeader(token)을
    // 넘겼고, 상담 생성·조회·분석·첨부·서식은 토큰 없이 나갔습니다. 그래서 core-api를
    // .authenticated()로 좁히면 앱이 통째로 401이 되는 상태였습니다.
    // 모든 요청이 이 함수를 거치므로, 함수 40여 개를 각각 고치지 않고 여기서 한 번에 붙입니다.
    // 개별 함수가 headers로 넘긴 값이 있으면 그쪽을 우선합니다(기존 호출부 동작 유지).
    response = await fetch(`${CORE_API_BASE_URL}${path}`, {
      ...restOptions,
      headers: restOptions.body instanceof FormData
        ? { ...coreAuthHeader(), ...(headers || {}) }
        : { 'Content-Type': 'application/json', ...coreAuthHeader(), ...(headers || {}) },
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
    throw buildCoreApiError(normalized.code, normalized.message, response.status);
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

// ai-api가 생성하는 timeline_json 원본 항목은 {날짜, 내용} 키를 쓴다
// (backend/ai-api/app/schemas/analysis.py의 TimelineItem 참고). core-api는 이를 그대로
// 통과시키므로, 화면이 기대하는 {date, text} 모양으로 여기서 변환해야 한다.
function normalizeIncomingTimelineItem(item) {
  if (typeof item === 'string') return { date: '', text: item };
  return {
    date: item?.date || item?.날짜 || '',
    text: item?.text || item?.내용 || item?.description || '',
  };
}

// "타임라인이 안 보인다"는 문의가 실제로는 서로 다른 원인일 수 있어(같은 상담을 재분석했을 때
// 이번 회차의 ai-api 구조화 분석 단계만 실패해 timeline_json이 비어 저장되는 경우가 실제로 있었음),
// 상담원이 원인을 구분할 수 있도록 코드를 매긴다.
// 001: timeline_json 자체가 없음(null) 또는 빈 배열 — 이번 분석 결과에 타임라인이 없는 정상적인 빈 상태
// 002: 배열은 있지만 항목이 {date,text}/{날짜,내용} 어느 쪽으로도 정규화되지 않음 — 저장 형식 문제
// 003: 배열이 아닌 예상 밖 구조 등 그 외
export const TIMELINE_ISSUE = { EMPTY: '001', SHAPE_MISMATCH: '002', OTHER: '003' };

function classifyTimelineIssue(rawTimelineJson) {
  if (rawTimelineJson == null) return TIMELINE_ISSUE.EMPTY;
  if (!Array.isArray(rawTimelineJson)) return TIMELINE_ISSUE.OTHER;
  if (rawTimelineJson.length === 0) return TIMELINE_ISSUE.EMPTY;
  const hasUsableItem = rawTimelineJson.some((item) => {
    const normalized = normalizeIncomingTimelineItem(item);
    return Boolean(normalized.date || normalized.text);
  });
  return hasUsableItem ? null : TIMELINE_ISSUE.SHAPE_MISMATCH;
}

export function timelineEmptyMessage(issueCode) {
  return `확인된 타임라인 자료가 없습니다_${issueCode || TIMELINE_ISSUE.OTHER}`;
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
    // checklist_json은 일부러 여기서 보내지 않는다. ai-api가 analyze() 시점에 채운
    // relief_review_checklist 원본 구조를 그대로 보존하기 위함이다 — core-api의 update()는
    // 요청에 없는(null) 필드는 기존 DB 값을 그대로 두는 부분수정이라, 이 키를 아예 보내지
    // 않으면 저장을 여러 번 해도 checklist_json은 분석 시점 그대로 남는다. 체크박스 상태는
    // 항상 {label, checked}[] 형태만 담는 전용 컬럼인 checklist_status_json에만 싣는다.
    checklist_status_json: (analysis.checklist || []).map(normalizeChecklistItem),
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
    // 서버가 실제로 저장을 확정한 첨부파일 목록(각 항목에 DB row id=attachmentId 포함).
    // 상담 생성 직후 이 값을 쓰면, 방금 만든 상담의 첨부파일도 곧바로 "삭제" 가능한 상태로 화면에 반영됩니다.
    attachments: mapCoreAttachmentsToLocal(row),
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

function toLocalApprovalStatus(approvalStatus) {
  if (approvalStatus === 'APPROVED') return '승인';
  if (approvalStatus === 'REJECTED') return '거절';
  return '대기';
}

// 관리자 화면(활성 사용자/승인 대기)이 이 브라우저에 없던 실제 가입자도 보여줄 수 있도록,
// core-api User 응답을 프론트가 쓰는 로컬 사용자 모양으로 바꿉니다. organization/branch/phone은
// core-api User 엔티티에 아예 없는 로컬 전용 필드라 여기서 채우지 않습니다.
export function mapCoreUserToLocal(row = {}) {
  return {
    backendId: row.id,
    name: row.name || '',
    role: toFrontendRole(row.role),
    email: row.email || '',
    status: toLocalApprovalStatus(row.approvalStatus),
    requestedAt: (row.createdAt || '').slice(0, 10) || '',
  };
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

// core-api가 checklist_json에 실제로 채워 넣는 값은 배열이 아니라 ai-api /consult/analyze의
// relief_review_checklist 객체 그대로입니다: { eligibility, winnability, executability,
// appropriateness, requires_lawyer_review, checklist_summary_for_lawyer }
// (backend/ai-api/app/agents/consult/schemas.py의 ReliefReviewChecklist 참고).
//
// 체크리스트는 AI가 대신 체크해주는 항목이 아니라 상담원이 직접 확인하고 체크하는
// 항목입니다. 그래서 이 객체에서는 항목 이름(라벨) 5개만 만들고, 체크 여부는 AI의
// eligible/evidence_status 등 판단 신호로 추정하지 않고 항상 false(미체크)로 둡니다.
// 실제 체크 상태는 상담원이 화면에서 직접 체크한 뒤 checklist_status_json에 저장된
// 값(위 mapCoreAnalysisResponse의 분기)이 유일한 출처입니다.
function mapCoreChecklist(rawChecklist) {
  if (!rawChecklist) return [];
  if (Array.isArray(rawChecklist)) {
    // 상담원이 저장(create/update)했다가 다시 불러온 경우엔 이미 {label, checked} 배열이라
    // 실제 체크 상태를 그대로 보존해야 합니다(옛 버전에서 저장된 데이터와의 호환용).
    return rawChecklist.map((item) => ({
      label: item?.label || item?.name || item?.item || '',
      checked: Boolean(item?.checked),
    }));
  }
  const { eligibility, winnability, executability, appropriateness } = rawChecklist;
  const items = [];
  if (eligibility) {
    items.push({ label: '법률구조 대상 여부 확인', checked: false });
    items.push({ label: '법률구조 대상자 증빙서류 제출 여부 확인', checked: false });
  }
  if (winnability) {
    items.push({ label: '승소 가능성 기초자료 확인', checked: false });
  }
  if (executability) {
    items.push({ label: '집행 가능성 확인', checked: false });
  }
  if (appropriateness) {
    items.push({ label: '구조 타당성 확인', checked: false });
  }
  return items;
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
    // checklist_status_json이 있으면(=한 번이라도 저장된 분석) 그 값을 그대로 쓴다 — 이게
    // 실제 5개 체크박스 상태의 단일 진실 공급원(SSOT)이다. 아직 저장 전(분석 직후)이라
    // 비어 있을 때만 checklist_json(relief_review_checklist 객체)에서 파생시킨다.
    checklist: Array.isArray(coreAnalysis.checklist_status_json) && coreAnalysis.checklist_status_json.length
      ? coreAnalysis.checklist_status_json.map(normalizeChecklistItem)
      : mapCoreChecklist(coreAnalysis.checklist_json),
    recommendation: coreAnalysis.recommendation_json || {},
    timeline: (coreAnalysis.timeline_json || []).map(normalizeIncomingTimelineItem),
    timelineIssue: classifyTimelineIssue(coreAnalysis.timeline_json),
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

// 이미 presigned URL로 S3에 올라간 파일의 메타데이터를 "기존" 상담에 등록합니다(DB에만 기록,
// 재업로드 없음). 상담원이 "기존 상담에 자료 추가 → 자료 저장"을 눌렀을 때 새로 고른 파일마다 호출됩니다.
// (상담을 새로 만들 때는 createCoreConsultation의 attachments 필드로 한 번에 같이 등록되므로 이 호출이 필요 없음.)
export function registerCoreAttachment(consultationId, item) {
  if (!consultationId) return Promise.reject(new Error('등록할 상담(consultationId)이 없습니다.'));
  return requestCoreJson(`/api/consultations/${consultationId}/attachments/register`, {
    method: 'POST',
    body: JSON.stringify(toCoreAttachmentRegistration(item)),
  });
}

// 첨부파일을 DB row + S3 오브젝트까지 실제로 지웁니다(AttachmentService.delete 참고).
export function deleteCoreAttachment(consultationId, attachmentId) {
  if (!consultationId || !attachmentId) return Promise.reject(new Error('삭제할 첨부파일을 특정할 수 없습니다.'));
  return requestCoreJson(`/api/consultations/${consultationId}/attachments/${attachmentId}`, {
    method: 'DELETE',
  });
}

// 아직 어떤 상담에도 등록되지 않은(=DB에 Attachment row가 없는) S3 오브젝트를 지웁니다.
// "새 상담 만들기" 화면에서 파일을 S3까지 올려놓고 상담을 만들기 전에 "삭제"를 누른 경우처럼,
// deleteCoreAttachment가 못 지우는(consultationId·attachmentId가 아직 없는) 파일을 지울 때 씁니다.
export function deleteUnregisteredCoreAttachment(fileKey) {
  if (!fileKey) return Promise.reject(new Error('삭제할 파일 키(fileKey)가 없습니다.'));
  return requestCoreJson(`/api/attachments/unregistered?fileKey=${encodeURIComponent(fileKey)}`, {
    method: 'DELETE',
  });
}

// core-api AttachmentResponse(id/fileName/fileType/downloadUrl 등)를 화면이 쓰는 첨부파일 모양으로 바꿉니다.
// attachmentId(=DB row id)가 있어야 삭제 API를 호출할 수 있으므로 반드시 같이 넘겨줍니다.
export function mapCoreAttachmentToLocal(item = {}) {
  return {
    attachmentId: item.id ?? null,
    category: item.fileType || item.category || '첨부자료',
    name: item.fileName || item.name || item.fileKey || '첨부파일',
    size: item.size || 0,
    mimeType: item.contentType || item.mimeType || '',
    storageBucket: item.storageBucket || '',
    fileKey: item.fileKey || '',
    uploadedUrl: item.fileUrl || item.downloadUrl || item.uploadedUrl || '',
    status: item.id != null ? '서버 저장' : (item.fileKey || item.fileUrl) ? 'S3 업로드 완료' : '',
  };
}

export function mapCoreAttachmentsToLocal(row = {}) {
  return (row.attachments || row.coreAttachments || [])
    .map(mapCoreAttachmentToLocal)
    .filter((item) => item.name || item.fileKey || item.uploadedUrl);
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

// GET .../documents/{documentId}/download — GeneratedDocumentController(백엔드)의 실제
// 다운로드 엔드포인트로 연결합니다. ai-api가 서식_hwpx 원본을 기반으로 생성한 진짜 초안
// 파일을 그대로 받습니다. (core-api·ai-api가 같은 서버 디스크에서 돌아간다는 전제 —
// 파일을 못 찾으면 404가 나고, 그때는 GeneratedFileLink/GeneratedFileBox가 클라이언트
// HWPX 생성 폴백으로 대체합니다.)
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

// SEC-01-01-01: 상담 조회/AI 분석 실행·수정/검토 승인·반려/문서 다운로드 5가지를 서버가 직접
// 해시체인으로 남기는 감사 로그입니다. (관리자 전용, ADMIN 역할 토큰 필요)
export function fetchCoreAuditLogs(token) {
  return requestCoreJson('/api/admin/audit-logs', {
    headers: authHeader(token),
  });
}

// 저장된 감사 로그 체인을 서버가 처음부터 다시 계산해 위변조 여부를 확인합니다.
export function verifyCoreAuditLogChain(token) {
  return requestCoreJson('/api/admin/audit-logs/verify', {
    headers: authHeader(token),
  });
}

export { CORE_API_BASE_URL };
