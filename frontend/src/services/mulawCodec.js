// G.711 μ-law 인코딩/디코딩 순수 함수. 마이크 캡처(AudioWorklet, micCaptureProcessor.js)와
// 메인 스레드의 상대방 오디오 재생(realtimeAudioStream.js) 양쪽에서 같은 코덱을 써야 해서 분리했다.

const MU_LAW_DECODE_BIAS = 0x84;

export function linearToMuLaw(sample) {
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

export function muLawToLinear(encoded) {
  const mu = (~encoded) & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  const magnitude = ((mantissa << 3) + MU_LAW_DECODE_BIAS) << exponent;
  const sample = magnitude - MU_LAW_DECODE_BIAS;
  return sign !== 0 ? -sample : sample;
}
