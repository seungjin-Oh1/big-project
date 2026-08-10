// 대면 상담 녹음 마이크 원본 샘플을 오디오 렌더링 스레드에서 16kHz mono 32비트 float PCM으로
// 리샘플링해 메인 스레드로 넘기는 AudioWorkletProcessor. micCaptureProcessor.js(전화 통화,
// 8kHz μ-law)와 같은 이유로 메인 스레드가 아닌 전용 오디오 스레드에서 돈다 — React 렌더링 등으로
// 메인 스레드가 바쁠 때 캡처가 밀리거나 끊기지 않게 하기 위함.
//
// μ-law로 인코딩하는 통화 경로와 달리 인코딩 없이 리샘플링된 float32 샘플을 그대로 내보낸다.
// 컨테이너·인코딩이 없는 16kHz mono float32(-1..1) PCM이 이 프로젝트가 대면 녹음 오디오
// 전송에 쓰기로 정한 표현이다(useInPersonRecording.js) — 브라우저별 MediaRecorder 컨테이너
// 차이에 좌우되지 않고, 받는 쪽(외부 오디오 게이트웨이)이 별도 디코딩 없이 바로 쓸 수 있다.
//
// 이 파일을 audioContext.audioWorklet.addModule()에 넘기면 프로덕션 빌드에서 data: URL로
// 인라인되므로, micCaptureProcessor.js와 마찬가지로 다른 파일을 import하지 않는다.

const OUTPUT_SAMPLE_RATE = 16000;
// 16kHz 기준 100ms 분량. 너무 작으면 메인 스레드로 보내는 postMessage 빈도가 과해지고,
// 너무 크면 청크 경계 지연이 커진다 — 기존 μ-law 경로의 80ms(640 samples @ 8kHz)와 같은 자릿수.
const CHUNK_SAMPLES = 1600;

class InPersonPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate는 AudioWorkletGlobalScope가 주입하는 전역(오디오 컨텍스트의 샘플레이트)이다.
    this.ratio = sampleRate / OUTPUT_SAMPLE_RATE;
    // 리샘플링 중 아직 다 못 쓴 입력 샘플들을 다음 process() 호출로 이어받기 위한 버퍼.
    this.pending = new Float32Array(0);
    // pending 버퍼 기준으로 다음 출력 샘플을 뽑아낼 위치(입력 샘플 도메인, 소수 가능).
    this.nextInputIndex = 0;
    this.outChunk = new Float32Array(CHUNK_SAMPLES);
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
      this.outChunk[this.outLength] = a + (b - a) * frac;
      this.outLength += 1;
      if (this.outLength === CHUNK_SAMPLES) {
        this.port.postMessage(this.outChunk.buffer, [this.outChunk.buffer]);
        this.outChunk = new Float32Array(CHUNK_SAMPLES);
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

registerProcessor('in-person-pcm-capture-processor', InPersonPcmCaptureProcessor);
