// Core API의 /ws/audio/mulaw로 마이크 오디오를 전송합니다.
// 브라우저 MediaRecorder의 webm/opus 대신, 백엔드가 기대하는 8kHz G.711 μ-law
// 바이너리 프레임으로 변환해 보냅니다. 현재 백엔드는 수신·PCM 디코딩까지만 하므로
// 이 모듈은 전송 상태를 제공하고, STT 텍스트는 기존 상담 메모 흐름을 유지합니다.

const DEFAULT_AUDIO_WS_PATH = '/ws/audio/mulaw';

function audioWebSocketUrl() {
  const configured = import.meta.env.VITE_AUDIO_WS_URL;
  if (configured) return configured;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${DEFAULT_AUDIO_WS_PATH}`;
}

function downsample(buffer, inputSampleRate, outputSampleRate = 8000) {
  if (inputSampleRate === outputSampleRate) return buffer;
  if (inputSampleRate < outputSampleRate) return buffer;
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(buffer.length / ratio);
  const output = new Float32Array(outputLength);
  let offset = 0;
  for (let index = 0; index < outputLength; index += 1) {
    const nextOffset = Math.round((index + 1) * ratio);
    let total = 0;
    let count = 0;
    for (let sourceIndex = offset; sourceIndex < nextOffset && sourceIndex < buffer.length; sourceIndex += 1) {
      total += buffer[sourceIndex];
      count += 1;
    }
    output[index] = count ? total / count : 0;
    offset = nextOffset;
  }
  return output;
}

function linearToMuLaw(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  const pcm = clamped < 0 ? clamped * 32768 : clamped * 32767;
  const sign = pcm < 0 ? 0x80 : 0;
  let magnitude = Math.min(32635, Math.abs(pcm));
  magnitude += 132;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (magnitude & mask) === 0; mask >>= 1) exponent -= 1;
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export class RealtimeAudioStream {
  constructor({ onStatus, onError } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    this.socket = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.source = null;
    this.processor = null;
    this.silentGain = null;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('이 브라우저에서는 마이크 입력을 사용할 수 없습니다.');
    }
    this.onStatus('connecting');
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    try {
      this.socket = new WebSocket(audioWebSocketUrl());
      this.socket.binaryType = 'arraybuffer';
      await new Promise((resolve, reject) => {
        this.socket.addEventListener('open', resolve, { once: true });
        this.socket.addEventListener('error', () => reject(new Error('오디오 스트림 서버에 연결할 수 없습니다.')), { once: true });
      });

      this.audioContext = new AudioContext();
      await this.audioContext.resume();
      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.silentGain = this.audioContext.createGain();
      this.silentGain.gain.value = 0;
      this.processor.onaudioprocess = (event) => {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const samples = downsample(input, this.audioContext.sampleRate, 8000);
        const payload = new Uint8Array(samples.length);
        samples.forEach((sample, index) => { payload[index] = linearToMuLaw(sample); });
        this.socket.send(payload.buffer);
      };
      this.source.connect(this.processor);
      this.processor.connect(this.silentGain);
      this.silentGain.connect(this.audioContext.destination);
      this.onStatus('streaming');
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    if (this.processor) this.processor.disconnect();
    if (this.source) this.source.disconnect();
    if (this.silentGain) this.silentGain.disconnect();
    if (this.audioContext && this.audioContext.state !== 'closed') this.audioContext.close();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'call-ended');
    if (this.mediaStream) this.mediaStream.getTracks().forEach((track) => track.stop());
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    this.audioContext = null;
    this.socket = null;
    this.mediaStream = null;
    this.onStatus('idle');
  }
}

export function createRealtimeAudioStream(options) {
  return new RealtimeAudioStream(options);
}
