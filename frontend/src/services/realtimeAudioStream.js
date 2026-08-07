// Core API의 /ws/audio/operator로 마이크 오디오를 전송하고, 상대방(외부 통화 레그) 오디오를
// 받아 재생합니다. 브라우저 MediaRecorder의 webm/opus 대신, 백엔드가 기대하는 8kHz G.711
// μ-law 바이너리 프레임으로 변환해 보냅니다. 백엔드는 이 오퍼레이터 레그를 같은 callId로 붙은
// 외부 통화 레그(ExternalCallWebSocketHandler)와 서로 중계하는 교환대 역할을 하며, 소켓으로
// 들어오는 바이너리 메시지도 같은 8비트 μ-law 프레임이므로 디코딩해서 스피커로 내보냅니다.
// 어떤 통화에 붙을지는 호출자가 start({ callId })로 넘긴 값을 그대로 씁니다
// (연결할 통화 선택은 GET /api/audio/calls 목록에서 상담원이 직접 고릅니다).

import { CORE_API_BASE_URL, coreAuthHeader } from './coreApiClientV2.js';
import { muLawToLinear } from './mulawCodec.js';

const DEFAULT_AUDIO_WS_PATH = '/ws/audio/operator';
const MIC_CAPTURE_WORKLET_URL = new URL('./micCaptureProcessor.js', import.meta.url);
const MIC_CAPTURE_WORKLET_NAME = 'mic-capture-processor';

function audioWebSocketUrl({ callId, ticket }) {
  const configured = import.meta.env.VITE_AUDIO_WS_URL;
  const endpoint = configured || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${DEFAULT_AUDIO_WS_PATH}`;
  const separator = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${separator}callId=${encodeURIComponent(callId)}&ticket=${encodeURIComponent(ticket)}`;
}

