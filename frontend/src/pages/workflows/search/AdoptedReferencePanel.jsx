import React, { useState } from 'react';
import { Gavel, MessagesSquare, Scale, Trash2 } from 'lucide-react';
import { WorkPageHeader, InlineEmptyNotice } from '../../../components/common.jsx';
import { caseOptions } from '../shared/caseHelpers.js';
import { referenceTypeMeta } from '../shared/referenceTypes.js';
import { CasePicker } from '../components/CasePicker.jsx';

// 종류별 아이콘. 라벨·날짜표기와 달리 아이콘은 lucide 컴포넌트라 shared 모듈에
// 두면 그 파일이 React에 묶입니다 — 화면 쪽에만 둡니다.
const REFERENCE_ICONS = {
  statute: Scale,
  precedent: Gavel,
  similar: MessagesSquare,
};

// 담아둔 법령·판례를 상담별로 확인하는 화면.
//
// '법령·판례' 화면은 검색을 하러 들어가는 곳이라, 담아둔 것을 확인하려면 검색
// 결과 옆에서 봐야 합니다. 확인만 하고 싶을 때 쓰는 자리를 따로 둡니다.
//
// 읽기 전용입니다. 담고 빼는 일은 검색 화면에서 하고 여기서는 확인만 합니다 —
// 같은 일을 두 화면에서 할 수 있게 하면 어느 쪽이 최신인지 헷갈립니다.

// 법령의 시행일·판례의 선고일 모두 '20260317' 형태로 옵니다.
function formatLegalDate(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 8) return value || '';
  return `${digits.slice(0, 4)}. ${Number(digits.slice(4, 6))}. ${Number(digits.slice(6, 8))}.`;
}

function ReferenceLine({ item, isOpen, onToggle, onRemove, removing }) {
  const meta = referenceTypeMeta(item.type);
  const Icon = REFERENCE_ICONS[item.type] || Scale;
  return (
    <li className="adoptedReferenceLine">
      <span className="adoptedReferenceTitle">
        <Icon size={13} strokeWidth={2.2} aria-hidden="true" />
        {item.title}
      </span>
      <span className="adoptedReferenceMeta">
        {item.source || ''}
        {/* 상담사례는 기준일이 비어 있는 경우가 많습니다 — 원본 Q&A에 날짜가
            없는 항목이 있어서입니다. 없으면 이 줄 자체를 그리지 않습니다. */}
        {item.date ? ` · ${meta.dateLabel} ${formatLegalDate(item.date)}` : ''}
        {/* AI 추천을 채택한 것인지 직접 찾은 것인지 남깁니다. 검토 근거를 나중에
            다시 볼 때, 사람이 찾아낸 것과 AI가 올려준 것은 무게가 다릅니다. */}
        {item.selected_by === 'llm' ? ' · AI 추천 채택' : ''}
      </span>
      <button
        className="adoptedReferenceRemove"
        type="button"
        onClick={onRemove}
        disabled={removing}
        aria-label={`${item.title} 담은 자료에서 삭제`}
      >
        <Trash2 size={14} strokeWidth={2.2} aria-hidden="true" />
        {removing ? '삭제 중…' : '삭제'}
      </button>
      {item.reason ? <span className="adoptedReferenceReason">{item.reason}</span> : null}
      {/* 원문은 접어 둡니다. 조문은 항이 여러 개고 판시사항도 길어서, 다 펼쳐두면
          몇 건을 담았는지 훑어볼 수가 없습니다. */}
      {item.content ? (
        <>
          <button className="referenceCardToggle" type="button" onClick={onToggle}>
            {isOpen ? '접기' : meta.bodyToggleLabel}
          </button>
          {isOpen ? <p className="adoptedReferenceBody">{item.content}</p> : null}
        </>
      ) : (
        // 원문을 저장하기 전에 담아둔 자료입니다. 다시 담으면 함께 저장됩니다.
        <span className="adoptedReferenceMeta">원문이 저장되지 않았습니다 · 다시 담으면 함께 저장됩니다</span>
      )}
    </li>
  );
}

