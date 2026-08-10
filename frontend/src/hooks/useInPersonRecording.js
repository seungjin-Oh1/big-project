// 대면 상담 녹음 → core-api /ws/audio/operator 연동 훅.
//
// 전화 실시간 상담(realtimeAudioStream.js)과 완전히 같은 경로를 씁니다. core-api는 통화든
// 대면 녹음이든 CallRegistry로 "오퍼레이터 레그 ↔ 외부 레그"를 중계할 뿐 구분하지 않습니다 —
// 전화는 외부 SIP 게이트웨이가 외부 레그로 걸어 들어오고, 대면 녹음은 core-api 자신이 그
// 게이트웨이(app.audio.in-person-gateway-ws-url, 이 레포 밖의 시스템)로 걸어 나가 그 자리를
// 대신합니다(InPersonCallInitiator, POST /api/audio/in-person-calls). 그래서 이 훅이 할 일은
// (1) 그 callId를 받고 (2) 전화와 똑같이 1회성 티켓을 받아(POST /api/audio/tickets — 브라우저
// new WebSocket()에는 Authorization 헤더를 못 실으므로) (3) /ws/audio/operator?callId=...
// &ticket=...로 붙는 것뿐입니다.
//
// STT/마스킹은 그 외부 게이트웨이가 처리하고, 결과는 core-api를 그대로 통과해 이 소켓으로
// 돌아옵니다 — core-api·이 훅 어느 쪽도 오디오나 결과의 내용을 들여다보지 않는 순수 중계입니다.
// 이전엔 존재하지 않는 외부 mic-stt(8000번 포트)에 직접 붙어 segments/ai_judge/validation을
// 받는 구조였는데, 그 서버가 이 레포 어디에도 없어 실제로는 동작하지 않았습니다.
//
// 오디오 캡처는 realtimeAudioStream.js(전화 통화)와 같은 AudioWorklet 방식을 씁니다 —
// MediaRecorder의 브라우저별 기본 컨테이너(Chrome은 webm/opus, Safari는 mp4/aac 등 제각각)
// 대신, inPersonPcmCaptureProcessor.js가 오디오 스레드에서 16kHz mono 32비트 float PCM으로
// 리샘플링한 샘플을 그대로 씁니다. 컨테이너가 없어 브라우저 종류에 좌우되지 않고, 원본 그대로라
// 인코딩 손실도 없습니다 — 이 프로젝트가 정한 전송 포맷이며, 실제 외부 게이트웨이가 이와 다른
// 형식을 기대한다면 그쪽 계약에 맞춰 이 워클릿을 바꿔야 합니다. 실시간 스트리밍 대신 5초치
// float32 샘플을 모았다가 "그 자체로 완결된" 조각으로 한 번에 binary 전송하는 방식을 씁니다.
//
// 응답 프로토콜(실측, 2026-08-10): 게이트웨이는 오디오 조각 단위가 아니라 문장 단위 스트리밍
// STT로 {"type":"transcript","text":"...","isFinal":boolean} 프레임을 여러 번 보냅니다.
// isFinal:false는 아직 흔들리는 중간 인식 결과(문장이 이어지며 text가 계속 갱신됨)이고,
// isFinal:true가 와야 그 문장이 확정된 것입니다 — 중간 결과를 메모에 바로 이어붙이면 같은
// 말이 여러 번 겹쳐 쌓입니다. 그래서 확정된 문장만 segments에 쌓고(idx는 도착 순서로 직접
// 매김), 미확정 문장은 interimText로 따로 노출해 화면에서 "받아쓰는 중"으로만 보여줍니다.
// 이 프레임에는 마스킹본이 없습니다 — 게이트웨이가 마스킹까지 해준다고 가정했던 예전 설계와
// 달리 순수 STT 텍스트만 옵니다. 그래서 지금은 원문(text)만 채우고 마스킹본은 비워둡니다
// (이후 별도로 연결 예정). {type:'segment_result'|'segment_error'|'done'} 형태는 예전에
// 가정했던 프로토콜인데, 실제로 오는지 불확실하지만 오면 여전히 처리하도록 남겨둡니다 — 특히
// 'done'은 녹음 종료 후 서버가 처리를 다 마쳤다는 신호로 계속 쓰입니다.

