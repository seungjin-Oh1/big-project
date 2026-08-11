import { readTextStorage, storageKeys } from './storage.js';

// core-api는 프론트와 같은 도메인 뒤 리버스 프록시(로컬은 Vite, 운영은 nginx/ALB 등)로 서빙되므로
// 항상 상대경로로 호출한다. 절대 URL로 바꾸면 브라우저가 직접 크로스오리진 요청을 하게 되어 CORS가 걸린다.
const CORE_API_BASE_URL = '/core-api';

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
// 저장할 때 쓰는 표준값. 화면에 보여준 라벨("검토 필요")이 그대로 저장되어 데이터로
// 굳어지는 일이 있었습니다 — 상담 45번의 eligibility가 "검토 필요"로 들어가 있었고,
// AI 응답 검증 스키마의 enum(대상후보/비대상후보/확인필요)을 벗어나 스키마 오류가 났습니다.
// 스키마 오류가 하나라도 있으면 검증기가 환각 위험을 무조건 '높음'으로 내리기 때문에,
// 멀쩡한 분석이 빨간 칩으로 표시됐습니다.
const CORE_ELIGIBILITY_VALUE = {
  '구조 가능': '대상후보',
  부적합: '비대상후보',
  '검토 필요': '확인필요',
  대상: '대상후보',
  비대상: '비대상후보',
  판단보류: '확인필요',
  보류: '확인필요',
  eligible: '대상후보',
  ineligible: '비대상후보',
  pending: '확인필요',
  대상후보: '대상후보',
  비대상후보: '비대상후보',
  확인필요: '확인필요',
};

// 라벨이 섞여 들어와도 표준값으로 되돌립니다. 모르는 값은 그대로 둡니다 — 임의로
// 바꾸면 새로 생긴 값이 조용히 '확인필요'로 뭉개집니다.
function toCoreEligibility(value) {
  if (!value) return '';
  return CORE_ELIGIBILITY_VALUE[value] || value;
}

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

// ai-api가 실제로 수행한 출력 검증 결과를 사람이 읽는 세 가지 상태로 바꿉니다.
// 응답이 없는 예전 분석은 '미실행'으로 두어, 로컬 mock의 통과 표시를 실제 결과처럼
// 보이지 않게 합니다.
function mapOutputValidation(raw) {
  if (!raw || raw.status !== 'available') {
    return {
      available: false,
      format: null,
      grounded: null,
      hallucinationRisk: null,
      formatLabel: '검증 미실행',
      evidenceLabel: '검증 미실행',
      riskLabel: '검증 미실행',
      decision: null,
    };
  }

  // output_validation.schema.json 계약 모양: 스키마 적합성·근거 사유는 최상위가 아니라
  // validation/review_reasons 아래 중첩돼 있다(aioutputvalidation의 audit.build_audit_record 참고).
  const reviewReasons = Array.isArray(raw.review_reasons) ? raw.review_reasons : [];
  const format = raw.validation?.valid === true;
  const grounded = !reviewReasons.some((reason) => typeof reason === 'string' && reason.startsWith('weak evidence'));
  const decision = raw.decision || 'review_required';
  const hallucinationRisk = decision === 'high_risk'
    ? 'high'
    : decision === 'review_required'
      ? 'review'
      : 'low';

  return {
    available: true,
    format,
    grounded,
    hallucinationRisk,
    formatLabel: format ? '통과' : '확인 필요',
    evidenceLabel: grounded ? '근거 확인' : '근거 보강 필요',
    riskLabel: hallucinationRisk === 'high' ? '높음' : hallucinationRisk === 'review' ? '검토 필요' : '낮음',
    decision,
    reviewReasons,
  };
}

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
  if (status === 502 || /ai-api|bad gateway/i.test(message)) {
    return {
      code: CORE_API_ERROR_CODE.CONNECTION_FAILED,
      message: 'AI API 서버에 연결할 수 없습니다. ai-api가 http://127.0.0.1:8001에서 실행 중인지 확인해주세요.',
    };
  }

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