export function AdoptedReferencePanel({ consultations = [], onAnalysisSaved }) {
  const [caseId, setCaseId] = useState(caseOptions(consultations)[0].id);
  const [openIds, setOpenIds] = useState([]);
  const [removingId, setRemovingId] = useState(null);
  const toggleOpen = (id) => setOpenIds((current) => (current.includes(id)
    ? current.filter((value) => value !== id)
    : [...current, id]));
  const selectedCase = consultations.find((item) => String(item.id) === String(caseId));

  const adopted = Array.isArray(selectedCase?.analysis?.recommendation?.adopted)
    ? selectedCase.analysis.recommendation.adopted
    : [];
  // type이 없는 예전 저장본은 법령으로 봅니다(자료가 법령뿐이던 시절에 담은 것).
  const statutes = adopted.filter((item) => !item.type || item.type === 'statute');
  const precedents = adopted.filter((item) => item.type === 'precedent');
  const similars = adopted.filter((item) => item.type === 'similar');

  const removeReference = async (item) => {
    if (!selectedCase || !onAnalysisSaved || removingId) return;
    const nextSelected = adopted.filter((entry) => entry.id !== item.id);
    setRemovingId(item.id);
    try {
      const result = await onAnalysisSaved(selectedCase, {
        ...selectedCase.analysis,
        recommendation: { ...(selectedCase.analysis?.recommendation || {}), adopted: nextSelected },
      });
      if (result?.ok) setOpenIds((current) => current.filter((id) => id !== item.id));
    } finally {
      setRemovingId(null);
    }
  };

  // 다른 상담에 담아둔 것이 있으면 알려줍니다. 이 상담이 비어 있을 때 "저장이
  // 안 됐나" 싶어 검색 화면으로 되돌아가는 일을 줄입니다.
  const otherSaved = consultations.filter((item) => (
    String(item.id) !== String(caseId)
    && Array.isArray(item.analysis?.recommendation?.adopted)
    && item.analysis.recommendation.adopted.length
  )).length;

  return (
    <main className="workspacePage">
      <section className="workflowPanel adoptedReferencePanel">
        <WorkPageHeader
          title="담은 자료"
          description="상담에 담아둔 법령·판례·상담사례를 확인하고 필요하지 않은 자료는 바로 삭제합니다."
        />
        <div className="inlineControls">
          <CasePicker
            consultations={consultations}
            value={caseId}
            onChange={setCaseId}
          />
        </div>
        {selectedCase ? (
          <div className="referenceCaseSummary">
            <span><small>사건 유형</small><strong>{selectedCase.analysis?.caseType || selectedCase.type || '미분류'}</strong></span>
            <span><small>법령</small><strong>{statutes.length}건</strong></span>
            <span><small>판례</small><strong>{precedents.length}건</strong></span>
            <span><small>상담사례</small><strong>{similars.length}건</strong></span>
          </div>
        ) : null}
        {/* 법령과 판례를 섞어 쌓으면 무엇이 몇 건인지 세어가며 봐야 합니다. 둘은
            쓰임이 달라서(법령=요건, 판례=실제 판단) 나눠 보는 편이 맞습니다.
            비어 있는 묶음은 아예 그리지 않습니다 — 빈 제목만 남으면 자리만 먹습니다. */}
        {adopted.length ? (
          <div className="adoptedReferenceGroups">
            {[
              { key: 'statute', items: statutes },
              { key: 'precedent', items: precedents },
              { key: 'similar', items: similars },
            ].filter((group) => group.items.length).map((group) => {
              const GroupIcon = REFERENCE_ICONS[group.key] || Scale;
              return (
              <section className="adoptedReferenceGroup" key={group.key}>
                <h3>
                  <GroupIcon size={15} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" />
                  {referenceTypeMeta(group.key).label} <span className="statusChip tone-muted">{group.items.length}건</span>
                </h3>
                <ul className="adoptedReferenceItems">
                  {group.items.map((item) => (
                    <ReferenceLine
                      key={item.id}
                      item={item}
                      isOpen={openIds.includes(item.id)}
                      onToggle={() => toggleOpen(item.id)}
                      onRemove={() => removeReference(item)}
                      removing={removingId === item.id}
                    />
                  ))}
                </ul>
              </section>
              );
            })}
          </div>
        ) : (
          <InlineEmptyNotice>
            이 상담에 담아둔 법령·판례가 없습니다 · &lsquo;법령·판례&rsquo; 화면에서 자료를 고르고
            &lsquo;이 상담에 저장&rsquo;을 누르면 여기에 나타납니다.
            {otherSaved ? ` (다른 상담 ${otherSaved}건에는 담아둔 자료가 있습니다)` : ''}
          </InlineEmptyNotice>
        )}
      </section>
    </main>
  );
}
