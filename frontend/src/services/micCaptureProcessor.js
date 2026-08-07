// 마이크 원본 샘플을 전용 오디오 렌더링 스레드(메인 스레드가 아님)에서 8kHz로 리샘플링하고
// μ-law로 인코딩해 메인 스레드로 넘기는 AudioWorkletProcessor.
//
// 예전에는 이 작업을 메인 스레드에서 도는 ScriptProcessorNode 콜백이 했는데, React 렌더링·
// requestAnimationFrame 등으로 메인 스레드가 바쁠 때 콜백이 밀리거나 아예 건너뛰어졌고, 건너뛴
// 구간은 버퍼링 없이 그대로 유실돼 소리가 끊겨 들리는 원인이었다(realtimeAudioStream.js 참고).
// AudioWorkletProcessor는 메인 스레드 상황과 무관하게 오디오 스레드에서 안정적으로 호출된다.
//
// linearToMuLaw는 mulawCodec.js와 내용이 같지만 import하지 않고 그대로 복사해뒀다 —
// audioContext.audioWorklet.addModule()에 넘기는 이 파일의 URL은 프로덕션 빌드에서
// data: URL로 인라인되는데, data: URL은 상대경로를 해석할 base가 없어 그 안에서
// import './mulawCodec.js' 같은 상대 import를 쓰면 런타임에 모듈 로드가 실패한다.
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

const OUTPUT_SAMPLE_RATE = 8000;
// 8kHz 기준 80ms 분량. 기존 ScriptProcessor 청크(4096 samples @ 48kHz ≈ 85ms)와 비슷한
// 크기로 맞춰 WS 메시지 빈도·지연 사이의 균형을 그대로 유지한다.
const CHUNK_SAMPLES = 640;

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate는 AudioWorkletGlobalScope가 주입하는 전역(오디오 컨텍스트의 샘플레이트)이다.
    this.ratio = sampleRate / OUTPUT_SAMPLE_RATE;
    // 리샘플링 중 아직 다 못 쓴 입력 샘플들을 다음 process() 호출로 이어받기 위한 버퍼.
    this.pending = new Float32Array(0);
    // pending 버퍼 기준으로 다음 출력 샘플을 뽑아낼 위치(입력 샘플 도메인, 소수 가능).
    this.nextInputIndex = 0;
    this.outChunk = new Uint8Array(CHUNK_SAMPLES);
    this.outLength = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    const combined = new Float32Array(this.pending.length + input.length);
    combined.set(this.pending, 0);
    combined.set(input, this.pending.length);

    let index = this.nextInputIndex;
    while (index + 1 < combined.length) {
      const floor = Math.floor(index);
      const frac = index - floor;
      const a = combined[floor];
      const b = combined[floor + 1];
      const sample = a + (b - a) * frac;
      this.outChunk[this.outLength] = linearToMuLaw(sample);
      this.outLength += 1;
      if (this.outLength === CHUNK_SAMPLES) {
        this.port.postMessage(this.outChunk.buffer, [this.outChunk.buffer]);
        this.outChunk = new Uint8Array(CHUNK_SAMPLES);
        this.outLength = 0;
      }
      index += this.ratio;
    }

    const consumedWhole = Math.floor(index);
    this.pending = combined.slice(consumedWhole);
    this.nextInputIndex = index - consumedWhole;

    return true;
  }
}

registerProcessor('mic-capture-processor', MicCaptureProcessor);