// 외부 전화/SIP 서버가 먼저 등록한 통화 중 상담원이 연결할 수 있는 목록입니다.
// 이미 다른 상담원이 연결한 CONNECTED 상태는 선택지에서 제외합니다.
export async function fetchAvailableAudioCalls() {
  let response;
  try {
    response = await fetch(`${CORE_API_BASE_URL}/api/audio/calls`, {
      headers: coreAuthHeader(),
    });
  } catch {
    throw new Error('진행 중인 통화 목록을 불러올 수 없습니다. Core API 서버 상태를 확인해주세요.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('통화 목록을 조회할 권한이 없습니다. 다시 로그인해주세요.');
  }
  if (!response.ok) {
    throw new Error(`통화 목록을 불러오지 못했습니다.(HTTP ${response.status})`);
  }
  const calls = await response.json();
  return Array.isArray(calls)
    ? calls.filter((call) => call?.callId && call.status === 'WAITING')
    : [];
}

// 소켓에 붙기 전에 1회용 티켓을 받아옵니다.
//
// core-api는 로그인한 사용자만 쓸 수 있게 잠겨 있는데, 브라우저의 new WebSocket()에는
// Authorization 헤더를 넣을 자리가 없습니다. 그래서 헤더를 쓸 수 있는 이 REST 요청으로
// 먼저 티켓을 받고, 그 티켓만 소켓 주소에 실어 보냅니다.
// 주소는 접속 로그·브라우저 히스토리에 남기 때문에 24시간짜리 JWT를 그대로 붙이지 않습니다.
// 티켓은 30초 1회용이라 주소에 남더라도 이미 만료됐거나 소모된 값입니다.
async function requestAudioTicket() {
  let response;
  try {
    response = await fetch(`${CORE_API_BASE_URL}/api/audio/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...coreAuthHeader() },
    });
  } catch {
    throw new Error('통화 서버에 연결할 수 없습니다. Core API 서버가 켜져 있는지 확인해주세요.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('통화 권한이 없습니다. 다시 로그인해주세요.');
  }
  if (!response.ok) {
    throw new Error(`통화 연결을 준비하지 못했습니다 (HTTP ${response.status})`);
  }
  const body = await response.json();
  if (!body?.ticket) throw new Error('통화 연결 티켓을 받지 못했습니다.');
  return body.ticket;
}

// 상대방 오디오 바이트(μ-law)를 Web Audio가 재생할 수 있는 -1..1 범위 Float32로 바꿉니다.
function decodeMuLawBytes(bytes) {
  const samples = new Float32Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    samples[index] = muLawToLinear(bytes[index]) / 32768;
  }
  return samples;
}

// 서버가 오디오를 받는 것과 별개로 실시간 자막(STT 중간/최종 결과) 텍스트 프레임을 같은
// 소켓으로 돌려보내 줄 때 화면에 뿌리기 위한 자리입니다. 백엔드가 아직 이 프레임을 보내지
// 않아 지금은 항상 빈 채로 남지만(코치 피드백: "실시간 통화 기술" 중 프론트가 먼저 준비해둘
// 수 있는 부분), 백엔드가 붙는 순간 바로 동작하도록 파싱·콜백 구조만 미리 만들어 둡니다.
// 기대하는 프레임 모양: { type: 'transcript', text: string, isFinal?: boolean }
function parseTranscriptFrame(raw) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || parsed.type !== 'transcript' || typeof parsed.text !== 'string') return null;
  return { text: parsed.text, isFinal: Boolean(parsed.isFinal) };
}

// analyser의 현재 파형에서 RMS(진폭의 제곱평균제곱근)를 구해 0~1 근처 값으로 돌려줍니다.
// analyser나 버퍼가 아직 없으면(통화 시작 전/종료 후) 0을 돌려줍니다.
function rmsLevel(analyser, buffer) {
  if (!analyser || !buffer) return 0;
  analyser.getByteTimeDomainData(buffer);
  let sumSquares = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const normalized = (buffer[index] - 128) / 128;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / buffer.length);
}

export class RealtimeAudioStream {
  constructor({ onStatus, onError, onTranscript } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    this.onTranscript = onTranscript || (() => {});
    this.socket = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.source = null;
    this.micNode = null;
    this.silentGain = null;
    this.playbackCursor = 0;
    // 내 음성(마이크)·상대방 음성(재생) 크기를 화면에 보여주기 위한 분석 노드. 오디오 자체를
    // 바꾸지 않고 지나가는 값만 읽는 패스스루라, 기존 마이크 전송·재생 경로 중간에 그대로 끼워 넣습니다.
    this.micAnalyser = null;
    this.remoteAnalyser = null;
    this.micLevelBuffer = null;
    this.remoteLevelBuffer = null;
    this.remoteGain = null;
    // 상담원이 시각화 위젯의 마이크/스피커 아이콘으로 직접 끄고 켤 수 있는 음소거 상태입니다.
    this.micMuted = false;
    this.remoteMuted = false;
  }

  async start({ callId } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('이 브라우저에서는 마이크 입력을 사용할 수 없습니다.');
    }
    if (!callId) {
      throw new Error('연결할 통화를 선택해주세요.');
    }
    this.onStatus('connecting');
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    // 통화를 다시 시작하는 게 아니라 같은 인스턴스로 재연결하는 경우를 대비해, 이전에
    // 눌러둔 음소거 상태를 새 트랙에도 그대로 적용합니다.
    this.mediaStream.getAudioTracks().forEach((track) => { track.enabled = !this.micMuted; });
    try {
      // 티켓은 30초짜리라 연결할 때마다 새로 받습니다(재사용도 막혀 있습니다).
      const ticket = await requestAudioTicket();
      const url = audioWebSocketUrl({ callId, ticket });
      this.socket = new WebSocket(url);
      this.socket.binaryType = 'arraybuffer';
      await new Promise((resolve, reject) => {
        this.socket.addEventListener('open', resolve, { once: true });
        this.socket.addEventListener('error', (e) => reject(new Error('오디오 스트림 서버에 연결할 수 없습니다.' + e)), { once: true });
      });

      // 핸드셰이크가 성공해도, 백엔드가 그 직후 이 통화에 이미 다른 오퍼레이터가 붙어 있거나
      // 통화가 끝나버린 걸 알게 되면 곧바로 소켓을 닫습니다(정책 위반 close). stop()이 보내는
      // 정상 종료(코드 1000)가 아니면 오류로 알립니다.
      this.socket.addEventListener('close', (event) => {
        this.onStatus('ended');
        if (event.code !== 1000) {
          this.onError(new Error(event.reason || '통화 연결이 종료되었습니다.'));
        }
      });

      this.socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          const transcript = parseTranscriptFrame(event.data);
          if (transcript) this.onTranscript(transcript);
          return;
        }
        this.playIncomingAudio(event.data);
      });

      this.audioContext = new AudioContext();
      await this.audioContext.resume();
      // 마이크 캡처(8kHz 리샘플링 + μ-law 인코딩)를 메인 스레드가 아닌 전용 오디오 스레드에서
      // 돌리기 위해 AudioWorkletNode를 씁니다. 예전에 쓰던 ScriptProcessorNode는 메인 스레드
      // 콜백이라 React 렌더링 등으로 스레드가 바쁘면 콜백이 밀리거나 건너뛰어졌고, 그 구간이
      // 버퍼링 없이 통째로 유실돼 소리가 끊겨 들렸습니다(micCaptureProcessor.js 참고).
      await this.audioContext.audioWorklet.addModule(MIC_CAPTURE_WORKLET_URL);
      this.playbackCursor = this.audioContext.currentTime;
      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.micNode = new AudioWorkletNode(this.audioContext, MIC_CAPTURE_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      this.silentGain = this.audioContext.createGain();
      this.silentGain.gain.value = 0;
      this.micNode.port.onmessage = (event) => {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        this.socket.send(event.data);
      };
      // 마이크 신호는 source -> micAnalyser -> micNode 순서로 그대로 흘려보내(내용은 안 바꿈),
      // micAnalyser가 destination까지 이어진 능동 그래프의 일부가 되어 매 프레임 값을 갱신하게 합니다.
      this.micAnalyser = this.audioContext.createAnalyser();
      this.micAnalyser.fftSize = 256;
      this.micLevelBuffer = new Uint8Array(this.micAnalyser.fftSize);
      this.source.connect(this.micAnalyser);
      this.micAnalyser.connect(this.micNode);
      this.micNode.connect(this.silentGain);
      this.silentGain.connect(this.audioContext.destination);
      // 상대방 오디오는 각 프레임마다 새 AudioBufferSourceNode로 재생되므로(playIncomingAudio),
      // 여기서는 재생 경로에 상시 끼워둘 gain(음소거용)과 analyser를 만들어 destination 앞에 둡니다.
      // gain을 analyser보다 앞에 둬서, 음소거하면 시각화 막대도 함께 0으로 내려가게 합니다.
      this.remoteGain = this.audioContext.createGain();
      this.remoteGain.gain.value = this.remoteMuted ? 0 : 1;
      this.remoteAnalyser = this.audioContext.createAnalyser();
      this.remoteAnalyser.fftSize = 256;
      this.remoteLevelBuffer = new Uint8Array(this.remoteAnalyser.fftSize);
      this.remoteGain.connect(this.remoteAnalyser);
      this.remoteAnalyser.connect(this.audioContext.destination);
      this.onStatus('streaming');
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  // 상대방 μ-law 프레임 하나를 디코딩해 재생 큐 뒤에 이어 붙입니다.
  // playbackCursor가 현재 시각보다 과거로 밀려 있으면(끊김 후 재개 등) 밀린 구간을
  // 몰아서 재생하지 않고 지금 시각부터 다시 이어 붙입니다.
  playIncomingAudio(data) {
    if (!this.audioContext || !(data instanceof ArrayBuffer) || data.byteLength === 0) return;
    const samples = decodeMuLawBytes(new Uint8Array(data));
    const buffer = this.audioContext.createBuffer(1, samples.length, 8000);
    buffer.copyToChannel(samples, 0);
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.remoteGain || this.remoteAnalyser || this.audioContext.destination);
    const startAt = Math.max(this.audioContext.currentTime, this.playbackCursor);
    source.start(startAt);
    this.playbackCursor = startAt + buffer.duration;
  }

  // 마이크(mic)·상대방(remote) 음성의 지금 이 순간 크기를 0~1 사이 값으로 돌려줍니다.
  // 파형(time-domain) 데이터의 RMS를 씁니다 — 주파수 분해까지는 필요 없고, "지금 얼마나
  // 크게 들리는지"만 있으면 되는 막대 표시용이라 계산이 가장 단순한 방식을 골랐습니다.
  getLevels() {
    return {
      mic: rmsLevel(this.micAnalyser, this.micLevelBuffer),
      remote: rmsLevel(this.remoteAnalyser, this.remoteLevelBuffer),
    };
  }

  // 내 마이크를 끄고 켭니다. 트랙 자체를 비활성화해서(track.enabled = false), 서버로 나가는
  // 오디오도 무음이 되고 — 실제로 상대방에게 들리지 않습니다 — 시각화 막대도 같이 0이 됩니다.
  setMicMuted(muted) {
    this.micMuted = muted;
    this.mediaStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  }

  // 상대방 음성 재생을 끄고 켭니다. gain을 0으로 낮춰 스피커 출력만 막고, 수신 자체는
  // 계속되므로(연결이 끊기지 않으므로) 다시 켜면 그 순간부터 이어서 들립니다.
  setRemoteMuted(muted) {
    this.remoteMuted = muted;
    if (this.remoteGain) this.remoteGain.gain.value = muted ? 0 : 1;
  }

  stop() {
    if (this.micNode) {
      this.micNode.port.onmessage = null;
      this.micNode.disconnect();
    }
    if (this.source) this.source.disconnect();
    if (this.silentGain) this.silentGain.disconnect();
    if (this.micAnalyser) this.micAnalyser.disconnect();
    if (this.remoteAnalyser) this.remoteAnalyser.disconnect();
    if (this.remoteGain) this.remoteGain.disconnect();
    if (this.audioContext && this.audioContext.state !== 'closed') this.audioContext.close();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'call-ended');
    if (this.mediaStream) this.mediaStream.getTracks().forEach((track) => track.stop());
    this.micNode = null;
    this.source = null;
    this.silentGain = null;
    this.micAnalyser = null;
    this.remoteAnalyser = null;
    this.micLevelBuffer = null;
    this.remoteLevelBuffer = null;
    this.remoteGain = null;
    this.audioContext = null;
    this.socket = null;
    this.mediaStream = null;
    this.playbackCursor = 0;
    this.onStatus('idle');
  }
}

export function createRealtimeAudioStream(options) {
  return new RealtimeAudioStream(options);
}
