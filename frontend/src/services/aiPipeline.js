// ai-api(LangGraph) 3단계 파이프라인과 프론트 분석 모델 사이의 번역을 한곳에 모은 모듈입니다.
//
// 백엔드는 사건분석·구조대상 판정·누락자료 조회를 POST /consult/analyze 하나로 통합해뒀습니다.
// 응답 형태는 { raw_input, case_analysis, relief_review_checklist, missing_items }로,
// 예전에 3개 엔드포인트를 체인으로 호출해 모으던 값들이 한 번의 호출로 전부 옵니다.
// 그래서 이 모듈은 응답을 뜯어 고치지 않고 원본 그대로 들고 다니다가,
// 화면에 필요한 순간에만 프론트 모델로 옮겨 담습니다.
//
// legalAidApi.js의 mapContractAnalysisResponse가 '계약 mock(/analysis)' 담당이라면,
// 이 파일은 '실제 LangGraph 파이프라인' 담당입니다. 두 계약이 다르므로 섞지 않습니다.

import { requestConsultAnalysis } from './aiApiClient.js';
import { toSubmittedFileLinks } from './legalAidApi.js';

// ---------------------------------------------------------------------------
// 요청 본문 조립
// ---------------------------------------------------------------------------

// POST /consult/analyze 의 content 블록(RawInputContent). 필드명은 백엔드 parse_input_node 기준입니다.
// (summited_file_link 오탈자는 백엔드 계약값이라 그대로 맞춥니다)
export function buildConsultContent(consultation = {}) {
  return {
    summary: consultation.title || '',
    details: consultation.memo || '',
    summited_file_link: toSubmittedFileLinks(consultation.attachments),
    consult_day: consultation.date || '',
  };
}

// ---------------------------------------------------------------------------
// 응답 매핑: 1단계 사건분석
// ---------------------------------------------------------------------------

const EMERGENCY_LEVELS = ['상', '중', '하'];

function toCaseCandidate(item = {}) {
  return {
    type: item.case_type || '미분류',
    ratio: typeof item.case_ratio === 'number' ? item.case_ratio : 0,
    reason: item.case_type_reason || '',
  };
}

// case_list는 백엔드가 case_ratio 내림차순으로 정렬해 보내지만,
// 화면 순서가 백엔드 정렬에 의존하지 않도록 프론트에서도 한 번 더 정렬합니다.
function toCaseCandidates(caseList = []) {
  return caseList.map(toCaseCandidate).sort((left, right) => right.ratio - left.ratio);
}

function toEmergency(caseAnalysis = {}) {
  const level = EMERGENCY_LEVELS.includes(caseAnalysis.case_emergency_level) ? caseAnalysis.case_emergency_level : '하';
  return {
    level,
    ratio: typeof caseAnalysis.case_emergency_ratio === 'number' ? caseAnalysis.case_emergency_ratio : 0,
    reason: caseAnalysis.case_emergency_reason || '',
  };
}

// extracted_content(텍스트 배열)와 extracted_content_detail(처리 로그)은 같은 인덱스로 짝지어집니다.
// 화면에서 파일별 상태를 한 줄로 보여주기 위해 둘을 하나로 합칩니다.
function toExtractionDetail(caseAnalysis = {}) {
  const texts = caseAnalysis.extracted_content || [];
  return (caseAnalysis.extracted_content_detail || []).map((log, index) => ({
    fileLink: log.file_link || '',
    fileType: log.file_type || '',
    status: log.status || 'failed',
    note: log.error || texts[index] || '',
  }));
}

export function mapCaseAnalysisResponse(response = {}) {
  const caseAnalysis = response.case_analysis || {};
  const candidates = toCaseCandidates(caseAnalysis.case_list);
  const emergency = toEmergency(caseAnalysis);
  return {
    caseCandidates: candidates,
    // 대표 유형은 '가장 비율이 높은 후보'입니다. 어느 것이 대표인지는 여기서만 정합니다.
    caseType: candidates[0]?.type || '미분류',
    caseTypeReason: candidates[0]?.reason || '',
    urgency: emergency.level,
    emergency,
    extractionDetail: toExtractionDetail(caseAnalysis),
  };
}

