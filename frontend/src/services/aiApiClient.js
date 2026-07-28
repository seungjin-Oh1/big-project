// backend/ai-api(FastAPI) 서버와 통신하는 실제 HTTP 클라이언트입니다.
// legalAidApi.js가 "백엔드 연동 전 임시 목업"이라면, 이 파일은 "실제 백엔드에 연결되는 창구" 역할을 합니다.
// 개발 중에는 Vite 프록시(/ai-api)를 통해 호출해 localhost/127.0.0.1 차이와 CORS 문제를 피합니다.
const AI_API_BASE_URL = import.meta.env.VITE_AI_API_BASE_URL || '/ai-api';

// 엔드포인트별 요청 제한 시간(ms). 지정하지 않으면 기본값을 씁니다.
// /consult/analyze는 첨부 녹취파일을 S3에서 받아 Whisper로 음성 인식까지 마친 뒤에야 응답하므로
// 다른 엔드포인트보다 훨씬 오래 걸릴 수 있어 별도로 더 긴 제한을 둡니다.
const DEFAULT_TIMEOUT_MS = 30_000;
const CASE_ANALYSIS_TIMEOUT_MS = 90_000;

// 요청이 timeoutMs를 넘기면 fetch 자체를 중단합니다.
// 이게 없으면 백엔드가 응답 없이 멈춰 있을 때 화면이 '분석 중…' 상태로 무한정 멈춰 보입니다.
// 시간 초과로 끊긴 요청은 호출부(fetchAnalysisWithFallback 등)가 잡아서 다음 대체 경로로 넘어갑니다.
async function requestJson(path, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${AI_API_BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: controller.signal,
      ...options,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`AI API 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않아 요청을 중단했습니다.`);
    }
    throw new Error('AI API 서버에 연결할 수 없습니다. ai-api 터미널이 켜져 있는지 확인해주세요.');
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorDetail = await response.text().catch(() => '');
    throw new Error(`AI API 요청 실패 (HTTP ${response.status}): ${errorDetail || response.statusText}`);
  }

  return response.json();
}

// 프론트-백엔드 연결 상태를 확인할 때 사용합니다 (GET /health).
export function checkAiApiHealth() {
  return requestJson('/health');
}

// FE/BE/AI 모델 팀이 합의한 AI_ANALYSIS 계약(contracts/ai_analysis_mock.json) 기준 분석 요청입니다 (POST /analysis).
// 실제 모델이 아직 붙기 전까지는 고정된 샘플을 반환하지만, 별도 API 키 없이도 항상 성공하는 실제 네트워크 호출입니다.
export function requestContractAnalysis(payload) {
  return requestJson('/analysis', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// 사건분석·구조대상 판정·누락자료 조회를 한 번에 처리하는 통합 엔드포인트입니다 (POST /consult/analyze).
// 예전에는 이 3가지를 /case-analysis -> /eligibility/analyze -> /missing-data/analyze 순서로
// 따로 호출했는데(각 응답을 다음 요청 본문에 그대로 실어 보내는 체인 방식이었습니다), ai-api 팀이
// app.agents.consult 그래프로 셋을 합쳐 "버튼 한 번 = 호출 한 번"이 되도록 통합했습니다.
// 응답은 { raw_input, case_analysis, relief_review_checklist, missing_items } 형태이며,
// 각 필드는 예전 3개 엔드포인트가 따로 주던 필드와 이름이 같아서 기존 매핑 함수를 그대로 씁니다.
// 주의: 실제 OpenAI API 키가 유효해야 정상 동작하고, 녹취파일이 있으면 S3 다운로드 + Whisper STT까지
// 서버에서 처리한 뒤 응답하므로 다른 요청보다 오래 걸릴 수 있어 CASE_ANALYSIS_TIMEOUT_MS를 적용합니다.
export function requestConsultAnalysis(content) {
  return requestJson('/consult/analyze', {
    method: 'POST',
    body: JSON.stringify({ content }),
  }, CASE_ANALYSIS_TIMEOUT_MS);
}

export async function generateAiDraft(payload) {
  const response = await requestJson('/forms/draft', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, CASE_ANALYSIS_TIMEOUT_MS);
  if (response?.error) throw new Error(response.error);
  return response;
}

export { AI_API_BASE_URL };
