// 업로드한 음성파일을 텍스트로 바꾸고 개인정보를 가리는 창구입니다.
//
// stt-mask-api를 직접 부르지 않고 core-api를 거칩니다(/core-api/api/stt/**, SttApiProxyController).
// aiApiClient와 같은 이유입니다 — stt-mask-api에도 인증이 없고, 이쪽은 GPU를 쓰는 Whisper라
// 밖에 열려 있으면 음성 하나로 인스턴스를 통째로 붙잡아 둘 수 있습니다.
// 그래서 배포에서는 VPC 안에만 두고 core-api만 닿게 합니다.
//
// 대면 상담 실시간 녹음은 이 경로가 아닙니다(core-api WebSocket /ws/audio/**).
// 여기는 상담원이 자료 화면에서 음성파일을 고른 한 건짜리 경로입니다.
import { coreAuthHeader, CORE_API_BASE_URL } from './coreApiClientV2.js';

const STT_API_BASE_URL = `${CORE_API_BASE_URL}/api/stt`;
const STT_TIMEOUT_MS = 10 * 60 * 1000;

export async function transcribeAudio(file) {
  if (!(file instanceof File || file instanceof Blob)) {
    throw new Error('STT로 보낼 오디오 파일이 없습니다.');
  }

  const formData = new FormData();
  formData.append('file', file, file.name || 'recording.webm');
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), STT_TIMEOUT_MS);

  let response;
  try {
    // multipart 요청은 브라우저가 boundary를 붙이므로 Content-Type을 직접 지정하지 않습니다.
    // 토큰만 얹습니다 — core-api를 거치므로 없으면 401입니다.
    response = await fetch(`${STT_API_BASE_URL}/transcribe`, {
      method: 'POST',
      headers: coreAuthHeader(),
      body: formData,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('STT 변환 시간이 너무 오래 걸려 요청을 중단했습니다.');
    }
    throw new Error('Core API 서버에 연결할 수 없습니다. Spring Boot 서버가 켜져 있는지 확인해주세요.');
  } finally {
    window.clearTimeout(timeoutId);
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    // core-api가 돌려주는 오류 본문은 message 키를 씁니다(GlobalExceptionHandler).
    // 형식·크기 거절이 여기로 옵니다.
    throw new Error(data?.message || data?.detail || data?.error
      || `STT 요청 실패 (HTTP ${response.status})`);
  }
  if (data?.error) throw new Error(data.error);

  return {
    originalText: data?.original_text ?? data?.text ?? '',
    anonymizedText: data?.anonymized_text ?? data?.redacted_text ?? '',
    anonymizationMap: Array.isArray(data?.anonymization_map) ? data.anonymization_map : [],
    audioBase64: data?.audio_base64 || '',
  };
}

export { STT_API_BASE_URL };