import { useEffect, useRef, useState } from 'react';
import { CORE_API_BASE_URL, coreAuthHeader } from '../services/coreApiClientV2.js';

const CHUNK_INTERVAL_MS = 5000;
const OPERATOR_WS_PATH = '/ws/audio/operator';
const PCM_CAPTURE_WORKLET_URL = new URL('../services/inPersonPcmCaptureProcessor.js', import.meta.url);
const PCM_CAPTURE_WORKLET_NAME = 'in-person-pcm-capture-processor';

// 대면 녹음을 "통화"로 등록해 callId를 받습니다(InPersonCallInitiator가 외부 오디오
// 게이트웨이에 대신 걸어 나가 외부 레그로 등록해둠). 이 callId로만 /ws/audio/operator에
// 붙을 수 있습니다.
async function requestInPersonCallId() {
  let response;
  try {
    response = await fetch(`${CORE_API_BASE_URL}/api/audio/in-person-calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...coreAuthHeader() },
    });
  } catch {
    throw new Error('녹음 서버에 연결할 수 없습니다. Core API 서버가 켜져 있는지 확인해주세요.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('녹음 권한이 없습니다. 다시 로그인해주세요.');
  }
  if (!response.ok) {
    throw new Error(`녹음 세션을 준비하지 못했습니다 (HTTP ${response.status})`);
  }
  const body = await response.json();
  if (!body?.callId) throw new Error('녹음 세션 ID를 받지 못했습니다.');
  return body.callId;
}

// 티켓은 30초짜리라 연결할 때마다 새로 받아야 합니다(재사용도 막혀 있습니다).
async function requestInPersonAudioTicket() {
  let response;
  try {
    response = await fetch(`${CORE_API_BASE_URL}/api/audio/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...coreAuthHeader() },
    });
  } catch {
    throw new Error('녹음 서버에 연결할 수 없습니다. Core API 서버가 켜져 있는지 확인해주세요.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('녹음 권한이 없습니다. 다시 로그인해주세요.');
  }
  if (!response.ok) {
    throw new Error(`녹음 연결을 준비하지 못했습니다 (HTTP ${response.status})`);
  }
  const body = await response.json();
  if (!body?.ticket) throw new Error('녹음 연결 티켓을 받지 못했습니다.');
  return body.ticket;
}

// realtimeAudioStream.js의 audioWebSocketUrl과 같은 엔드포인트·같은 환경변수를 씁니다 —
// 전화 상담과 진짜로 같은 경로를 타는 것이라 별도 설정이 필요 없습니다.
function operatorWebSocketUrl({ callId, ticket }) {
  const configured = import.meta.env.VITE_AUDIO_WS_URL;
  const base = configured || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${OPERATOR_WS_PATH}`;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}callId=${encodeURIComponent(callId)}&ticket=${encodeURIComponent(ticket)}`;
}

