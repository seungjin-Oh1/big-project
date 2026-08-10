import React, { useEffect, useRef, useState } from 'react';
import { Mic, Check, EyeOff, Headphones, Radio } from 'lucide-react';
import { RealtimeMemoCard } from './RealtimeAnalysisPanel.jsx';
import { correctClientName } from '../shared/nameCorrection.js';
import { CollapsibleSection } from '../../../components/common.jsx';

// RealtimeCallControl과 같은 위치·패턴이지만 통화 대신 녹음을 시작/종료합니다.
// 통화 경과 시간 카운트 같은 통화 전용 로직은 옮기지 않고, 녹음 상태(status)는 useInPersonRecording에서
// 온 값을 그대로 씁니다.
export function InPersonRecordingControl({ hasCase, status, onStart, onStop }) {
  const isActive = status === 'connecting' || status === 'recording';
  const sttChip = status === 'recording'
    ? { tone: 'tone-success', label: '녹음 중 · 개인정보 자동 마스킹' }
    : status === 'connecting'
      ? { tone: 'tone-info', label: '녹음 서버 연결 중' }
      : status === 'processing'
        ? { tone: 'tone-info', label: 'STT·마스킹 처리 중' }
        : status === 'done'
          ? { tone: 'tone-success', label: '녹음 완료' }
          : status === 'error'
            ? { tone: 'tone-warn', label: '녹음 오류' }
            : { tone: 'tone-muted', label: '녹음 대기 중' };
  return (
    <div className="realtimeStatusChips">
      {isActive ? (
        <button type="button" className="callControlButton end" onClick={onStop}>
          <Mic size={14} strokeWidth={2.4} /> 녹음 종료
        </button>
      ) : (
        <button type="button" className="callControlButton start" onClick={onStart} disabled={!hasCase || status === 'processing'}>
          <Mic size={14} strokeWidth={2.4} /> 녹음 시작
        </button>
      )}
      <span className={`statusChip ${sttChip.tone}`}><Mic size={13} strokeWidth={2.4} /> {sttChip.label}</span>
      <span className={`statusChip ${hasCase ? 'tone-info' : 'tone-muted'}`}><Check size={13} strokeWidth={2.4} /> 메모 · {hasCase ? '입력 가능' : '사건 선택 필요'}</span>
    </div>
  );
}

// 지금 붙어 있는 외부 오디오 게이트웨이(useInPersonRecording.js 참고)는 화자분리(speaker) 정보를
// 주지 않아 이 분기를 안 탑니다. 다만 요구사항이 "화자분리가 가능하면 화자별로, 아니면 그냥
// 텍스트대로"라서, segment에 speaker 필드가 실제로 실리는 날 코드 변경 없이 바로 화자별로
// 나뉘어 쌓이도록 미리 대응해 둡니다.
function buildTranscriptChunk(segments, field) {
  const hasSpeaker = segments.some((segment) => segment.speaker);
  return segments
    .map((segment) => {
      if (segment.error) return '[변환 실패]';
      const value = segment[field] || '';
      return hasSpeaker && segment.speaker ? `[${segment.speaker}] ${value}` : value;
    })
    .filter(Boolean)
    .join(hasSpeaker ? '\n' : ' ')
    .trim();
}

