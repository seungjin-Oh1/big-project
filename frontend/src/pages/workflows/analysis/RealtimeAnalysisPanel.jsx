import React, { useState } from 'react';
import { PhoneCall, Check, Mic, Clock, Info, Sparkles, MessageSquareText, Headphones, Radio } from 'lucide-react';
import { buildSuggestedQuestions, formatCallDuration } from '../shared/formatters.js';
import { CallLiveIndicator } from '../components/CallLiveIndicator.jsx';
import { CallAudioVisualizer } from '../components/CallAudioVisualizer.jsx';
import { CollapsibleSection } from '../../../components/common.jsx';

export function RealtimeCallControl({
  hasCase,
  callStatus,
  callSeconds,
  audioStatus,
  availableAudioCalls,
  selectedAudioCallId,
  isLoadingAudioCalls,
  onSelectAudioCall,
  onRefreshAudioCalls,
  onStartCall,
  onEndCall,
}) {
  const sttChip = callStatus === 'ongoing'
    ? audioStatus === 'streaming'
      ? { tone: 'tone-success', label: '통화 오디오 전송 중 · 메모로 기록' }
      : audioStatus === 'error'
        ? { tone: 'tone-warn', label: '오디오 연결 실패 · 메모로 기록' }
        // 연결할 통화를 고르지 않고 시작한 경우(화면 확인용 등)는 오디오 연결 자체를
        // 시도하지 않으므로, "연결 중"이 아니라 지금 상태를 있는 그대로 알려줍니다.
        : audioStatus === 'idle'
          ? { tone: 'tone-muted', label: '오디오 연결 없이 진행 중 · 메모로 기록' }
          : { tone: 'tone-info', label: '통화 오디오 연결 중 · 메모로 기록' }
    : audioStatus === 'error'
      ? { tone: 'tone-warn', label: '통화 연결 실패 · 목록을 새로고침해주세요' }
      : isLoadingAudioCalls
        ? { tone: 'tone-info', label: '진행 중인 통화 확인 중' }
        : availableAudioCalls.length
          ? { tone: 'tone-info', label: '연결할 통화를 선택해주세요' }
          : { tone: 'tone-muted', label: '연결 가능한 통화를 기다리는 중' };
  return (
    <div className="realtimeStatusChips">
      {callStatus === 'idle' ? (
          <>
            <div className="audioCallPicker">
              <label htmlFor="audio-call-picker">연결할 통화</label>
              <div className="audioCallPickerControls">
                <select
                  id="audio-call-picker"
                  value={selectedAudioCallId}
                  onChange={(event) => onSelectAudioCall(event.target.value)}
                  disabled={!hasCase || isLoadingAudioCalls}
                >
                  <option value="">{isLoadingAudioCalls ? '통화 목록을 불러오는 중...' : '대기 중인 통화 선택'}</option>
                  {availableAudioCalls.map((call) => (
                    <option key={call.callId} value={call.callId}>통화 ID · {call.callId}</option>
                  ))}
                </select>
                <button type="button" className="audioCallRefreshButton" onClick={() => onRefreshAudioCalls()} disabled={isLoadingAudioCalls}>
                  새로고침
                </button>
              </div>
            </div>
          <button type="button" className="callControlButton start" onClick={onStartCall} disabled={!hasCase || isLoadingAudioCalls || !availableAudioCalls.some((call) => call.callId === selectedAudioCallId)}>
            <PhoneCall size={14} strokeWidth={2.4} /> 통화 시작
          </button>
          </>
        ) : callStatus === 'ongoing' ? (
          <>
            <button type="button" className="callControlButton end" onClick={onEndCall}>
              <PhoneCall size={14} strokeWidth={2.4} /> 통화 종료
            </button>
            <CallLiveIndicator seconds={callSeconds} />
          </>
        ) : (
          <span className="statusChip tone-success"><Check size={13} strokeWidth={2.4} /> 통화 종료됨 · {formatCallDuration(callSeconds)}</span>
        )}
      <span className={`statusChip ${sttChip.tone}`}><Mic size={13} strokeWidth={2.4} /> {sttChip.label}</span>
      <span className={`statusChip ${hasCase ? 'tone-info' : 'tone-muted'}`}><Check size={13} strokeWidth={2.4} /> 메모 · {hasCase ? '입력 가능' : '사건 선택 필요'}</span>
    </div>
  );
}