export function useInPersonRecording({ consultationId }) {
  const [status, setStatus] = useState('idle'); // idle | connecting | recording | processing | done | error
  // 확정된(isFinal:true) 문장만 도착 순서로 쌓입니다 — { idx, text } 또는 실패 시 { idx, error }.
  const [segments, setSegments] = useState([]);
  // 아직 확정되지 않은(isFinal:false) 문장의 최신 인식 결과. 메모에는 반영하지 않고
  // "받아쓰는 중" 미리보기로만 씁니다 — isFinal:true가 오면 비웁니다.
  const [interimText, setInterimText] = useState('');
  const [errorMessage, setErrorMessage] = useState(null);

  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceRef = useRef(null);
  const workletRef = useRef(null);
  const silentGainRef = useRef(null);
  // 워클릿이 100ms 단위로 보내오는 float32 조각들을 5초치가 쌓일 때까지 모아둡니다.
  const pcmChunksRef = useRef([]);
  const pcmSampleCountRef = useRef(0);
  const flushTimerRef = useRef(null);
  const stoppingRef = useRef(false);

  useEffect(() => () => cleanupMedia(), []);

  // consultationId가 바뀌면(상담원이 드롭다운으로 다른 사건을 고르면) 이전 사건의 녹음
  // 상태·세그먼트가 그대로 남아 새 사건 화면에 비쳐 보이는 문제가 있었습니다. 전화상담의
  // callStatus를 selectedId 변경 시 초기화하는 것과 같은 이유로, 여기서도 사건이 바뀌면
  // 진행 중이던 녹음을 정리하고 상태를 완전히 리셋합니다.
  const prevConsultationIdRef = useRef(consultationId);
  useEffect(() => {
    if (prevConsultationIdRef.current === consultationId) return;
    prevConsultationIdRef.current = consultationId;
    cleanupMedia();
    stoppingRef.current = false;
    setStatus('idle');
    setSegments([]);
    setInterimText('');
    setErrorMessage(null);
  }, [consultationId]);

  function cleanupMedia() {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
    if (workletRef.current) {
      workletRef.current.port.onmessage = null;
      workletRef.current.disconnect();
    }
    if (sourceRef.current) sourceRef.current.disconnect();
    if (silentGainRef.current) silentGainRef.current.disconnect();
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') audioContextRef.current.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    wsRef.current?.close();
    workletRef.current = null;
    sourceRef.current = null;
    silentGainRef.current = null;
    audioContextRef.current = null;
    pcmChunksRef.current = [];
    pcmSampleCountRef.current = 0;
  }

  // 모아둔 float32 조각들을 하나로 이어붙여 "그 자체로 완결된" 5초 분량 오디오 프레임 하나로
  // 보냅니다. isFinal이면 녹음 종료 신호까지 이어서 보내고 마이크를 끕니다.
  function flushChunk(isFinal) {
    const chunks = pcmChunksRef.current;
    const totalSamples = pcmSampleCountRef.current;
    pcmChunksRef.current = [];
    pcmSampleCountRef.current = 0;

    if (totalSamples > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
      const merged = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      wsRef.current.send(merged.buffer);
      // eslint-disable-next-line no-console
      console.log('[in-person-audio] sent chunk', { samples: totalSamples, bytes: merged.buffer.byteLength });
    }

    if (isFinal) {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'end' }));
        // eslint-disable-next-line no-console
        console.log('[in-person-audio] sent end signal');
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    } else {
      flushTimerRef.current = setTimeout(() => flushChunk(false), CHUNK_INTERVAL_MS);
    }
  }

  const startRecording = async () => {
    if (!consultationId) {
      setStatus('error');
      setErrorMessage('사건을 먼저 선택해주세요.');
      return;
    }
    setStatus('connecting');
    setErrorMessage(null);
    setSegments([]);
    setInterimText('');
    stoppingRef.current = false;
    pcmChunksRef.current = [];
    pcmSampleCountRef.current = 0;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[in-person-audio] getUserMedia failed', error);
      setStatus('error');
      setErrorMessage('마이크에 연결할 수 없습니다. 브라우저 마이크 권한을 확인해주세요.');
      return;
    }
    streamRef.current = stream;

    try {
      const callId = await requestInPersonCallId();
      // eslint-disable-next-line no-console
      console.log('[in-person-audio] got callId', callId);
      const ticket = await requestInPersonAudioTicket();
      // eslint-disable-next-line no-console
      console.log('[in-person-audio] got ticket, connecting ws', operatorWebSocketUrl({ callId, ticket: '***' }));
      const ws = new WebSocket(operatorWebSocketUrl({ callId, ticket }));
      wsRef.current = ws;

      // 리스너를 소켓 생성 직후 바로 붙입니다. AudioContext/워클릿 준비(아래, await 여러 개)가
      // 끝나기를 기다렸다가 붙이면 그 사이에 로컬 연결처럼 빠른 open/error/close가 이미
      // 발생해버려 리스너가 못 잡는 경우가 있었습니다(EventTarget은 지난 이벤트를 재생해주지
      // 않음) — 그러면 5초마다 도는 flushTimer가 아예 안 켜져서 오디오가 하나도 스트리밍되지
      // 않고 녹음 종료 시점에 쌓인 전체가 한 번에 나가 버퍼 초과(코드 1009)로 끊겼습니다.
      ws.addEventListener('open', () => {
        // eslint-disable-next-line no-console
        console.log('[in-person-audio] ws open, callId=', callId);
        if (stoppingRef.current) {
          ws.send(JSON.stringify({ type: 'end' }));
          return;
        }
        setStatus('recording');
        flushTimerRef.current = setTimeout(() => flushChunk(false), CHUNK_INTERVAL_MS);
      });

      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
          // eslint-disable-next-line no-console
          console.log('[in-person-audio] received non-text frame, ignoring', { byteLength: event.data?.byteLength });
          return;
        }
        // eslint-disable-next-line no-console
        console.log('[in-person-audio] received', event.data);
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (payload.type === 'transcript') {
          if (payload.isFinal) {
            setSegments((current) => [...current, { idx: current.length, text: payload.text }]);
            setInterimText('');
          } else {
            setInterimText(payload.text || '');
          }
        } else if (payload.type === 'segment_result') {
          setSegments((current) => [...current, { idx: payload.idx, text: payload.text, maskedText: payload.maskedText }]);
        } else if (payload.type === 'segment_error') {
          setSegments((current) => [...current, { idx: payload.idx, error: payload.error }]);
        } else if (payload.type === 'done') {
          setStatus('done');
          ws.close(1000, 'recording-done');
        }
      });

      ws.addEventListener('error', (event) => {
        // eslint-disable-next-line no-console
        console.error('[in-person-audio] ws error', event);
        setStatus('error');
        setErrorMessage('녹음 서버 연결 오류');
      });

      ws.addEventListener('close', (event) => {
        // eslint-disable-next-line no-console
        console.log('[in-person-audio] ws closed', { code: event.code, reason: event.reason });
        setStatus((prev) => (prev === 'done' ? prev : (event.code === 1000 ? prev : 'error')));
      });

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      await audioContext.resume();
      await audioContext.audioWorklet.addModule(PCM_CAPTURE_WORKLET_URL);
      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;
      const worklet = new AudioWorkletNode(audioContext, PCM_CAPTURE_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      workletRef.current = worklet;
      worklet.port.onmessage = (event) => {
        pcmChunksRef.current.push(new Float32Array(event.data));
        pcmSampleCountRef.current += event.data.byteLength / Float32Array.BYTES_PER_ELEMENT;
      };
      // 워클릿 출력은 쓰지 않지만(오디오를 스피커로 재생할 필요 없음), 브라우저에 따라
      // destination까지 이어진 그래프의 일부가 아니면 process()가 아예 호출되지 않을 수
      // 있습니다 — realtimeAudioStream.js가 silentGain을 두는 것과 같은 이유입니다.
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      silentGainRef.current = silentGain;
      source.connect(worklet);
      worklet.connect(silentGain);
      silentGain.connect(audioContext.destination);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[in-person-audio] startRecording failed', error);
      cleanupMedia();
      setStatus('error');
      setErrorMessage(error.message || '녹음 서버에 연결할 수 없습니다.');
    }
  };

  const stopRecording = () => {
    if (stoppingRef.current || !wsRef.current) return;
    stoppingRef.current = true;
    setStatus('processing');
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushChunk(true);
  };

  return { status, segments, interimText, errorMessage, startRecording, stopRecording };
}