// "녹음 시작"을 다시 눌렀는데 이전 세션 텍스트가 실시간 상담 메모에 이미 쌓여 있으면, 그걸 그냥
// 이어붙이면 이전 상담 내용과 새 상담 내용이 뒤섞입니다. 그렇다고 묻지도 않고 지우면 실수로
// 다시 누른 경우 되돌릴 수 없이 날아갑니다 — 그래서 확인 팝업을 거칩니다.
function RestartRecordingConfirmModal({ onConfirm, onCancel }) {
  const confirmButtonRef = useRef(null);
  useEffect(() => {
    confirmButtonRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);
  return (
    <div className="modalBackdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="restart-recording-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modalHeader"><h2 id="restart-recording-title">녹음 재시작</h2></div>
        <p>녹음을 재시작하면 기존 녹음자료들이 사라집니다.</p>
        <div className="restartConfirmActions">
          <button className="restartConfirmButton" type="button" onClick={onCancel}>아니오</button>
          <button className="restartConfirmButton" type="button" ref={confirmButtonRef} onClick={onConfirm}>네</button>
        </div>
      </div>
    </div>
  );
}

// 외부 오디오 게이트웨이가 실제 마스킹한 결과를(useInPersonRecording.js가 /ws/audio/operator로
// 받아온 것) 원문/마스킹본 토글로 보여줍니다. AnalysisWorkbench의 "개인정보는 자동으로 가려집니다"
// 카드와 같은 UX입니다.
// 기본값을 마스킹본으로 두는 이유도 동일합니다 — 원문은 검증이 필요할 때만 확인합니다.
//
// 이름 교정(correctClientName)은 여기서 따로 하지 않습니다. 이 카드가 읽는
// selectedCase.inpersonMemo(Masked)가 이미 교정을 거친 값이라, 한 번 더 돌리면
// 같은 일을 두 곳에서 하게 됩니다.
// 요구사항: (1) 기본적으로 보이고 (2) 녹음 시작/중에는 원문 토글을 막아 마스킹 전 상태가 잘못
// 노출되지 않게 하고 (3) 녹음이 끝나면 다시 조작 가능해지고 (4) 그 시점에 아코디언이 자동으로
// 펼쳐져야 합니다. status가 'done'인지 아닌지로 key를 바꿔 CollapsibleSection을 다시 마운트시켜
// defaultOpen을 그때그때 새로 적용합니다(이 컴포넌트는 비제어형이라 이 방법이 가장 단순합니다).
//
// 표시 텍스트는 현재 세션의 segments가 아니라 selectedCase.inpersonMemo(Masked)를 받습니다 —
// 그 값은 (a) 녹음 중에는 세그먼트가 도착할 때마다 InPersonAnalysisPanel의 useEffect가 그대로
// 반영해 실시간성을 잃지 않고, (b) 새로고침·다른 상담으로 갔다 온 뒤에는 core-api가 돌려주는
// inperson_input_texts(_masked) 배열의 최신 스냅샷(consultationMemosFromRow/latestSnapshot)에서
// 복원되므로, "저장된 가장 최근 결과"가 항상 이 카드에 보입니다. segments는 이번 세션에서
// 변환 실패 구간이 있었는지(hasError) 표시하는 용도로만 남겨둡니다.
// 전화상담 메모에서도 같은 카드를 쓴다. 예전에는 대면 녹음에만 이 카드가 있었는데,
// 전화상담은 자동 STT가 없어 마스킹본이 늘 비어 있었기 때문이다. 이제는 상담원이
// 메모칸에 직접 적은 내용도 core-api가 가리므로(ConsultationService.maskedOrRedact),
// 한쪽에만 카드가 있으면 "여기는 가려지고 저기는 주민번호가 그대로 보인다"가 된다.
export function InPersonSttPreview({
  maskedText, rawText, hasError, status,
  title = '개인정보 마스크 결과',
  emptyText = '녹음 결과가 없습니다.',
}) {
  const [showMasked, setShowMasked] = useState(true);
  const isRecordingActive = status === 'connecting' || status === 'recording';
  const text = showMasked ? maskedText : rawText;
  return (
    <CollapsibleSection
      key={status === 'done' ? 'inperson-stt-open' : 'inperson-stt-collapsed'}
      icon={EyeOff}
      title={title}
      defaultOpen={status === 'done'}
    >
      <div className="resultCard sttReferenceCard">
        <div className="segmented compactSegmented">
          <button type="button" className={showMasked ? 'active' : ''} disabled={isRecordingActive} onClick={() => setShowMasked(true)}>개인정보 가림</button>
          <button type="button" className={!showMasked ? 'active' : ''} disabled={isRecordingActive} onClick={() => setShowMasked(false)}>원문</button>
        </div>
        {isRecordingActive ? (
          <p className="helperText">녹음이 끝나면 원문 확인 등 조작이 가능합니다.</p>
        ) : !showMasked ? (
          <p className="sensitiveSourceNotice">민감정보 포함 가능 · 검증 시에만 확인</p>
        ) : null}
        <p className="sttPreviewText">{text || emptyText}</p>
        {hasError ? <p className="helperText">일부 구간은 변환에 실패해 메모에서 제외되었습니다.</p> : null}
      </div>
    </CollapsibleSection>
  );
}

// RealtimeAnalysisPanel(전화상담)을 참고해 구조를 복제하되, 통화 시작/종료 대신 녹음 시작/종료를 씁니다.
//
// 전화상담과 결과가 섞여 보이지 않도록 memo/memoMasked가 아니라 별도 필드
// (inpersonMemo/inpersonMemoMasked)에 씁니다 — RealtimeMemoCard의 field prop으로 지정합니다.
//
// segment_result가 올 때마다(녹음 종료를 기다리지 않고) "실시간 상담 메모" 칸에 바로 반영합니다.
// 다만 전체를 통째로 다시 쓰면 그 사이 상담원이 직접 입력한 메모(같은 칸의 "메모 추가")를
// 덮어써 버리므로, 이미 반영한 segment 개수(flushedCountRef)를 추적해 "새로 도착한 조각만"
// 기존 값 뒤에 이어붙입니다.
//
// status/segments/startRecording/stopRecording은 useInPersonRecording을 여기서 직접 부르지 않고
// AnalysisWorkbench로부터 props로 받습니다 — "상담 저장" 버튼이 녹음 상태(상담 중/변환 중)에
// 따라 라벨을 바꿔야 해서, 그 버튼이 있는 AnalysisWorkbench가 이 훅을 대신 소유합니다.
export function InPersonAnalysisPanel({
  selectedCase, onUpdateConsultation,
  inPersonStatus: status, inPersonSegments: segments, inPersonInterimText: interimText,
  inPersonErrorMessage: errorMessage,
  onStartInPersonRecording, onStopInPersonRecording,
}) {
  const hasCase = Boolean(selectedCase);

  const [pendingRestartConfirm, setPendingRestartConfirm] = useState(false);
  const hasExistingMemo = Boolean((selectedCase?.inpersonMemo || '').trim() || (selectedCase?.inpersonMemoMasked || '').trim());
  const handleStartClick = () => {
    if (hasExistingMemo) {
      setPendingRestartConfirm(true);
      return;
    }
    onStartInPersonRecording();
  };
  const confirmRestart = () => {
    setPendingRestartConfirm(false);
    onUpdateConsultation(selectedCase.id, { inpersonMemo: '', inpersonMemoMasked: '' });
    onStartInPersonRecording();
  };

  const flushedCountRef = useRef(0);
  // 아직 확정되지 않은(interim) 문장을 realtimeMemoTextarea 끝에 "얹어둔" 부분 — 다음 갱신 때
  // 이 문자열만 정확히 걷어내고 다시 얹기 위해 정확한 문자열(공백 포함)을 기억해둡니다.
  const interimSuffixRef = useRef('');
  useEffect(() => {
    // 새 녹음 세션 시작(연결 중으로 전환) — 다음 세션의 segments/접미사는 처음부터 다시 세야 합니다.
    if (status === 'connecting') {
      flushedCountRef.current = 0;
      interimSuffixRef.current = '';
    }
  }, [status]);

  // 확정된 문장(segments)과 아직 확정 안 된 문장(interimText)을 같은 effect에서 함께 다룹니다.
  // 따로 나누면, 문장이 확정되는 순간(segments·interimText가 같은 이벤트로 동시에 바뀌는 순간)
  // 두 effect가 각자 selectedCase의 같은(아직 안 바뀐) 스냅샷을 읽어 접미사를 지우는 effect와
  // 새 문장을 잇는 effect가 서로 어긋나 접미사가 중복으로 남습니다.
  useEffect(() => {
    if (!hasCase) return;
    const clientName = selectedCase.name || '';

    let currentMemo = selectedCase.inpersonMemo || '';
    let currentMasked = selectedCase.inpersonMemoMasked || '';

    // 이전에 얹어뒀던 미확정 접미사를 먼저 걷어냅니다(지금부터 다시 계산). 그 사이 상담원이
    // 메모칸 끝부분을 직접 고쳐 더 이상 이 접미사로 끝나지 않는다면, 우리가 뭘 지웠는지 알 수
    // 없으니 손대지 않습니다 — 사람이 고친 것을 지우는 것보다는 접미사가 지저분하게 남는 쪽이 낫습니다.
    const prevSuffix = interimSuffixRef.current;
    if (prevSuffix && currentMemo.endsWith(prevSuffix)) {
      currentMemo = currentMemo.slice(0, currentMemo.length - prevSuffix.length);
    }

    if (segments.length > flushedCountRef.current) {
      const sorted = [...segments].sort((a, b) => a.idx - b.idx);
      const newSegments = sorted.slice(flushedCountRef.current);
      flushedCountRef.current = sorted.length;

      // 상담원이 이름칸에 적어둔 이름이 있으면, 받아쓰기가 잘못 들은 이름을 그 이름으로 되돌립니다.
      // 이 메모가 그대로 상담 저장 -> AI 분석 -> 서식 초안까지 흘러가기 때문에, 여기서 안 고치면
      // 청구인 이름이 틀린 채로 법률 문서가 만들어집니다.
      const newText = correctClientName(buildTranscriptChunk(newSegments, 'text'), clientName);
      const newMaskedText = correctClientName(buildTranscriptChunk(newSegments, 'maskedText'), clientName);
      if (newText) currentMemo = currentMemo ? `${currentMemo} ${newText}` : newText;
      if (newMaskedText) currentMasked = currentMasked ? `${currentMasked} ${newMaskedText}` : newMaskedText;
    }

    // 아직 확정되지 않은 문장은 이름 교정 없이 그대로 접미사로 얹습니다 — 문장이 계속 흔들리는
    // 중이라 매번 교정하면 깜빡이고, 어차피 확정되는 순간(위 분기) 다시 교정을 거칩니다.
    const nextSuffix = interimText ? (currentMemo ? ` ${interimText}` : interimText) : '';
    interimSuffixRef.current = nextSuffix;
    const nextMemo = currentMemo + nextSuffix;

    if (nextMemo === (selectedCase.inpersonMemo || '') && currentMasked === (selectedCase.inpersonMemoMasked || '')) return;
    onUpdateConsultation(selectedCase.id, { inpersonMemo: nextMemo, inpersonMemoMasked: currentMasked });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, interimText, hasCase]);

  // 실제 흐름은 "녹음 -> 받아쓰기에서 이름이 틀린 걸 발견 -> 이름칸을 고침" 순서입니다. 그래서
  // 새로 들어오는 조각만 고쳐서는 부족하고, 이름이 바뀐 시점에 이미 쌓여 있는 메모까지 같이
  // 고쳐야 저장되는 본문에서 틀린 이름이 사라집니다.
  //
  // 고칠 게 없으면 아무것도 안 하므로(아래 비교) 갱신이 반복되지 않습니다.
  //
  // 이름칸이 바로 옆(caseMeta)에 있어서 한 글자 칠 때마다 이 효과가 돕니다. 메모를 덮어쓰는
  // 일이라 '문', '문가'처럼 아직 다 안 친 상태로 반영되면 안 되므로, 타이핑이 멎은 뒤에만
  // 한 번 적용합니다.
  useEffect(() => {
    if (!hasCase) return undefined;
    const timer = setTimeout(() => {
      const clientName = selectedCase.name || '';
      const memo = selectedCase.inpersonMemo || '';
      const masked = selectedCase.inpersonMemoMasked || '';
      const nextMemo = correctClientName(memo, clientName);
      const nextMasked = correctClientName(masked, clientName);
      if (nextMemo === memo && nextMasked === masked) return;
      onUpdateConsultation(selectedCase.id, { inpersonMemo: nextMemo, inpersonMemoMasked: nextMasked });
    }, 800);
    return () => clearTimeout(timer);
    // 메모 내용은 의존성에서 뺍니다. 상담원이 메모를 직접 고칠 수 있게 되면서
    // (RealtimeMemoCard), 메모가 바뀔 때마다 이 교정이 돌면 일부러 적은 이름까지
    // 되돌려 버립니다 — 예를 들어 상대방 이름이 내담자와 소리가 비슷하면, 적는 족족
    // 내담자 이름으로 바뀝니다. 사람이 고친 것이 기계보다 우선입니다.
    // 이름칸이 바뀐 순간에만 한 번 훑습니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCase?.id, selectedCase?.name]);

  const headline = status === 'recording'
    ? '녹음 중입니다. 대면 상담 내용이 실시간으로 전송됩니다.'
    : status === 'processing'
      ? '녹음을 마쳤습니다. STT·마스킹 결과를 기다리는 중입니다.'
      : status === 'error'
        ? (errorMessage || '녹음 처리 중 오류가 발생했습니다.')
        : '대면 상담을 시작하려면 위 ‘녹음 시작’을 눌러 진행하세요.';

  return (
    <section className="realtimeWorkbenchPanel" aria-label="대면 상담 메모">
      <div className="realtimeWorkbenchHeader">
        <div className="realtimeHeaderTags">
          <span className="roleIdentityBadge roleIdentityBadge-counselor"><Headphones size={12} strokeWidth={2.4} aria-hidden="true" /> 상담원 업무</span>
          <span className="flowStageEyebrow"><Radio size={13} strokeWidth={2.4} aria-hidden="true" /> 실시간 상담</span>
        </div>
      </div>
      <div className="realtimeConsultationLayout">
        <div className="realtimeConsultationMain">
          <div className="realtimeSplitRow">
            <div className="realtimeSplitColumn">
              <strong>{headline}</strong>
              <p>마이크 녹음 중 개인정보가 가려진 대화 내용이 실시간으로 상담 메모에 반영됩니다.</p>
              <InPersonRecordingControl
                hasCase={hasCase}
                status={status}
                onStart={handleStartClick}
                onStop={onStopInPersonRecording}
              />
              {/* 개인정보 마스크 결과는 기본적으로 보이되, 녹음 중에는 토글이 비활성화되고
                  녹음이 끝나면 다시 조작 가능해지면서 아코디언이 자동으로 펼쳐집니다
                  (구체적인 활성/펼침 제어는 InPersonSttPreview 내부에서 status로 처리).
                  텍스트는 selectedCase에서 가져와 — 이 사건에 저장된 가장 최근 결과를 보여줍니다. */}
              {hasCase ? (
                <InPersonSttPreview
                  maskedText={selectedCase?.inpersonMemoMasked || ''}
                  rawText={selectedCase?.inpersonMemo || ''}
                  hasError={segments.some((segment) => segment.error)}
                  status={status}
                />
              ) : null}
            </div>
            <RealtimeMemoCard
              selectedCase={selectedCase}
              onUpdateConsultation={onUpdateConsultation}
              field="inpersonMemo"
              composerPlaceholder="대면 상담 내용을 바로 적어주세요."
            />
          </div>
        </div>
      </div>
      {pendingRestartConfirm ? (
        <RestartRecordingConfirmModal
          onConfirm={confirmRestart}
          onCancel={() => setPendingRestartConfirm(false)}
        />
      ) : null}
    </section>
  );
}