// 통화 중 곧바로 타이핑할 수 있는 실제 입력창입니다. 여기 적은 내용이 selectedCase[field]로 저장되고,
// 아래 'AI 분석 결과'가 그대로 이 텍스트를 분석 대상으로 씁니다 — 즉 이 칸을 채우는 것이
// 실시간 분석을 정확하게 만드는 가장 중요한 행동입니다.
//
// field: 전화상담과 대면상담이 같은 상담(case)의 서로 다른 필드에 각자 기록해야 해서
// (전화상담과 대면상담 결과가 섞여 보이면 안 된다는 요구) 대상 필드를 파라미터로 받습니다.
// 기본값 'memo'는 전화상담(RealtimeAnalysisPanel) 쪽 기존 동작 그대로입니다.
export function RealtimeMemoCard({ selectedCase, onUpdateConsultation, field = 'memo', composerPlaceholder = '통화 내용을 바로 적어주세요.' }) {
  const hasCase = Boolean(selectedCase);
  const memo = selectedCase?.[field] || '';
  const charCount = memo.trim().length;
  const [pendingMemo, setPendingMemo] = useState('');
  const addMemo = () => {
    const nextLine = pendingMemo.trim();
    if (!hasCase || !nextLine) return;
    onUpdateConsultation(selectedCase.id, { [field]: memo ? `${memo}\n${nextLine}` : nextLine });
    setPendingMemo('');
  };
  return (
    <article className="realtimeTranscriptCard">
      <div className="realtimeTranscriptHead">
        <h3><MessageSquareText size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 실시간 상담 메모</h3>
        <span className={`statusChip ${charCount ? 'tone-info' : 'tone-muted'}`} role="status" aria-live="polite">
          {charCount ? <Check size={12} strokeWidth={2.4} aria-hidden="true" /> : <Clock size={12} strokeWidth={2.4} aria-hidden="true" />}
          {charCount ? `${charCount}자 기록됨` : '작성 전'}
        </span>
      </div>
      {/* 이 칸을 눌러 타이핑을 시도했다가 아무 반응이 없는 사람이 있었습니다(코치 피드백).
          예전에는 읽기 전용이라 안내 문구만 실제 동작에 맞췄는데, 이제 직접 고칠 수 있게 합니다.

          받아쓰기가 사람 말을 자주 뭉갭니다 — 실측에서 "사망했어요"가 "사랑했어요"로,
          "한부모가정"이 "한분 모과정"으로 들어왔습니다. 이 메모가 그대로 AI 분석과
          서식 초안까지 흘러가므로, 틀린 채로 두면 그 틀린 값으로 법률 문서가 만들어집니다.
          들은 사람이 그 자리에서 고치는 것이 가장 정확하고 빠릅니다. */}
      <textarea
        className="realtimeMemoTextarea"
        value={memo}
        disabled={!hasCase}
        onChange={(event) => onUpdateConsultation(selectedCase.id, { [field]: event.target.value })}
        placeholder={hasCase
          ? '여기에 직접 적거나, 받아쓰기가 잘못 들은 곳을 고칠 수 있습니다.'
          : '사건 선택 또는 새 상담 시작'}
      />
      <div className="realtimeMemoComposer">
        <input
          value={pendingMemo}
          disabled={!hasCase}
          onChange={(event) => setPendingMemo(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addMemo();
            }
          }}
          placeholder={composerPlaceholder}
        />
        <button type="button" className="callAnalyzeButton" onClick={addMemo} disabled={!hasCase || !pendingMemo.trim()}>메모 추가</button>
      </div>
      <p className="helperText">AI 분석 기준 메모 · 받아쓰기가 잘못 들은 곳은 위에서 직접 고쳐주세요</p>
    </article>
  );
}
export function RealtimeSuggestedQuestions({ memoText }) {
  const [askedQuestions, setAskedQuestions] = useState([]);
  const suggestions = buildSuggestedQuestions(memoText);

  const toggleAsked = (question) => {
    setAskedQuestions((current) => current.includes(question) ? current.filter((item) => item !== question) : [...current, question]);
  };

  // 통화 중 지금 당장 해야 하는 일은 메모 입력이고, 이 추천 질문은 참고용 보조 자료입니다.
  // 예전엔 항상 펼쳐진 채로 메모 카드와 같은 무게로 나란히 있어, 질문이 몇 개만 있어도
  // 화면이 한 번에 다 봐야 할 것처럼 빽빽해 보였습니다. 접어두고 제목만 보이게 해
  // 필요할 때 한 번 눌러 펼치는 참고 자료로 낮춥니다(내용·기능은 그대로, 클릭 한 번 거리).
  return (
    <CollapsibleSection
      className="realtimeQuestionsCard"
      icon={Sparkles}
      title="AI 추천 추가 질문"
      badge={<span className="statusChip tone-info"><Info size={12} strokeWidth={2.4} aria-hidden="true" />통화 중 참고용</span>}
    >
      <p className="helperText">메모 기반 질문 후보 · 상담원이 선택</p>
      <div className="realtimeQuestionList">
        {suggestions.map((question) => {
          const asked = askedQuestions.includes(question);
          return (
            <button
              type="button"
              key={question}
              className={asked ? 'realtimeQuestionItem asked' : 'realtimeQuestionItem'}
              onClick={() => toggleAsked(question)}
              aria-pressed={asked}
            >
              <span>{question}</span>
              <em>{asked ? <><Check size={12} strokeWidth={2.6} aria-hidden="true" />질문함</> : '질문하기'}</em>
            </button>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

export function RealtimeAnalysisPanel({ selectedCase, onUpdateConsultation, callStatus, callSeconds, audioStatus, availableAudioCalls, selectedAudioCallId, isLoadingAudioCalls, onSelectAudioCall, onRefreshAudioCalls, onStartCall, onEndCall, audioStreamRef }) {
  const hasCase = Boolean(selectedCase);
  const headline = callStatus === 'ongoing'
    ? '통화 중입니다. 들은 내용을 바로 적으면서 진행하세요.'
    : callStatus === 'ended'
      ? '통화를 마쳤습니다. 메모를 다듬은 뒤 분석을 시작하세요.'
      : '전화를 받으면 위 ‘통화 시작’을 눌러 진행하세요.';
  return (
    <section className="realtimeWorkbenchPanel roleAccent-counselor" aria-label="실시간 상담 메모">
      <div className="realtimeWorkbenchHeader">
        <div className="realtimeHeaderTags">
          <span className="roleIdentityBadge roleIdentityBadge-counselor"><Headphones size={12} strokeWidth={2.4} aria-hidden="true" /> 상담 진행</span>
          <span className="flowStageEyebrow"><Radio size={13} strokeWidth={2.4} aria-hidden="true" /> 실시간 상담</span>
        </div>
      </div>
      <div className="realtimeConsultationLayout">
        <div className="realtimeConsultationMain">
          {callStatus === 'ongoing' && audioStreamRef ? (
            <CallAudioVisualizer audioStreamRef={audioStreamRef} active={audioStatus === 'streaming'} />
          ) : null}
          <div className="realtimeSplitRow">
            <div className="realtimeSplitColumn">
              <strong>{headline}</strong>
              <p>통화 내용 자동 받아쓰기를 준비 중입니다. 현재는 메모를 기준으로 분석합니다.</p>
              <RealtimeCallControl
                hasCase={hasCase}
                callStatus={callStatus}
                callSeconds={callSeconds}
                audioStatus={audioStatus}
                availableAudioCalls={availableAudioCalls}
                selectedAudioCallId={selectedAudioCallId}
                isLoadingAudioCalls={isLoadingAudioCalls}
                onSelectAudioCall={onSelectAudioCall}
                onRefreshAudioCalls={onRefreshAudioCalls}
                onStartCall={onStartCall}
                onEndCall={onEndCall}
              />
              {hasCase ? <RealtimeSuggestedQuestions memoText={selectedCase?.memo || ''} /> : null}
            </div>
            {/* 여기에 '개인정보 가림 결과' 카드를 두었다가 뺐습니다. 분석 화면의
                '개인정보는 자동으로 가려집니다'와 같은 것을 두 번 보여주는 셈이라,
                상담원 화면에 같은 카드가 둘씩 떴습니다(사용자 확인, 2026-08-09).
                가림 결과는 분석 화면 한 곳에서만 봅니다. */}
            <RealtimeMemoCard selectedCase={selectedCase} onUpdateConsultation={onUpdateConsultation} />
          </div>
        </div>
      </div>
    </section>
  );
}
