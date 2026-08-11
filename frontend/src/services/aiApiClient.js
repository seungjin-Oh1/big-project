// backend/ai-api(FastAPI)의 검색·추천 기능을 쓰는 창구입니다.
// legalAidApi.js가 "백엔드 연동 전 임시 목업"이라면, 이 파일은 "실제 백엔드에 연결되는 창구" 역할을 합니다.
//
// ai-api를 직접 부르지 않고 core-api를 거칩니다(/core-api/api/ai/**, AiApiProxyController).
// 예전에는 /ai-api로 곧장 불렀는데, 그러면 배포할 때 ai-api를 인터넷에 열어야 합니다.
// ai-api에는 인증이 하나도 없어서, 열리는 순간 누구나 우리 색인을 검색하고 LLM을 부르는
// 엔드포인트를 무제한으로 때릴 수 있습니다. 상담 요약문을 본문에 실어 보내는 경로이기도 합니다.
// core-api를 거치면 로그인한 사용자만 통과하고, ai-api는 VPC 안에만 둘 수 있습니다.
//
// 경로는 항상 상대경로입니다. 브라우저 입장에서 같은 오리진이라 CORS 문제가 없습니다.
import { coreAuthHeader, CORE_API_BASE_URL } from './coreApiClientV2.js';

const AI_API_BASE_URL = `${CORE_API_BASE_URL}/api/ai`;

// 엔드포인트별 요청 제한 시간(ms). 지정하지 않으면 기본값을 씁니다.
const DEFAULT_TIMEOUT_MS = 30_000;