// privacyAgreed(개인정보 수집·이용 동의)를 함께 보냅니다. 서버가 이 값을 확인하고
// 동의 시각을 users.privacy_agreed_at에 남깁니다 — 화면에서만 받으면 증빙이 남지 않습니다.
// organization·branch·phone도 함께 보냅니다. 예전에는 가입 화면이 이 셋을 필수로 받고
// 동의표에도 수집 항목으로 적어 두면서 정작 서버로는 보내지 않아, 브라우저 localStorage에만
// 남았습니다 — 다른 PC에서 승인 심사를 하면 소속이 '-'로 비었고, 동의받은 항목을 보관조차
// 하지 않는 상태였습니다.
export function registerCoreUser({ name, role, email, password, privacyAgreed, organization, branch, phone }) {
  return requestCoreJson('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name, role: toCoreRole(role), email, password, privacyAgreed: Boolean(privacyAgreed),
      organization: organization || '', branch: branch || '', phone: phone || '',
    }),
  });
}

// captchaId·captchaAnswer는 로그인 실패가 3회 쌓인 뒤부터만 필요합니다
// (보호조치 기준 제4조 접근통제 — 캡챠 적용). 평소에는 빈 값으로 나갑니다.
export function loginCoreUser({ email, password, captchaId, captchaAnswer }) {
  return requestCoreJson('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, captchaId: captchaId || '', captchaAnswer: captchaAnswer || '' }),
  });
}

// 자동 입력 방지 문자 발급. 답은 서버가 들고 있고 여기로는 그림(data URL)만 옵니다.
export function fetchCoreCaptcha() {
  return requestCoreJson('/api/auth/captcha');
}

// 이 이메일로 로그인하려면 캡차가 필요한지 미리 확인합니다.
export function fetchCoreCaptchaRequired(email) {
  return requestCoreJson(`/api/auth/captcha-required?email=${encodeURIComponent(email)}`);
}

