import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react';

// 통화 중 내 음성(마이크)·상대방 음성(재생)의 실시간 크기를 막대로 보여줍니다. RealtimeAudioStream이
// 내부 AnalyserNode로 매 프레임 계산해 둔 값을 requestAnimationFrame으로 읽어와 막대 너비만 DOM에
// 직접 반영합니다 — React state로 올리면 초당 수십 번 이 값이 바뀔 때마다 화면 전체가 리렌더링됩니다.
//
// 마이크/스피커 아이콘은 그냥 표시용이 아니라 눌러서 끄고 켤 수 있습니다 — 마이크를 끄면 실제로
// 상대방에게 내 음성이 전달되지 않고(RealtimeAudioStream.setMicMuted), 스피커를 끄면 상대방
// 음성 재생만 멈춥니다(setRemoteMuted). 두 상태 모두 이 컴포넌트 안에서만 관리하다가, 통화가
// 다시 연결될 때(active: false -> true) audioStreamRef.current에 재적용합니다.
//
// showRemote=false를 주면 "상대방 음성" 줄을 아예 그리지 않습니다(대면 녹음처럼 재생되는
// 상대방 오디오가 없는 경우) — audioStreamRef.current는 이때도 getLevels()가 { mic, remote }
// 모양을 돌려주기만 하면 되고 remote 값은 그냥 쓰이지 않습니다.
export function CallAudioVisualizer({ audioStreamRef, active, showRemote = true }) {
  const micBarRef = useRef(null);
  const remoteBarRef = useRef(null);
  const [micMuted, setMicMuted] = useState(false);
  const [remoteMuted, setRemoteMuted] = useState(false);

  useEffect(() => {
    if (!active) return;
    audioStreamRef.current?.setMicMuted?.(micMuted);
    audioStreamRef.current?.setRemoteMuted?.(remoteMuted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!active) return undefined;
    let frameId;
    const tick = () => {
      const levels = audioStreamRef.current?.getLevels?.() ?? { mic: 0, remote: 0 };
      // RMS 값은 보통 작아서(정상 발화도 0.1~0.3대) 3배 정도 키워야 막대가 체감상 자연스럽게 움직입니다.
      if (micBarRef.current) micBarRef.current.style.transform = `scaleX(${Math.min(1, levels.mic * 3)})`;
      if (remoteBarRef.current) remoteBarRef.current.style.transform = `scaleX(${Math.min(1, levels.remote * 3)})`;
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [active, audioStreamRef]);

  const toggleMic = () => {
    const next = !micMuted;
    setMicMuted(next);
    audioStreamRef.current?.setMicMuted?.(next);
  };
  const toggleRemote = () => {
    const next = !remoteMuted;
    setRemoteMuted(next);
    audioStreamRef.current?.setRemoteMuted?.(next);
  };

  return (
    <div className="callAudioVisualizer">
      <div className="callAudioVisualizerRow">
        <button
          type="button"
          className="callAudioVisualizerToggle"
          onClick={toggleMic}
          aria-pressed={micMuted}
          title={micMuted ? '마이크 음소거 해제' : '마이크 음소거'}
        >
          {micMuted ? <MicOff size={18} strokeWidth={2.4} /> : <Mic size={18} strokeWidth={2.4} />}
        </button>
        <span className="callAudioVisualizerLabel">내 음성</span>
        <span className="callAudioVisualizerTrack">
          <span ref={micBarRef} className="callAudioVisualizerFill mic" />
        </span>
      </div>
      {showRemote ? (
        <div className="callAudioVisualizerRow">
          <button
            type="button"
            className="callAudioVisualizerToggle"
            onClick={toggleRemote}
            aria-pressed={remoteMuted}
            title={remoteMuted ? '상대방 음성 음소거 해제' : '상대방 음성 음소거'}
          >
            {remoteMuted ? <VolumeX size={18} strokeWidth={2.4} /> : <Volume2 size={18} strokeWidth={2.4} />}
          </button>
          <span className="callAudioVisualizerLabel">상대방 음성</span>
          <span className="callAudioVisualizerTrack">
            <span ref={remoteBarRef} className="callAudioVisualizerFill remote" />
          </span>
        </div>
      ) : null}
    </div>
  );
}