// ---------------------------------------------------------------------------
// 응답 매핑: 2단계 구조대상 판정
// ---------------------------------------------------------------------------

// 백엔드는 대상/비대상/판단보류 세 값만 결론으로 냅니다. 화면 어휘로 옮깁니다.
const ELIGIBILITY_LABEL = { 대상: '구조 가능', 비대상: '부적합', 판단보류: '검토 필요' };

function toReviewSignal(signal = {}) {
  return {
    note: signal.review_note || '',
    confidence: signal.extraction_confidence || '불명확',
  };
}

export function mapEligibilityResponse(response = {}) {
  const checklist = response.relief_review_checklist || {};
  const eligibility = checklist.eligibility || {};
  return {
    eligibility: ELIGIBILITY_LABEL[eligibility.eligible] || '검토 필요',
    evidenceStatusLabel: eligibility.evidence_status || '확인불가',
    requiredEvidence: eligibility.required_evidence || [],
    matchedReasons: eligibility.matched_reasons || [],
    judgmentNote: eligibility.judgment_note || '',
    incomeCriterionMet: eligibility.income_criterion_met ?? null,
    statusCriterionMet: Boolean(eligibility.status_criterion_met),
    winnability: toReviewSignal(checklist.winnability),
    executability: toReviewSignal(checklist.executability),
    appropriateness: toReviewSignal(checklist.appropriateness),
    lawyerSummary: checklist.checklist_summary_for_lawyer || '',
  };
}

// ---------------------------------------------------------------------------
// 응답 매핑: 3단계 누락자료
// ---------------------------------------------------------------------------

function toReferenceDocument(document = {}) {
  return {
    name: document.doc_name || '',
    authority: document.issuing_authority || '',
    acquisitionType: document.acquisition_type || '',
    acquisitionNote: document.acquisition_type_desc || '',
    onlineIssuance: Boolean(document.online_issuance),
    onlineChannel: document.online_issuance_channel || '',
    relatedLaw: document.related_law || '',
    notes: document.notes || '',
  };
}

function toMissingItem(item = {}) {
  return {
    name: item.item || '',
    kind: item.type || '증빙',
    reason: item.reason || '',
    confidence: typeof item.confidence === 'number' ? item.confidence : null,
    evidenceNote: item.evidence_check_note || '',
    documents: (item.reference_documents || []).map(toReferenceDocument),
  };
}

export function mapMissingDataResponse(response = {}) {
  return (response.missing_items || []).map(toMissingItem).filter((item) => item.name);
}

// 화면 곳곳(제출 상태 토글, 서식 초안, 감사 로그)이 누락자료를 '이름 문자열'로 다룹니다.
// 상세 정보는 이름을 열쇠로 하는 사전에 따로 담아, 기존 코드를 건드리지 않고 덧붙일 수 있게 합니다.
export function toMissingDocumentIndex(missingItems = []) {
  return Object.fromEntries(missingItems.map((item) => [item.name, item]));
}

// ---------------------------------------------------------------------------
// 파이프라인 실행 — 통합 엔드포인트 한 번 호출로 사건분석·구조대상 판정·누락자료를 모두 받습니다.
// 반환값(raw_input/case_analysis/relief_review_checklist/missing_items)을 그대로
// analysis.pipelineResponse에 보관해두면, 이후 '구조대상 판정'·'누락자료 점검' 버튼은 새로 요청을
// 보내지 않고 이미 받아둔 이 응답에서 mapEligibilityResponse/mapMissingDataResponse로 꺼내 쓰면 됩니다.
// ---------------------------------------------------------------------------

export function runConsultAnalysisStage(consultation) {
  return requestConsultAnalysis(buildConsultContent(consultation));
}