// 로그인한 본인의 비밀번호 변경. 대상 계정은 서버가 토큰에서 꺼내므로 여기서 보내지 않습니다
// (이메일을 실어 보내면 남의 계정 비밀번호를 바꾸는 요청이 되어버립니다).
//
// 현재 비밀번호 불일치는 401, 지금과 같은 비밀번호는 409, 작성규칙 위반은 400으로 오고
// requestCoreJson이 서버 메시지를 그대로 담은 에러를 던집니다.
export function changeCorePassword({ currentPassword, newPassword }) {
  return requestCoreJson('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
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
    // 비밀번호 유효기간(90일)이 지났다는 서버 신호. 로그인 자체는 되고, 화면이 변경을 안내합니다
    // (보호조치 기준 제4조 — 비밀번호 유효기간 설정).
    passwordExpired: Boolean(response.passwordExpired),
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
    // 이름을 모르면 빈 값을 그대로 보냅니다. 대신 채워 넣지 않습니다.
    //
    // 같은 자리에서 두 번 사고가 났습니다. 처음에는 화면 표시용 문구('이름 미입력')를
    // 보내서 서식에 "청구인(상속인) 이름 미입력"이 인쇄됐고, 그다음에는 백엔드
    // 검증(@NotBlank)을 통과시키려고 '아무개'를 넣었더니 출생신고서의 부·모 칸에
    // "아무개"가 찍혔습니다. 문제는 어떤 문구를 고르느냐가 아니라 지어낸다는 것입니다.
    //
    // '아무개'가 특히 나빴던 이유: ai-api에는 가짜 이름을 걸러내는 필터가 있는데
    // (drafter.py의 UNKNOWN_NAME_MARKS·NON_NAME_PERSON_RE) '아무개'는 한글 세 글자
    // 사람 이름 모양이라 어디에도 안 걸립니다. 진짜 이름과 구별할 방법이 없습니다.
    // 게다가 빈칸이면 상담원이 "채워야 하는구나"를 알지만, 그럴듯한 이름이 찍혀 있으면
    // 확인하지 않고 넘깁니다.
    //
    // 통화 중 접수처럼 이름을 아직 모르는 상담은 정상입니다. 그때는 비워 두면
    // ai-api가 추출정보의 당사자 목록에서 이름을 찾고(drafter._seed_role_names),
    // 그것도 없으면 칸을 비운 채 누락자료로 올립니다. 화면 표시용 '이름 미입력'은
    // 읽는 쪽에서 붙입니다(App.jsx, common.jsx).
    clientName: (consultation.name || consultation.clientName || '').trim(),
    inputText: consultation.memo || consultation.title || '',
    opponentName: consultation.opponentName || '',
    category: consultation.category || '',
    type: consultation.type || '',
    legalAidType: consultation.legalAidType || 'none',
    eligibilityEvidenceSubmitted: Boolean(consultation.eligibilityCheck?.evidenceSubmitted),
    // 서식 작성용 개인정보. 법원 서식의 당사자 주소는 송달을 위한 법정 필수
    // 기재사항이라, 없으면 상담원이 초안을 받아 손으로 다시 채워야 합니다.
    //
    // 이 셋은 항상 함께 보냅니다. 서버는 privacyConsent가 올 때만 동의 상태를
    // 바꾸는데, 안 보내면 "동의를 뺐다"와 "동의 항목을 안 보냈다"를 구분할 수
    // 없어서 동의를 해제해도 값이 남습니다.
    clientAddress: consultation.clientAddress || '',
    clientPhone: consultation.clientPhone || '',
    privacyConsent: Boolean(consultation.privacyConsent),
    privacyConsentSource: consultation.privacyConsentSource || '',
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

// checklist_json은 analysis.extractedJson.aiAnalysisResponse(마지막으로 돌았던 analyze() 응답 —
// mergeContractAnalysisResponse가 채워둠)의 checklist_json을 그대로 옮겨 매 저장마다 보낸다.
// 예전엔 이 키를 아예 보내지 않았다 — analyze()가 AiAnalysis 행을 만들지 않고(트랜잭션 안에서
// 결과만 돌려주고 저장은 안 함) 결과만 반환하니, "분석 내용 저장"을 처음 누르는 순간(create)이
// relief_review_checklist 원본을 DB에 심을 유일한 시점인데 그때조차 안 보내서 checklist_json이
// DB에 영영 null로 남았다("보존"할 기존 값 자체가 없었다). 재분석 후 재저장(update)에서도 최신
// 값을 반영해야 하므로 create/update 모두 같은 값을 보낸다 — analysis 안 다른 필드들과 동일한
// 원칙("지금 analysis 상태를 그대로 저장")이라 update만 특별취급할 이유가 없다. 체크박스 상태는
// 항상 {label, checked}[] 형태만 담는 전용 컬럼인 checklist_status_json에만 싣는다.
// "분석 내용 저장"은 ai_analysis 테이블만 건드립니다 — Consultation(상담 원문/채널별 메모)은
// 여기서 다루지 않습니다. 상담 원문 저장은 별도의 "상담 저장" 버튼(saveCoreConsultationTranscript)
// 전담입니다(사용자 확인, 2026-08-04: "분석 내용 저장에서는 db의 ai_analysis에만 데이터 저장을 원함").
function toCoreAnalysisPayload(analysis = {}) {
  return {
    summary: analysis.summary || '',
    case_type: analysis.caseType || '',
    case_subtype: analysis.caseSubtype || '',
    urgency_level: analysis.urgency || '',
    // 화면에 보여준 라벨이 아니라 표준값으로 저장합니다. 불러올 때 남겨 둔
    // eligibilityValue가 있으면 그것이 원본이라 우선하고, 없으면(분석 직후) 라벨을
    // 되돌립니다. 이걸 안 하면 "대상후보"가 화면을 한 번 거칠 때마다 "검토 필요"로
    // 바뀌어 저장됩니다.
    eligibility: toCoreEligibility(analysis.eligibilityValue || analysis.eligibility),
    extracted_json: buildCoreExtractedJson(analysis),
    missing_info_json: Array.isArray(analysis.missingInfo) ? analysis.missingInfo : [],
    checklist_json: analysis.extractedJson?.aiAnalysisResponse?.checklist_json ?? null,
    checklist_status_json: (analysis.checklist || []).map(normalizeChecklistItem),
    recommendation_json: analysis.recommendation || {},
    timeline_json: (analysis.timeline || []).map(normalizeTimelineItem),
    cluster_result_json: analysis.clusterResult || [],
    estimated_time: analysis.estimatedTime || null,
  };
}

// call_input_texts 같은 이력 배열에서 화면에 되살릴 값을 고른다.
//
// 이 배열은 "상담 저장"을 누를 때마다 그 시점의 메모 전체가 하나씩 덧붙는 스냅샷 이력이다
// (ConsultationService.saveTranscript). 그래서 마지막 항목이 곧 현재 메모이고, 전부 이어붙이면
// 같은 내용이 저장 횟수만큼 반복된다. 분석 입력은 일부러 전부 합치지만(이전 녹음 세션 내용이
// 빠지지 않게 — AiAnalysisService.buildCombinedInputText), 화면 표시는 마지막 것만 쓴다.
export function latestSnapshot(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list[list.length - 1] || '';
}

// 서버 상담 행에서 화면이 쓰는 채널별 메모 4종을 뽑는다.
//
// 상담 목록을 불러오는 경로(App.jsx)와 상담을 새로 만드는 경로(createCoreConsultation)가
// 서로 다른 곳에서 행을 화면 모양으로 바꾸고 있어, 한쪽만 고치면 다른 쪽이 계속 비어 있게 된다.
// 두 곳이 같이 쓰도록 여기로 모은다.
export function consultationMemosFromRow(row = {}) {
  const callText = latestSnapshot(row.callInputTexts);
  const inpersonText = latestSnapshot(row.inpersonInputTexts);
  const hasChannelHistory = Boolean(callText || inpersonText);
  return {
    memo: hasChannelHistory ? callText : (row.inputText || ''),
    inpersonMemo: inpersonText,
    // 저장 여부 판단("상담 저장"/"저장 완료")의 기준값. 방금 서버에서 읽은 값이 곧 마지막으로
    // 저장된 값이므로, 복원 직후에는 저장 완료 상태로 잠겨야 한다.
    transcriptSavedMemo: hasChannelHistory ? callText : (row.inputText || ''),
    transcriptSavedInpersonMemo: inpersonText,
  };
}

function normalizeCoreConsultation(row = {}) {
  // 새로고침하거나 다음 날 다시 열어도 상담 내용과 마스킹본이 남아 있어야 한다. 예전에는
  // memo만 복원해서, 대면 녹음 결과와 개인정보 가림본이 브라우저를 벗어나면 사라졌다
  // (변호사 검토 화면에서는 그래서 항상 비어 있었다).
  //
  // memo에 inputText를 그대로 넣던 것도 함께 고친다 — inputText는 전화·대면을 이어붙인
  // 합본이라 복원하면 대면 내용이 전화 메모칸에 섞여 들어온다. 채널별 배열이 있으면
  // 그걸 쓰고, 아직 배열이 없는 예전 상담만 합본으로 폴백한다.
  return {
    coreId: row.id,
    coreUserId: row.userId,
    title: row.title || '',
    clientName: row.clientName || '',
    ...consultationMemosFromRow(row),
    opponentName: row.opponentName || '',
    coreStatus: row.status || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || '',
    // 서식 작성용 개인정보와 동의 기록. 이것도 복원해야 새로고침 뒤에 다시 묻지 않습니다 —
    // 동의를 이미 받았는데 화면이 비어 있으면 상담원이 내담자에게 두 번 묻게 됩니다.
    clientAddress: row.clientAddress || '',
    clientPhone: row.clientPhone || '',
    privacyConsent: Boolean(row.privacyConsent),
    privacyConsentAt: row.privacyConsentAt || '',
    privacyConsentSource: row.privacyConsentSource || '',
    coreAttachments: row.attachments || [],
    // 서버가 실제로 저장을 확정한 첨부파일 목록(각 항목에 DB row id=attachmentId 포함).
    // 상담 생성 직후 이 값을 쓰면, 방금 만든 상담의 첨부파일도 곧바로 "삭제" 가능한 상태로 화면에 반영됩니다.
    attachments: mapCoreAttachmentsToLocal(row),
  };
}

// 상담을 만들 때 넣을 userId를 얻습니다.
//
// 예전에는 전체 목록(GET /api/users)을 받아 이메일로 자기를 찾고, 없으면 POST /api/users로
// 계정을 새로 만들었습니다. 프론트에만 사용자가 있던 시절의 잔재입니다. 지금은 로그인이
// core-api를 거치므로 서버가 이미 내가 누구인지 압니다.
//
// 그 두 경로는 이제 관리자 전용입니다. 목록은 전 직원의 연락처·소속을 담고 있고, 생성은
// 아무나 승인 대기 계정을 만들 수 있는 자리였기 때문입니다. 그래서 상담원·변호사는
// 첫 요청에서 403을 맞고 상담을 아예 만들지 못했습니다 — 지금은 본인 조회만 씁니다.
export async function ensureCoreUser(user) {
  const me = await requestCoreJson('/api/users/me');
  // 로그인한 계정과 화면이 들고 있는 계정이 다르면(예: 로컬 계정으로 빠른 로그인) 그대로
  // 진행합니다. 상담의 주인은 어차피 토큰의 주인이어야 맞습니다.
  if (me?.email && user?.email && me.email !== user.email) {
    console.warn('[core-api] 로그인 계정과 화면 계정이 다릅니다. 토큰의 계정으로 진행합니다.');
  }
  return me;
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
    // 관리자 화면(활성 사용자·승인 대기)이 소속·연락처 칸을 그립니다. 서버가 이 셋을
    // 내려주기 시작했으므로 여기서 옮겨 담지 않으면 화면은 계속 '-'만 보여줍니다.
    organization: row.organization || '',
    branch: row.branch || '',
    phone: row.phone || '',
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

// "상담 저장" 버튼 전용. 채널별(전화/대면) 실시간 상담 메모를 Consultation에 반영합니다 —
// input_text 갱신 + call_input_texts/inperson_input_texts에 스냅샷 append까지
// 서버(ConsultationService.saveTranscript)가 한 번에 처리합니다.
//
// 가림본은 보내지 않습니다. 원본이 그대로 남아 있는 한 가림본을 함께 저장해도 유출
// 대비가 되지 않고 보관하는 개인정보만 두 배가 됩니다. 화면에 가림본이 필요할 때는
// fetchMaskedTranscript로 그때 받아 씁니다.
export async function saveCoreConsultationTranscript(coreId, { callInputText, inpersonInputText }) {
  if (!coreId) return null;
  return requestCoreJson(`/api/consultations/${coreId}/transcript`, {
    method: 'POST',
    body: JSON.stringify({ callInputText, inpersonInputText }),
  });
}

// 화면의 '개인정보 가림 결과' 카드가 열릴 때 부릅니다. 저장된 가림본을 읽는 게 아니라
// 서버가 그 자리에서 가려 돌려줍니다(GET .../masked-transcript).
export async function fetchMaskedTranscript(coreId) {
  if (!coreId) return '';
  const body = await requestCoreJson(`/api/consultations/${coreId}/masked-transcript`);
  return body?.maskedText || '';
}

export async function createCoreAnalysis({ consultation, analysis }) {
  if (!consultation?.coreId) return null;
  return requestCoreJson(`/api/consultations/${consultation.coreId}/analyses`, {
    method: 'POST',
    body: JSON.stringify(toCoreAnalysisPayload(analysis)),
  });
}

// ── AI 분석 실행 ──────────────────────────────────────────────────────────
//
// 분석은 녹취 길이에 따라 몇 분씩 걸립니다. 그래서 요청 하나로 결과까지 받아오지 않고
// "접수하고 → 주기적으로 다 됐는지 확인" 두 단계로 나눕니다.
//
// 이렇게 하는 이유 두 가지:
//   1. 상담원 화면이 분석이 끝날 때까지 멈춰 있지 않습니다.
//   2. 배포 환경의 로드밸런서는 응답 없이 일정 시간(보통 60초)이 지나면 연결을 끊습니다.
//      끊긴 뒤에도 서버는 계속 분석을 돌지만 결과를 돌려줄 곳이 없어 그냥 버려집니다.
//      접수 요청은 즉시 응답하므로 그 시간 제한에 걸리지 않습니다.
//
// 서버는 결과를 analysis_job 행에 담아 두므로, 폴링이 중간에 끊겨도 작업 자체는 계속 돕니다.
const ANALYSIS_POLL_INTERVAL_MS = 3000;
const ANALYSIS_MAX_WAIT_MS = 30 * 60 * 1000;
// 조회가 한 번 실패했다고 분석을 포기하면 안 됩니다 — 서버에서는 계속 돌고 있고, 잠깐의
// 네트워크 문제일 수 있습니다. 연속으로 이만큼 실패했을 때만 실패로 봅니다.
const ANALYSIS_POLL_MAX_CONSECUTIVE_ERRORS = 3;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// 분석 접수. 작업 번호만 받고 즉시 돌아옵니다.
// 이미 이 상담에 돌고 있는 작업이 있으면 서버가 새로 만들지 않고 그 작업을 돌려줍니다.
export async function submitCoreAnalysisJob(consultation) {
  if (!consultation?.coreId) {
    throw new Error('Core API에 저장되지 않은 상담입니다.');
  }
  return requestCoreJson(`/api/consultations/${consultation.coreId}/analyze-jobs`, {
    method: 'POST',
  });
}

export async function getCoreAnalysisJob(jobId) {
  return requestCoreJson(`/api/analysis-jobs/${jobId}`);
}

// 아직 안 끝난 작업이 있으면 돌려줍니다(없으면 204 -> null). 화면을 새로고침했을 때
// 돌고 있던 분석에 다시 붙기 위한 것입니다.
export async function findActiveCoreAnalysisJob(consultation) {
  if (!consultation?.coreId) return null;
  return requestCoreJson(`/api/consultations/${consultation.coreId}/analyze-jobs/active`);
}

// 작업이 끝날 때까지 기다렸다가 분석 결과를 돌려줍니다.
// onProgress는 기다리는 동안 주기적으로 불려서, 화면이 경과 시간을 보여줄 수 있게 합니다.
export async function waitForCoreAnalysisJob(job, { onProgress } = {}) {
  let current = job;
  let consecutiveErrors = 0;
  const startedAt = Date.now();

  while (current && current.status !== 'SUCCEEDED' && current.status !== 'FAILED') {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > ANALYSIS_MAX_WAIT_MS) {
      // 서버 작업 자체는 계속 돌고 있으므로 "실패"가 아니라 "확인을 그만둔다"는 뜻입니다.
      throw new Error('분석이 30분 안에 끝나지 않았습니다. 잠시 후 다시 확인해주세요.');
    }
    onProgress?.({ status: current.status, elapsedMs });
    await sleep(ANALYSIS_POLL_INTERVAL_MS);
    try {
      current = await getCoreAnalysisJob(current.job_id);
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= ANALYSIS_POLL_MAX_CONSECUTIVE_ERRORS) throw error;
    }
  }

  if (current.status === 'FAILED') {
    throw new Error(current.error_message || 'AI 분석에 실패했습니다.');
  }
  return current.result;
}

// 서버에 아예 닿지 못한 경우(core-api가 꺼져 있는 등)인지 구분합니다.
//
// 이 구분이 필요한 이유: 분석 화면은 실패하면 로컬 목업 결과로 넘어가는데, 그건 개발 중
// 백엔드 없이 화면을 보기 위한 장치입니다. 서버까지 닿았는데 분석이 실패한 경우까지 목업으로
// 덮어버리면, 상담원은 실패한 줄 모르고 가짜 결과를 실제 분석으로 믿고 저장하게 됩니다.
export function isCoreConnectionError(error) {
  return error?.code === CORE_API_ERROR_CODE.CONNECTION_FAILED;
}

// 부르는 쪽에서 보면 예전과 똑같이 "분석 결과를 돌려주는 함수"입니다.
// 접수와 대기를 안에서 처리하므로 호출부는 바꿀 필요가 없습니다.
export async function triggerCoreAnalysis(consultation, options = {}) {
  const { onSubmitted, ...waitOptions } = options;
  const job = await submitCoreAnalysisJob(consultation);
  onSubmitted?.(job);
  return waitForCoreAnalysisJob(job, waitOptions);
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

// checklist_json(=relief_review_checklist)의 eligibility/winnability/executability/appropriateness
// 4개 신호 객체를 화면 전용으로 camelCase 옮깁니다. mapCoreChecklist와 달리 항목 라벨이 아니라
// eligible/evidence_status 등 판단값 자체를 그대로 보존합니다 — 다만 이 값으로 체크박스를 자동
// 채우지는 않습니다(HITL 원칙, mapCoreChecklist 주석 참고). '체크리스트 AI 분석 결과' 4탭 전용.
// rawChecklist가 배열이면(옛 checklist_status_json 저장분) 이 필드는 신규라 호환 대상이 아니므로 null.
function mapReliefReviewDetail(rawChecklist) {
  if (!rawChecklist || Array.isArray(rawChecklist)) return null;
  const { eligibility, winnability, executability, appropriateness } = rawChecklist;
  return {
    eligibility: eligibility ? {
      incomeCriterionMet: eligibility.income_criterion_met ?? null,
      statusCriterionMet: Boolean(eligibility.status_criterion_met),
      matchedReasons: eligibility.matched_reasons || [],
      requiredEvidence: eligibility.required_evidence || [],
      evidenceStatus: eligibility.evidence_status || '',
      eligible: eligibility.eligible || '',
      appliedIncomeThresholdRatio: eligibility.applied_income_threshold_ratio ?? null,
      judgmentNote: eligibility.judgment_note || '',
    } : null,
    winnability: winnability ? {
      submittedEvidenceTypes: winnability.submitted_evidence_types || [],
      subjectiveCircumstancesSummary: winnability.subjective_circumstances_summary ?? null,
      statuteOfLimitationsFlag: winnability.statute_of_limitations_flag ?? null,
      limitationStartDate: winnability.limitation_start_date ?? null,
      limitationPeriodYears: winnability.limitation_period_years ?? null,
      claimExistenceHint: winnability.claim_existence_hint ?? null,
      factProvabilityHint: winnability.fact_provability_hint ?? null,
      extractionConfidence: winnability.extraction_confidence || '',
      reviewNote: winnability.review_note || '',
    } : null,
    executability: executability ? {
      debtorAssetStatus: executability.debtor_asset_status ?? null,
      extractionConfidence: executability.extraction_confidence || '',
      reviewNote: executability.review_note || '',
    } : null,
    appropriateness: appropriateness ? {
      caseNature: appropriateness.case_nature ?? null,
      personalMotiveFlags: appropriateness.personal_motive_flags || [],
      alternativeReliefMentioned: appropriateness.alternative_relief_mentioned ?? null,
      lowValueClaimMentioned: appropriateness.low_value_claim_mentioned ?? null,
      outOfScopeFlags: appropriateness.out_of_scope_flags || [],
      extractionConfidence: appropriateness.extraction_confidence || '',
      reviewNote: appropriateness.review_note || '',
    } : null,
    requiresLawyerReview: Boolean(rawChecklist.requires_lawyer_review),
    lawyerSummary: rawChecklist.checklist_summary_for_lawyer || '',
  };
}

export function mapCoreAnalysisResponse(coreAnalysis = {}) {
  const extractedJson = coreAnalysis.extracted_json || {};
  const verification = mapOutputValidation(extractedJson.output_validation);
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
    // 라벨로 바꾸기 전의 원래 값. 저장할 때 이걸 되돌려 보내야 화면에 보여준 말이
    // 데이터로 굳어지지 않습니다(toCoreAnalysisPayload 주석 참고).
    eligibilityValue: coreAnalysis.eligibility || '',
    missingInfo: (coreAnalysis.missing_info_json || []).map(normalizeMissingInfoItem).filter(Boolean),
    // checklist_status_json이 있으면(=한 번이라도 저장된 분석) 그 값을 그대로 쓴다 — 이게
    // 실제 5개 체크박스 상태의 단일 진실 공급원(SSOT)이다. 아직 저장 전(분석 직후)이라
    // 비어 있을 때만 checklist_json(relief_review_checklist 객체)에서 파생시킨다.
    checklist: Array.isArray(coreAnalysis.checklist_status_json) && coreAnalysis.checklist_status_json.length
      ? coreAnalysis.checklist_status_json.map(normalizeChecklistItem)
      : mapCoreChecklist(coreAnalysis.checklist_json),
    reliefReviewDetail: mapReliefReviewDetail(coreAnalysis.checklist_json),
    recommendation: coreAnalysis.recommendation_json || {},
    timeline: (coreAnalysis.timeline_json || []).map(normalizeIncomingTimelineItem),
    timelineIssue: classifyTimelineIssue(coreAnalysis.timeline_json),
    clusterResult: coreAnalysis.cluster_result_json || [],
    extractedJson,
    verification,
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
    status: item.id != null ? '서버 저장' : (item.fileKey || item.fileUrl) ? '업로드 완료' : '',
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