// 요청이 timeoutMs를 넘기면 fetch 자체를 중단합니다.
// 이게 없으면 백엔드가 응답 없이 멈춰 있을 때 화면이 '분석 중…' 상태로 무한정 멈춰 보입니다.
// 시간 초과로 끊긴 요청은 호출부(fetchAnalysisWithFallback 등)가 잡아서 다음 대체 경로로 넘어갑니다.
async function requestJson(path, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${AI_API_BASE_URL}${path}`, {
      ...options,
      // core-api를 거치므로 로그인 토큰을 실어야 합니다. 없으면 401입니다.
      headers: { 'Content-Type': 'application/json', ...coreAuthHeader(), ...(options.headers || {}) },
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`AI API 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않아 요청을 중단했습니다.`);
    }
    throw new Error('Core API 서버에 연결할 수 없습니다. Spring Boot 서버가 켜져 있는지 확인해주세요.');
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorDetail = await response.text().catch(() => '');
    // 로그인이 풀렸거나(401) 권한이 없는 경우(403). 서식 개정 점검은 관리자 전용입니다.
    if (response.status === 401 || response.status === 403) {
      throw new Error('권한이 없습니다. 로그인 상태와 계정 권한을 확인해주세요.');
    }
    if (response.status === 502 || /bad gateway/i.test(errorDetail)) {
      if (path.startsWith('/forms/revisions')) {
        throw new Error(
          'AI API 서버는 연결됐지만 서식 개정 점검 대상에서 응답을 받지 못했습니다 (HTTP 502). '
          + '잠시 후 다시 시도하거나 ai-api 터미널의 서식 점검 오류를 확인해주세요.',
        );
      }
      throw new Error(
        'AI API 서버가 정상 응답하지 않습니다 (HTTP 502). '
        + 'ai-api가 http://127.0.0.1:8001에서 실행 중인지 확인한 뒤 다시 시도해주세요.',
      );
    }
    throw new Error(`AI API 요청 실패 (HTTP ${response.status}): ${errorDetail || response.statusText}`);
  }

  return response.json();
}

// 프론트-백엔드 연결 상태를 확인할 때 사용합니다 (GET /health).
export function checkAiApiHealth() {
  return requestJson('/health');
}

// 참고: 예전에는 여기에 requestContractAnalysis(POST /analysis, 구 계약 mock)와
// requestConsultAnalysis(POST /consult/analyze 직접 호출)도 있었지만, 현재 아키텍처에서는
// core-api가 /consult/analyze 호출을 오케스트레이션하므로(triggerCoreAnalysis 참고) 두 함수 모두
// 프론트 어디서도 쓰이지 않는 죽은 코드였습니다. 그래서 제거했습니다.

// 서식 개정 점검 (요구사항 AI-05-04-01).
// helplaw24 서식 목록 22페이지를 순회하며 받아오므로 기본 제한(30초)으로는 모자랍니다.
const FORM_REVISION_TIMEOUT_MS = 180_000;

// 점검만 합니다. 기준 스냅샷은 바뀌지 않으므로 여러 번 눌러도 결과가 같습니다.
export function checkFormRevisions() {
  return requestJson('/forms/revisions', {}, FORM_REVISION_TIMEOUT_MS);
}

// 관리자가 변경 내용을 확인했다는 표시. 현재 상태가 새 기준선이 되어
// 같은 변경이 다음 점검에서 다시 올라오지 않습니다.
export function acknowledgeFormRevisions() {
  return requestJson('/forms/revisions/acknowledge', { method: 'POST' }, FORM_REVISION_TIMEOUT_MS);
}

// 법령 검색·추천 (ai-api /statutes). 색인은 민법·가사소송법·가족관계등록법·
// 민사소송법·민사집행법의 조문 2,258개를 담고 있어, 결과는 법령 단위가 아니라
// 조문 단위(예: "민법 제1091조(유언증서, 녹음의 검인)")로 나옵니다.
//
// 임베딩 모델을 처음 부를 때 로딩이 있어 첫 요청만 느립니다.
const STATUTE_TIMEOUT_MS = 60_000;

// 상담원이 직접 넣은 검색어로 조문을 찾습니다.
export function searchStatutes({ query, lawId = '', topK = 5 }) {
  return requestJson('/statutes/search', {
    method: 'POST',
    body: JSON.stringify({ query, law_id: lawId || null, top_k: topK }),
  }, STATUTE_TIMEOUT_MS);
}

// 상담 분석 결과로 관련 조문을 추천합니다. 추천은 후보일 뿐이고 어떤 조문을
// 근거로 쓸지는 상담원·변호사가 정합니다(HITL) — 그래서 유사도와 근거를 함께 받습니다.
export function recommendStatutes(analysis, { topK = 5 } = {}) {
  return requestJson('/statutes/recommend', {
    method: 'POST',
    body: JSON.stringify({
      case_type: analysis?.caseType || analysis?.case_type || '',
      case_subtype: analysis?.caseSubtype || analysis?.case_subtype || '',
      summary: analysis?.summary || '',
      extracted_json: analysis?.extractedJson || analysis?.extracted_json || {},
      top_k: topK,
    }),
  }, STATUTE_TIMEOUT_MS);
}

// 판례 검색·추천 (ai-api /precedents). 색인은 2016년 이후 가사·이혼·상속·친족
// 판례를 담고, 한 사건을 판시사항·요약·전문으로 쪼개 넣습니다. 응답은 사건 단위로
// 중복을 걷어낸 뒤 나오므로 같은 사건이 여러 줄로 나오지 않습니다.
//
// 카드 키(id/title/content/effective_date/similarity_percent/source)는 법령과
// 같습니다. 화면이 탭마다 다른 키를 알 필요가 없게 맞춰 둔 것입니다 —
// effective_date 자리에는 선고일이, source 자리에는 법원명이 들어옵니다.
const PRECEDENT_TIMEOUT_MS = 60_000;

// 상담원이 직접 넣은 검색어로 판례를 찾습니다.
export function searchPrecedents({ query, courtLevel = '', topK = 5 }) {
  return requestJson('/precedents/search', {
    method: 'POST',
    body: JSON.stringify({ query, court_level: courtLevel || null, top_k: topK }),
  }, PRECEDENT_TIMEOUT_MS);
}

// 상담 분석 결과로 관련 판례를 추천합니다. 조문과 마찬가지로 후보 제시일 뿐이라
// 근거(reason)를 함께 받습니다. 판례는 사실관계가 조금만 달라도 결론이 뒤집혀서,
// 근거 없이 목록만 보면 상담원이 반대 결론의 판례를 골라 쓸 수 있습니다.
export function recommendPrecedents(analysis, { topK = 5 } = {}) {
  return requestJson('/precedents/recommend', {
    method: 'POST',
    body: JSON.stringify({
      case_type: analysis?.caseType || analysis?.case_type || '',
      case_subtype: analysis?.caseSubtype || analysis?.case_subtype || '',
      summary: analysis?.summary || '',
      extracted_json: analysis?.extractedJson || analysis?.extracted_json || {},
      top_k: topK,
    }),
  }, PRECEDENT_TIMEOUT_MS);
}

// 유사 상담사례 검색·추천 (ai-api /consultations). 색인은 공단이 공개한 상담 Q&A에서
// 가사 분야만 추린 1,664건입니다. 법령이 '조문', 판례가 '법원 판단'이라면 여기는
// '공단이 실제로 답변한 기록'이라, 같은 질문에 이미 나간 답이 있으면 그게 가장 빠릅니다.
//
// 카드 키는 법령·판례와 같습니다(id/title/content/effective_date/similarity_percent/source).
// title 자리에는 상담 질문이, content 자리에는 답변이 들어옵니다.
const CONSULTATION_TIMEOUT_MS = 60_000;

// 상담원이 직접 넣은 검색어로 유사 상담사례를 찾습니다.
export function searchConsultations({ query, topK = 5 }) {
  return requestJson('/consultations/search', {
    method: 'POST',
    body: JSON.stringify({ query, top_k: topK }),
  }, CONSULTATION_TIMEOUT_MS);
}

// 상담 분석 결과로 유사 상담사례를 추천합니다. 법령·판례와 달리 근거(reason)가
// 오지 않습니다 — 상담사례는 질문 한 줄이 곧 그 설명이라, 설명을 붙이려고 LLM을
// 한 번 더 부르면 응답만 느려집니다(ai-api routers/consultations.py 참고).
export function recommendConsultations(analysis, { topK = 3 } = {}) {
  return requestJson('/consultations/recommend', {
    method: 'POST',
    body: JSON.stringify({
      case_type: analysis?.caseType || analysis?.case_type || '',
      case_subtype: analysis?.caseSubtype || analysis?.case_subtype || '',
      summary: analysis?.summary || '',
      extracted_json: analysis?.extractedJson || analysis?.extracted_json || {},
      top_k: topK,
    }),
  }, CONSULTATION_TIMEOUT_MS);
}

// 카드에 실린 본문은 검색에 걸린 '조각 하나'입니다. 색인이 조문은 800자씩,
// 판례는 판시사항/판결요지/판례내용으로 쪼개 담기 때문입니다. 조각이 문장 중간에서
// 시작하거나 끝나는 일이 흔한데 화면에는 잘렸다는 표시가 없어서, 끝까지 읽고
// "이 조문엔 그런 내용 없다"고 결론내면 틀릴 수 있습니다.
//
// '전문 보기'는 이 두 함수로 문서 전체를 다시 받아 옵니다.
export function fetchStatuteFullText(id) {
  return requestJson('/statutes/full-text', {
    method: 'POST',
    body: JSON.stringify({ id }),
  }, STATUTE_TIMEOUT_MS);
}

// 판례는 사건 단위로 잡아야 합니다. 카드가 판시사항에서 걸렸으면 그 조각의
// 문서 id로는 판시사항밖에 못 모으는데, 상담원이 기대하는 '전문'은 판례내용입니다.
export function fetchPrecedentFullText({ id, precedentId = '' }) {
  return requestJson('/precedents/full-text', {
    method: 'POST',
    body: JSON.stringify({ id, precedent_id: precedentId || null }),
  }, PRECEDENT_TIMEOUT_MS);
}

// 상담 답변도 목록 카드에는 앞부분만 실립니다. 답변이 긴 상담은 결론이 뒤에 있어서
// 발췌만 읽으면 반대로 이해할 수 있습니다.
export function fetchConsultationFullText(id) {
  return requestJson('/consultations/full-text', {
    method: 'POST',
    body: JSON.stringify({ id }),
  }, CONSULTATION_TIMEOUT_MS);
}

export { AI_API_BASE_URL };
