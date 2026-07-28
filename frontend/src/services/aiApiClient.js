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

// 참고: 예전에는 여기에 requestContractAnalysis(POST /analysis, 구 계약 mock)와
// requestConsultAnalysis(POST /consult/analyze 직접 호출)도 있었지만, 현재 아키텍처에서는
// core-api가 /consult/analyze 호출을 오케스트레이션하므로(triggerCoreAnalysis 참고) 두 함수 모두
// 프론트 어디서도 쓰이지 않는 죽은 코드였습니다. 그래서 제거했습니다.

export async function generateAiDraft(payload) {
  const response = await requestJson('/forms/draft', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, CASE_ANALYSIS_TIMEOUT_MS);
  if (response?.error) throw new Error(response.error);
  return response;
}

export { AI_API_BASE_URL };
