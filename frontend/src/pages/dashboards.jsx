import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { statusAll, today } from '../constants.jsx';
import { EmptyRows, StatusButton, SummaryCards, ConsultationTable, HitlConfirmModal, workflowStatusTone } from '../components/common.jsx';
import { useConfirm } from '../components/feedback.jsx';
import { UtilityPanel, ReliefReviewSummary, DOCUMENT_STATUS_LABEL, documentStatusTone, GeneratedFileLink, DraftContentReviewLabel } from './workflows.jsx';
import { appendAuditLog, getAuditLogs } from '../services/storage.js';
import { checkTemplateRevision, simulateBackendLatency } from '../services/legalAidApi.js';
import { checkAiApiHealth } from '../services/aiApiClient.js';
import { approveCoreAnalysis, approveCoreDocument, checkCoreApiStatus, fetchCoreAdminStats, fetchCoreAuditLogs, fetchCoreDocuments, requestCoreAnalysisRevision, requestCoreDocumentRevision, verifyCoreAuditLogChain } from '../services/coreApiClientV2.js';
import { readSubmittedLocalDocumentReviews, updateLocalDocumentReview, removeLocalDocumentReview, dismissDocumentReview, isDocumentReviewDismissed } from '../services/documentReviewStore.js';
import { hydrateDraftDocument } from '../services/draftDocumentStore.js';
import { caseCategories, getCaseCategory } from '../data/domain.js';
import { useAsyncAction } from '../components/loading.jsx';
import { statusChipClass } from '../utils/statusTone.js';

function CounselorDashboard({ consultations, setConsultations, onCreateConsultation, onRequestLegalReview, onAnalysisSaved, onDeleteConsultation, onOpenConsultationForm, onOpenAnalysis, onOpenDraft, onGoToDashboard, activeView, currentUser, onUpdateProfile, notifications, onReadNotifications, onDeleteNotification, onOpenNotification, onNotify, focusedConsultationId }) {
  const [filter, setFilter] = useState(statusAll);
  const [selectedDate, setSelectedDate] = useState(today);
  const filtered = filter === statusAll ? consultations : consultations.filter((item) => item.status === filter);
  const dateRows = filtered.filter((item) => item.date === selectedDate);
  const cards = [
    { title: '총 상담', value: `${consultations.length}건`, filter: statusAll },
    { title: '진행 중인 상담', value: `${consultations.filter((item) => item.status === '진행 중').length}건`, filter: '진행 중' },
    { title: '완료된 상담', value: `${consultations.filter((item) => item.status === '완료').length}건`, filter: '완료' },
    { title: '보류 상담', value: `${consultations.filter((item) => item.status === '보류').length}건`, filter: '보류' },
  ];
  const reworkRows = consultations.filter((item) => item.reviewAction && !item.reviewAction.resolved);

  if (activeView !== '대시보드') {
    return <UtilityPanel view={activeView} role="counselor" consultations={consultations} onCreateConsultation={onCreateConsultation} onRequestLegalReview={onRequestLegalReview} onAnalysisSaved={onAnalysisSaved} onUpdateConsultation={(id, updates) => setConsultations((items) => items.map((item) => item.id === id ? { ...item, ...updates } : item))} currentUser={currentUser} onUpdateProfile={onUpdateProfile} onGoToDashboard={onGoToDashboard} notifications={notifications} onReadNotifications={onReadNotifications} onDeleteNotification={onDeleteNotification} onOpenNotification={onOpenNotification} onNotify={onNotify} focusedConsultationId={focusedConsultationId} onOpenConsultationForm={onOpenConsultationForm} onOpenAnalysis={onOpenAnalysis} />;
  }
  return (
    <main className="dashboard dashboard-counselor">
      <section className="dashboardLeft">
        <SummaryCards cards={cards} activeFilter={filter} onFilter={setFilter} />
        <ConsultationTable title={filter === statusAll ? '최근 상담 목록' : `${filter} 상담 목록`} rows={filtered} onAdd={onOpenConsultationForm} onDelete={onDeleteConsultation} onOpenAnalysis={onOpenAnalysis} searchable />
      </section>
      <section className="dashboardRight">
        <div className="counselorTopSlot">
          <CounselorReworkPanel rows={reworkRows} onOpenAnalysis={onOpenAnalysis} onOpenDraft={onOpenDraft} />
        </div>
        <ConsultationTable title="일정별 상담 목록" rows={dateRows} onDelete={onDeleteConsultation} onOpenAnalysis={onOpenAnalysis} tall selectedDate={selectedDate} onDateChange={setSelectedDate} />
      </section>
    </main>
  );
}

function CounselorReworkPanel({ rows, onOpenAnalysis, onOpenDraft }) {
  const openRework = (row) => {
    if (row.reviewAction?.workbench === '서식 생성') {
      onOpenDraft?.(row.id);
      return;
    }
    onOpenAnalysis?.(row.id);
  };

  return (
    <section className="panel reworkPanel">
      <div className="panelTitleRow"><h2>보완 요청 상담</h2></div>
      {rows.length ? (
        <div className="reworkList">
          {rows.map((row) => (
            <article className="reworkItem" key={row.id}>
              <div>
                <strong>{row.caseNo} {row.title}</strong>
                <p><span>{row.reviewAction.status}</span>{row.reviewAction.reason || '사유가 입력되지 않았습니다.'}</p>
                {row.reviewAction.formName ? <p className="missingEvidenceLine">보완 서식: {row.reviewAction.formName}</p> : null}
                {row.eligibilityCheck?.isTargetCandidate && !row.eligibilityCheck?.evidenceSubmitted ? (
                  <p className="missingEvidenceLine">미제출 증빙: {row.eligibilityCheck.requiredEvidence}</p>
                ) : null}
              </div>
              <button className="tableAction reviewActionButton" type="button" onClick={() => openRework(row)}>
                {row.reviewAction?.workbench === '서식 생성' ? '서식 보완' : '수정 진행'}
              </button>
            </article>
          ))}
        </div>
      ) : (
        <p className="reworkEmptyNotice">변호사 검토 후 다시 처리할 상담이 없습니다.</p>
      )}
    </section>
  );
}

function sameLawyerCase(left = {}, right = {}) {
  if (left.id && right.id) return String(left.id) === String(right.id);
  if (left.coreId && right.coreId) return String(left.coreId) === String(right.coreId);
  if (left.caseNo && right.caseNo) return String(left.caseNo) === String(right.caseNo);
  return false;
}

function mergeLawyerReviewCase(review = {}, consultations = []) {
  const matchedConsultation = consultations.find((item) => sameLawyerCase(item, review));
  if (!matchedConsultation) {
    return {
      id: review.id,
      caseNo: review.caseNo,
      title: review.title,
      type: review.type,
      status: review.status,
      name: review.name,
      date: review.date,
      registeredTime: review.registeredTime,
      memo: review.memo || `${review.title || ''} 검토 요청`,
      attachments: review.attachments || [],
      analysis: review.analysis || null,
      counselor: review.counselor || null,
      coreId: review.coreId || '',
      coreAnalysisId: review.coreAnalysisId || '',
      workflowStatus: review.workflowStatus || '',
      reviewAction: review.reviewAction || null,
      recipientEmail: review.recipientEmail || '',
      lawyer: review.lawyer || null,
      logs: review.logs || [],
    };
  }

  return {
    ...matchedConsultation,
    status: review.status || matchedConsultation.status,
    reason: review.reason || matchedConsultation.reason || '',
    recipientEmail: review.recipientEmail || matchedConsultation.recipientEmail || '',
    lawyer: review.lawyer || matchedConsultation.lawyer || null,
  };
}

function buildLawyerDocumentCases(reviews = [], consultations = []) {
  const mergedReviewCases = reviews.map((review) => mergeLawyerReviewCase(review, consultations));
  const remainingConsultations = consultations.filter((item) => (
    item.coreId && !mergedReviewCases.some((reviewCase) => sameLawyerCase(reviewCase, item))
  ));
  return [...mergedReviewCases, ...remainingConsultations];
}

function LawyerDashboard({ reviews, setReviews, consultations = [], onReviewDecision, onDocumentReviewDecision, onGoToDashboard, activeView, currentUser, onUpdateProfile, notifications, onReadNotifications, onDeleteNotification, onOpenNotification, onNotify, focusedReviewCaseNo }) {
  const [filter, setFilter] = useState(statusAll);
  const [logs, setLogs] = useState([]);
  const [activeReview, setActiveReview] = useState(null);
  const filtered = filter === statusAll ? reviews : reviews.filter((item) => item.status === filter);

  // 변호사가 볼 수 있는 사건 후보 전체(coreId 있는 것만). '변호사 검토 요청'(분석 검토, reviews)을
  // 거친 사건뿐 아니라, 상담원이 분석 검토는 안 거치고 서식 초안만 먼저 제출한 사건도 여기 포함해야
  // DocumentReviewQueuePanel과 서식 생성 화면(CasePicker)에서 그 사건을 놓치지 않습니다.
  // (submitCoreDocumentForReview는 requestLegalReview와 무관하게 호출할 수 있어서, reviews에만
  // 의존하면 "분석 검토 요청 없이 서식만 보낸 사건"이 변호사 쪽에서 통째로 안 보이는 문제가 있었습니다)
  const documentReviewCases = buildLawyerDocumentCases(reviews, consultations);
  useEffect(() => {
    if (!focusedReviewCaseNo) return;
    const target = documentReviewCases.find((item) => item.caseNo === focusedReviewCaseNo);
    if (target) {
      setFilter(statusAll);
      setActiveReview(target);
    }
  }, [activeView, documentReviewCases, focusedReviewCaseNo]);
  const cards = [
    { title: '구조 검토 대기', value: `${reviews.filter((item) => item.status === '검토 대기').length}건`, filter: '검토 대기' },
    { title: '구조 검토 중', value: `${reviews.filter((item) => item.status === '검토 중').length}건`, filter: '검토 중' },
    { title: '구조 승인 완료', value: `${reviews.filter((item) => item.status === '승인').length}건`, filter: '승인' },
    { title: '구조 반려 처리', value: `${reviews.filter((item) => item.status === '반려').length}건`, filter: '반려' },
  ];
  // HITL 최종 결정: 결정(status)과 사유(reason)를 함께 기록하고 감사 로그로 남깁니다.
  // 예전엔 이 결정이 로컬 상태(reviews)에만 반영되고 core-api의 실제 검토 상태
  // (AnalysisReviewStatus)는 전혀 바뀌지 않았습니다 — 변호사가 승인을 눌러도 서버 기준으로는
  // 여전히 SUBMITTED_FOR_REVIEW로 남아있던 문제입니다. 사건이 core-api에 동기화돼 있으면
  // (coreId+coreAnalysisId) 함께 반영합니다. '승인'만 APPROVED로 보내고, 나머지(수정 요청/
  // 추가자료 요청/반려/보류)는 모두 REVISION_REQUESTED로 보냅니다 — 백엔드 AnalysisReviewStatus엔
  // 그 네 가지를 구분하는 별도 상태가 없고(api.md 기준 APPROVED/REVISION_REQUESTED 둘 뿐),
  // 구체적인 사유는 note로 함께 전달됩니다. 아직 core-api에 동기화 안 된 사건(로컬 프로토타입
  // 진행 중)에서는 이 호출만 조용히 건너뛰고 로컬 처리만 그대로 진행합니다.
  const decideReview = async (id, status, reason, recipientEmail) => {
    const target = reviews.find((item) => item.id === id);
    const reviewerInfo = {
      name: currentUser?.name || '변호사',
      email: currentUser?.email || '',
      organization: currentUser?.organization || '',
    };
    const recipient = recipientEmail || target?.counselor?.email || '';
    if (target?.coreId && target?.coreAnalysisId) {
      try {
        if (status === '승인') {
          await approveCoreAnalysis(target.coreId, target.coreAnalysisId, reason || '', currentUser?.token);
        } else {
          await requestCoreAnalysisRevision(target.coreId, target.coreAnalysisId, reason || '', currentUser?.token);
        }
      } catch (error) {
        console.warn('[법률구조 검토 결정] core-api 동기화 실패, 로컬 처리만 반영합니다:', error.message);
      }
    }
    setReviews((items) => items.map((item) => item.id === id ? { ...item, status, reason: reason || '', lawyer: reviewerInfo, recipientEmail: recipient } : item));
    onReviewDecision?.({
      id,
      status,
      reason,
      reviewer: reviewerInfo,
      recipientEmail: recipient,
    });
    if (target) setLogs((items) => [{ ...target, status, reason: reason || '', loggedAt: today }, ...items]);
    appendAuditLog({
      actor: currentUser?.email || '변호사',
      action: `법률구조 검토 결정: ${status}`,
      target: target?.caseNo || String(id),
      metadata: {
        reason: reason || '',
        lawyer: reviewerInfo.name,
        title: target?.title || '',
        caseType: target?.type || '',
      },
    });
    if (target && onNotify) {
      onNotify({
        roles: 'counselor',
        title: `검토 결과: ${status}`,
        message: `${target.caseNo} ${target.title}${reason ? ` / ${reason}` : ''}`,
        target: target.caseNo,
        recipientEmail: recipient,
        view: '기타',
      });
    }
    setActiveReview(null);
  };

  if (activeView !== '대시보드' && activeView !== '서식 생성') {
    // 분석 검토 요청(reviews)을 거친 사건뿐 아니라, 서식만 먼저 제출된 사건까지 합쳐둔
    // documentReviewCases를 그대로 넘깁니다. 여기서 빠뜨리면 변호사 쪽 법률·판례 화면에서
    // 그 사건 자체를 CasePicker에서 고를 수 없게 됩니다.
    return <UtilityPanel view={activeView} role="lawyer" currentUser={currentUser} onUpdateProfile={onUpdateProfile} consultations={documentReviewCases} onUpdateConsultation={() => {}} onCreateConsultation={() => {}} onGoToDashboard={onGoToDashboard} notifications={notifications} onReadNotifications={onReadNotifications} onDeleteNotification={onDeleteNotification} onOpenNotification={onOpenNotification} onNotify={onNotify} onDocumentReviewDecision={onDocumentReviewDecision} />;
  }
  return (
    <main className="dashboard dashboard-lawyer">
      <section className="dashboardLeft">
        <SummaryCards cards={cards} activeFilter={filter} onFilter={setFilter} />
        <ReviewTable
          title={filter === statusAll ? '법률구조 검토 요청' : `${filter} 요청 목록`}
          rows={filtered}
          onOpenReview={setActiveReview}
          onDelete={(id) => setReviews((items) => items.filter((item) => item.id !== id))}
        />
      </section>
      <section className="dashboardRight">
        <div className="lawyerTopSlot">
          <DocumentReviewQueuePanel candidateCases={documentReviewCases} currentUser={currentUser} onNotify={onNotify} onDocumentReviewDecision={onDocumentReviewDecision} />
        </div>
        <ReviewLog logs={logs} onDelete={(row) => setLogs((items) => items.filter((item) => !(item.id === row.id && item.status === row.status && item.loggedAt === row.loggedAt)))} />
      </section>
      {activeReview ? (
        <HitlDecisionModal
          review={activeReview}
          reviewer={currentUser?.name || '변호사'}
          onDecide={decideReview}
          onClose={() => setActiveReview(null)}
        />
      ) : null}
    </main>
  );
}

// 변호사가 상담원이 보낸 서식 초안을 사건별로 하나씩 열어봐야만 검토할 수 있던 문제를 없앱니다.
// (DraftWorkbench의 서식 검토 패널은 사건 하나를 고른 뒤에만 보입니다 — 대시보드에서는
// 어떤 사건에 검토할 서식이 와 있는지조차 알 수 없었습니다.)
// candidateCases: coreId가 있는 사건 후보 전체입니다(변호사 검토 요청을 거친 사건 + core-api에
// 저장된 상담 중 아직 분석 검토는 안 갔지만 서식만 먼저 검토 요청됐을 수 있는 사건 모두 포함 —
// LawyerDashboard에서 조립해 넘깁니다). 여기서는 그중 실제로 SUBMITTED_FOR_REVIEW 상태인
// 서식만 core-api에서 확인해 추려 보여주고, 그 자리에서 바로 승인/반려할 수 있게 합니다.
function DocumentReviewQueuePanel({ candidateCases, currentUser, onNotify, onDocumentReviewDecision }) {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [previewingKey, setPreviewingKey] = useState(null);
  const [reviewingKey, setReviewingKey] = useState(null);
  const [reviewAction, setReviewAction] = useState('approve');
  const [noteText, setNoteText] = useState('');
  const [materialsText, setMaterialsText] = useState('');
  const [pending, setPending] = useState(false);

  // candidateCases 배열 자체는 매 렌더마다 새 객체지만, 실제로 훑어야 할 사건(coreId) 목록이
  // 바뀌지 않으면 다시 불러올 필요가 없어서, coreId만 뽑아 문자열로 비교합니다.
  const caseKey = candidateCases.filter((item) => item.coreId).map((item) => item.coreId).join(',');
  const reviewDocumentKey = (doc) => doc.local_key || `${doc.coreId || 'local'}::${doc.document_id}`;

  // 사건의 AI 분석 긴급도를 문서 카드에도 같이 보여주기 위한 조회용 인덱스입니다.
  // (서식 검토는 '문서' 단위지만, 지금 무엇부터 볼지 우선순위를 정하는 기준은 '사건'의 긴급도이므로
  // caseNo로 찾아 붙입니다)
  const urgencyByCaseNo = new Map(candidateCases.map((item) => [item.caseNo, item.analysis?.urgency || '']));

  // 삭제 버튼으로 치운 항목은 다시 불러올 때도 계속 걸러내야 하므로, 목록을 세팅하기 직전에
  // 항상 이 필터를 거칩니다 (숨김 목록 자체는 documentReviewStore가 로컬에 보관).
  const filterDismissed = (list) => list.filter((doc) => !isDocumentReviewDismissed(reviewDocumentKey(doc)));

  const reload = () => {
    const cases = candidateCases.filter((item) => item.coreId);
    const localDocuments = readSubmittedLocalDocumentReviews().map((doc) => ({ ...doc, urgency: urgencyByCaseNo.get(doc.caseNo) || '' }));
    if (!cases.length) {
      setDocuments(filterDismissed(localDocuments));
      return;
    }
    setLoading(true);
    Promise.allSettled(cases.map((item) => fetchCoreDocuments(item.coreId)))
      .then((results) => {
        const merged = [...localDocuments];
        results.forEach((result, index) => {
          if (result.status !== 'fulfilled' || !Array.isArray(result.value)) return;
          const caseInfo = cases[index];
          result.value
            .filter((doc) => doc.status === 'SUBMITTED_FOR_REVIEW')
            .forEach((doc) => merged.push(hydrateDraftDocument({
              ...doc,
              caseNo: caseInfo.caseNo,
              title: caseInfo.title,
              coreId: caseInfo.coreId,
              counselor: caseInfo.counselor,
              urgency: caseInfo.analysis?.urgency || '',
            }, {
              consultationId: caseInfo.coreId,
              caseNo: caseInfo.caseNo,
            })));
        });
        setDocuments(filterDismissed(merged));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseKey]);

  const startReview = (doc, action) => {
    const key = reviewDocumentKey(doc);
    setReviewingKey(key);
    setPreviewingKey(key);
    setReviewAction(action);
    setNoteText('');
    setMaterialsText('');
  };
  const togglePreview = (doc) => {
    const key = reviewDocumentKey(doc);
    setPreviewingKey((current) => current === key ? null : key);
  };
  const cancelReview = () => setReviewingKey(null);

  // 로컬 큐 항목은 실제로 지우고, 코어 API 항목은 삭제 API가 없어 이 화면에서만 숨깁니다.
  const deleteDocument = (doc) => {
    const key = reviewDocumentKey(doc);
    if (!window.confirm(`'${doc.title || doc.caseNo}'의 서식 초안 검토 요청을 목록에서 삭제할까요?`)) return;
    if (doc.source === 'ai-api-local' || doc.source === 'text-local' || doc.source === 'client-hwpx') {
      removeLocalDocumentReview(doc.local_key || doc.document_id);
    }
    dismissDocumentReview(key);
    if (previewingKey === key) setPreviewingKey(null);
    if (reviewingKey === key) setReviewingKey(null);
    reload();
  };

  const confirmReview = async (doc) => {
    if (reviewAction === 'revision' && !noteText.trim()) return;
    setPending(true);
    try {
      const requestedMaterials = materialsText.split(',').map((item) => item.trim()).filter(Boolean);
      const reviewerInfo = {
        name: currentUser?.name || '변호사',
        email: currentUser?.email || '',
        organization: currentUser?.organization || '',
      };
      if (doc.source === 'ai-api-local' || doc.source === 'text-local' || doc.source === 'client-hwpx') {
        updateLocalDocumentReview(doc.local_key || doc.document_id, {
          status: reviewAction === 'approve' ? 'APPROVED' : 'REVISION_REQUESTED',
          review_note: noteText || '',
          requested_materials: reviewAction === 'revision' ? requestedMaterials : [],
        });
      } else {
        const token = currentUser?.token;
        if (reviewAction === 'approve') {
          await approveCoreDocument(doc.coreId, doc.document_id, noteText, token);
        } else {
          await requestCoreDocumentRevision(doc.coreId, doc.document_id, noteText, requestedMaterials, token);
        }
      }
      onDocumentReviewDecision?.({
        caseNo: doc.caseNo,
        action: reviewAction === 'approve' ? 'approve' : 'revision',
        reason: noteText || '',
        reviewer: reviewerInfo,
        recipientEmail: doc.counselor?.email || '',
        formName: doc.requested_form_name || doc.form_name || '',
        requestedMaterials: reviewAction === 'revision' ? requestedMaterials : [],
      });
      if (onNotify) {
        onNotify({
          roles: 'counselor',
          title: reviewAction === 'approve' ? '서식 초안 승인' : '서식 보완 요청',
          message: `${doc.caseNo} · ${doc.form_name}${noteText ? ` / ${noteText}` : ''}`,
          target: doc.caseNo,
          recipientEmail: doc.counselor?.email || '',
          view: '서식 생성',
        });
      }
      appendAuditLog({
        actor: currentUser?.email || '변호사',
        action: reviewAction === 'approve' ? '서식 초안 승인' : '서식 초안 반려',
        target: doc.caseNo,
        metadata: { formName: doc.form_name, note: noteText || '' },
      });
      setReviewingKey(null);
      reload();
    } finally {
      setPending(false);
    }
  };

  const columnCount = 7;
  // 이 패널은 이미 .lawyerTopSlot .documentReviewQueuePanel(max-height 360px) +
  // .documentReviewList(flex:1, overflow-y:auto)로 칸이 고정되고 넘치면 스크롤되도록
  // 되어 있어서, 다른 표처럼 별도 tableScroll을 씌우지 않아도 같은 동작을 합니다.

  return (
    <section className="panel documentReviewQueuePanel">
      <div className="panelTitleRow">
        <h2>서식 초안 검토 대기</h2>
        {loading ? <span className="helperText">불러오는 중…</span> : null}
      </div>
      {documents.length ? (
        <div className="documentReviewList">
          <table className="dataTable reviewRequestTable documentReviewTable">
            <colgroup>
              <col style={{ width: '17%' }} />
              <col style={{ width: '24%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '9%' }} />
            </colgroup>
            <thead><tr><th>상담 번호</th><th>서식 정보</th><th>담당 상담원</th><th>긴급도</th><th>요청 경과</th><th>검토</th><th>삭제</th></tr></thead>
            <tbody>
              {documents.map((doc) => {
                const key = reviewDocumentKey(doc);
                const isExpanded = previewingKey === key;
                const isReviewing = reviewingKey === key;
                const reviewTitle = doc.requested_form_name || doc.form_name;
                const submittedAt = doc.created_at || doc.submitted_at || '';
                const waitingDays = daysWaitingFrom(submittedAt);
                const revisionCount = doc.revision_count || doc.revisionCount || 0;
                return (
                  <React.Fragment key={key}>
                    <tr className={doc.urgency === '상' ? 'reviewRowUrgent' : undefined}>
                      <td>
                        <div className="cellBody"><strong>{doc.caseNo}</strong></div>
                      </td>
                      <td>
                        <div className="cellBody reviewCaseCell">
                          <strong title={doc.title}>{doc.title}</strong>
                          <span className="reviewCaseType">{reviewTitle}</span>
                        </div>
                      </td>
                      <td>
                        <div className="cellBody">
                          <span>{doc.counselor?.name || '미지정'}</span>
                          {doc.counselor?.email ? <span className="reviewCaseType" title={doc.counselor.email}>{doc.counselor.email}</span> : null}
                        </div>
                      </td>
                      <td>
                        <div className="cellBody">
                          {doc.urgency ? <span className={`statusChip tone-${urgencyTone(doc.urgency)}`}>{doc.urgency}</span> : <span className="reviewCaseType">미확인</span>}
                        </div>
                      </td>
                      <td>
                        <div className="cellBody">
                          <span className={`statusChip tone-${daysWaitingTone(waitingDays)}`} title={submittedAt ? `제출일: ${formatSubmittedDate(submittedAt)}` : '제출일'}>{daysWaitingLabel(waitingDays)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="cellBody">
                          <button className="tableAction reviewActionButton" type="button" onClick={() => togglePreview(doc)}>{isExpanded ? '접기' : '검토하기'}</button>
                        </div>
                      </td>
                      <td>
                        <div className="cellBody">
                          <button className="tableAction danger" type="button" onClick={() => deleteDocument(doc)} aria-label="검토 대기 목록에서 삭제">삭제</button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="documentReviewExpandedRow">
                        <td colSpan={columnCount}>
                          <div className="documentReviewExpandedBody">
                            <div className="documentReviewMetaRow">
                              <span className={`statusChip tone-${documentStatusTone(doc.status)}`}>{DOCUMENT_STATUS_LABEL[doc.status] || doc.status}</span>
                              {revisionCount > 0 ? <span className="statusChip tone-warn">{revisionCount}차 재제출</span> : null}
                            </div>
                            <GeneratedFileLink
                              path={doc.draft_file_path}
                              label={reviewTitle ? `${reviewTitle} 초안 파일` : undefined}
                              consultationId={doc.source ? undefined : doc.coreId}
                              documentId={doc.source ? undefined : doc.document_id}
                              content={doc.draft_content}
                              downloadFileName={doc.download_file_name}
                            />
                            <DraftContentReviewLabel content={doc.draft_content} />
                            <div className="documentReviewPreview">
                              <div className="documentReviewPreviewHeader"><strong>검토 내용</strong></div>
                              {doc.draft_content ? (
                                <pre>{doc.draft_content}</pre>
                              ) : doc.draft_file_path ? (
                                <p>HWPX 파일 경로를 기준으로 검토합니다. 파일 경로: {doc.draft_file_path}</p>
                              ) : (
                                <p>검토 가능한 본문 또는 파일 경로가 없습니다. 상담원에게 서식 초안 재생성을 요청하세요.</p>
                              )}
                            </div>
                            {isReviewing ? (
                              <div className="documentReviewForm">
                                <textarea
                                  value={noteText}
                                  onChange={(event) => setNoteText(event.target.value)}
                                  placeholder={reviewAction === 'approve' ? '승인 코멘트 (선택)' : '반려 사유 (필수)'}
                                />
                                {reviewAction === 'revision' ? (
                                  <input
                                    value={materialsText}
                                    onChange={(event) => setMaterialsText(event.target.value)}
                                    placeholder="상담원에게 요청할 자료 (쉼표로 구분, 선택)"
                                  />
                                ) : null}
                                <div className="inlineControls documentReviewActions">
                                  <button className="reviewCancelButton" type="button" onClick={cancelReview} disabled={pending}>취소</button>
                                  <button
                                    className={reviewAction === 'approve' ? 'reviewApproveButton' : 'reviewRejectButton'}
                                    type="button"
                                    onClick={() => confirmReview(doc)}
                                    disabled={pending || (reviewAction === 'revision' && !noteText.trim())}
                                  >
                                    {pending ? '처리하는 중…' : reviewAction === 'approve' ? '승인 확정' : '반려 확정'}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="inlineControls documentReviewActions">
                                <button className="reviewApproveButton" type="button" onClick={() => startReview(doc, 'approve')}>승인</button>
                                <button className="reviewRejectButton" type="button" onClick={() => startReview(doc, 'revision')}>반려</button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="templateEmpty">{loading ? '' : '검토 대기 중인 서식 초안이 없습니다.'}</p>
      )}
    </section>
  );
}

// 검토 상태도 상담 상태와 같은 색 기준(statusTone)을 그대로 씁니다. (색상 일관성)
const reviewStatusTone = statusChipClass;

// 요청일로부터 며칠이 지났는지 계산합니다. 법률구조 검토 요청 표와 서식 초안 검토 카드가 함께 쓰는
// 공용 헬퍼입니다 — 오래 밀린 건일수록 눈에 띄어야 변호사가 그 순서대로 처리할 수 있습니다.
function daysWaitingFrom(dateStr) {
  if (!dateStr) return null;
  const diffMs = new Date(today) - new Date(dateStr);
  if (Number.isNaN(diffMs)) return null;
  return Math.max(0, Math.round(diffMs / 86400000));
}

function daysWaitingTone(days) {
  if (days === null) return 'muted';
  if (days >= 5) return 'danger';
  if (days >= 2) return 'warn';
  return 'muted';
}

function daysWaitingLabel(days) {
  if (days === null) return '경과일 미기록';
  return days <= 0 ? '오늘 요청' : `${days}일 경과`;
}

// core-api/로컬 저장소가 주는 제출 시각은 '2026-07-28T01:17:29.340Z'처럼 초·밀리초·타임존까지
// 붙어 있어 표에 그대로 두면 시각적으로 지저분합니다. 표에는 날짜만 보여주고,
// 정확한 시각은 title 툴팁으로만 확인할 수 있게 합니다.
function formatSubmittedDate(value) {
  if (!value) return '-';
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : value;
}

// AI가 매긴 긴급도 등급을 칩 톤으로 바꿉니다. '상'은 즉시 대응이 필요하다는 신호라 danger로 가장 눈에
// 띄게 둡니다. 최종 판단은 변호사가 하는 것이므로 어디까지나 참고용 표시입니다.
function urgencyTone(level) {
  if (level === '상') return 'danger';
  if (level === '중') return 'warn';
  if (level === '하') return 'muted';
  return '';
}

function ReviewTable({ title = '법률구조 검토 요청', rows, onOpenReview, onDelete }) {
  const [query, setQuery] = useState('');
  const confirm = useConfirm();
  const normalizedQuery = query.trim().toLowerCase();
  const matchedRows = normalizedQuery
    ? rows.filter((row) => [row.caseNo, row.type, row.title, row.counselor?.name].some((value) => (value || '').toLowerCase().includes(normalizedQuery)))
    : rows;
  // 긴급도(상→중→하) 순으로 먼저 훑고, 같은 긴급도 안에서는 오래 기다린 요청부터 보이도록 정렬합니다.
  // 변호사가 화면을 열자마자 '지금 뭐부터 봐야 하는지' 바로 알 수 있게 하기 위함입니다.
  const urgencyRank = { 상: 0, 중: 1, 하: 2 };
  const displayRows = [...matchedRows].sort((left, right) => {
    const rankDiff = (urgencyRank[left.urgency] ?? 3) - (urgencyRank[right.urgency] ?? 3);
    if (rankDiff !== 0) return rankDiff;
    return (daysWaitingFrom(right.requestedAt) ?? 0) - (daysWaitingFrom(left.requestedAt) ?? 0);
  });
  const noSearchResult = Boolean(normalizedQuery) && !displayRows.length;
  const columnCount = onDelete ? 8 : 7;
  // '최근 상담 목록'과 같은 규칙: 6칸을 유지하고, 그보다 많으면 칸을 늘리지 않고 스크롤로 봅니다.
  const visibleRowCount = 6;
  const scrollable = displayRows.length > visibleRowCount;
  const handleDelete = async (row) => {
    if (!onDelete) return;
    const accepted = await confirm({
      title: '이 검토 요청을 삭제할까요?',
      message: `${row.caseNo} · 「${row.title || '제목 없음'}」\n검토 대기 목록에서 삭제하며 되돌릴 수 없습니다.`,
      confirmLabel: '삭제',
      tone: 'danger',
    });
    if (accepted) onDelete(row.id);
  };

  return (
    <section className="panel">
      <div className="panelTitleRow">
        <h2>{title}</h2>
        <div className="tableSearchBox">
          <Search size={14} strokeWidth={2.2} />
          <input type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름·사건번호·제목 검색" aria-label="상담번호·유형·제목·상담원으로 검토 요청 검색" />
        </div>
      </div>
      <div className={scrollable ? 'tableScroll' : ''}>
      <table className="dataTable reviewRequestTable">
        <colgroup>
          <col style={{ width: '16%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '11%' }} />
          <col style={{ width: '12%' }} />
          {onDelete ? <col style={{ width: '10%' }} /> : null}
        </colgroup>
        <thead><tr><th>상담 번호</th><th>사건 정보</th><th>담당 상담원</th><th>긴급도</th><th>요청 경과</th><th>상태</th><th>검토</th>{onDelete ? <th>삭제</th> : null}</tr></thead>
        <tbody>
          {noSearchResult ? (
            <tr><td className="tableEmptyNotice" colSpan={columnCount}>‘{query.trim()}’에 대한 검색 결과가 없습니다.</td></tr>
          ) : null}
          {displayRows.map((row) => {
            const waitingDays = daysWaitingFrom(row.requestedAt);
            return (
              <tr key={row.id} className={row.urgency === '상' ? 'reviewRowUrgent' : undefined}>
                <td>
                  <div className="cellBody"><strong>{row.caseNo}</strong></div>
                </td>
                <td>
                  <div className="cellBody reviewCaseCell">
                    <strong title={row.title}>{row.title}</strong>
                    <span className="reviewCaseType">{row.type || '유형 미분류'}</span>
                  </div>
                </td>
                <td>
                  <div className="cellBody">
                    <span>{row.counselor?.name || '미지정'}</span>
                    {row.counselor?.email ? <span className="reviewCaseType" title={row.counselor.email}>{row.counselor.email}</span> : null}
                  </div>
                </td>
                <td>
                  <div className="cellBody">
                    {row.urgency ? <span className={`statusChip tone-${urgencyTone(row.urgency)}`}>{row.urgency}</span> : <span className="reviewCaseType">미확인</span>}
                  </div>
                </td>
                <td>
                  <div className="cellBody">
                    <span className={`statusChip tone-${daysWaitingTone(waitingDays)}`} title={row.requestedAt ? `요청일: ${row.requestedAt}` : '요청일'}>{daysWaitingLabel(waitingDays)}</span>
                  </div>
                </td>
                <td>
                  <div className="cellBody">
                    <span className={reviewStatusTone(row.status)}>{row.status}</span>
                  </div>
                </td>
                {/* HITL: 결정을 바로 누르지 않고 검토 모달을 열어 AI 결과 확인 후 사유와 함께 확정합니다. */}
                <td>
                  <div className="cellBody">
                    <button className="tableAction reviewActionButton" type="button" onClick={() => onOpenReview(row)}>{row.status === '검토 대기' || row.status === '검토 중' ? '검토하기' : '재검토하기'}</button>
                  </div>
                </td>
                {onDelete ? (
                  <td>
                    <div className="cellBody">
                      <button className="tableAction danger" type="button" onClick={() => handleDelete(row)}>삭제</button>
                    </div>
                  </td>
                ) : null}
              </tr>
            );
          })}
          {noSearchResult || scrollable ? null : <EmptyRows count={Math.max(0, visibleRowCount - displayRows.length)} columns={columnCount} isEmpty={rows.length === 0} emptyLabel="검토 요청이 없습니다." />}
        </tbody>
      </table>
      </div>
    </section>
  );
}

// 법률구조 HITL(Human-in-the-loop) 최종 결정 모달.
// AI 분석은 참고용이고, 변호사/공익법무관이 법률 판단 항목을 확인한 뒤 결정과 사유를 확정합니다.
const hitlDecisions = [
  { key: '승인', label: '승인', hint: '법률구조 대상으로 확정하고 다음 단계로 진행', tone: 'success', needsReason: false },
  { key: '수정 요청', label: '수정 요청', hint: '상담원에게 서식·내용 수정을 요청 (사유 필수)', tone: 'warn', needsReason: true },
  { key: '추가자료 요청', label: '추가자료 요청', hint: '판단에 필요한 자료 보완을 요청 (사유 필수)', tone: 'warn', needsReason: true },
  { key: '반려', label: '반려', hint: '구조 대상 부적합으로 거절 (사유 필수)', tone: 'danger', needsReason: true },
  { key: '보류', label: '보류', hint: '추가 검토가 필요해 결정을 보류 (사유 필수)', tone: 'warn', needsReason: true },
];

function formatAnalysisList(items, emptyText) {
  return Array.isArray(items) && items.length ? items : [emptyText];
}

function fileExtractionLabel(status) {
  const labels = { success: '추출 성공', empty: '내용 없음', unsupported: '미지원', failed: '처리 실패' };
  return labels[status] || status || '상태 미확인';
}

function HitlDecisionModal({ review, reviewer, onDecide, onClose }) {
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [recipientEmail, setRecipientEmail] = useState(review.counselor?.email || '');
  const [checks, setChecks] = useState({ eligibility: false, evidence: false, hallucination: false });
  const [showFinalHitlConfirm, setShowFinalHitlConfirm] = useState(false);
  const selectedDecision = hitlDecisions.find((item) => item.key === decision);
  const analysis = review.analysis || {};
  const adoptedItems = formatAnalysisList(analysis.adoptedItems, '상담원이 채택한 검토 반영 항목 없음');
  const timelineItems = formatAnalysisList(analysis.timeline, { date: '-', text: '정리된 사실관계 타임라인 없음' });
  const extractedItems = formatAnalysisList(analysis.extractionDetail, { status: '', fileLink: '', note: '첨부파일 추출 정보 없음' });
  const attachmentItems = formatAnalysisList(analysis.sourceAttachments?.length ? analysis.sourceAttachments : analysis.extractedJson?.attachment_links, { fileName: '첨부 링크 정보 없음', fileKey: '', fileUrl: '' });
  const modalityItems = formatAnalysisList(analysis.modalities, { key: '입력자료', count: 0 });
  const sttOriginal = analysis.sttPreview?.original || 'STT 원문 정보가 없습니다.';
  const sttMasked = analysis.sttPreview?.masked || '마스킹본 정보가 없습니다.';
  const allChecked = checks.eligibility && checks.evidence && checks.hallucination;
  const trimmedReason = reason.trim();
  const reasonRequired = selectedDecision?.needsReason && !trimmedReason;
  const canSubmit = decision && allChecked && !reasonRequired;
  const completeDecision = () => {
    setShowFinalHitlConfirm(false);
    onDecide(review.id, decision, trimmedReason, recipientEmail);
  };

  return (
    <div className="modalBackdrop" role="presentation">
      <div className="modal hitlModal">
        <div className="modalHeader"><h2>법률구조 최종 검토</h2><button type="button" onClick={onClose}>닫기</button></div>

        <div className="hitlCaseMeta">
          <span><strong>{review.caseNo}</strong></span>
          <span>{review.type}</span>
          <span>{review.title}</span>
        </div>
        <div className="reviewRecipientBox">
          <div>
            <strong>담당 상담원</strong>
            <span>
              {review.counselor?.name || '미지정'}
              {review.counselor?.organization ? ` · ${review.counselor.organization}` : ''}
            </span>
          </div>
          <label>
            검토 결과 수신
            {/* 현재는 이 상담을 등록한 담당 상담원 1명에게만 결과가 전달됩니다.
                고를 수 있는 다른 수신자가 없으므로 선택형 컨트롤 대신 고정값임을 그대로 보여줍니다.
                (여러 명에게 보낼 수 있게 되면 이 자리를 다시 select로 바꾸면 됩니다) */}
            <select value={recipientEmail} onChange={(event) => setRecipientEmail(event.target.value)} disabled>
              <option value={review.counselor?.email || ''}>
                {review.counselor?.email ? `${review.counselor.name || '담당 상담원'} (${review.counselor.email})` : '담당 상담원 미지정'}
              </option>
            </select>
            <small className="helperText">현재는 담당 상담원에게만 전달됩니다.</small>
          </label>
        </div>

        {/* AI 분석은 참고용임을 명확히 (HITL 원칙) */}
        <div className="hitlBanner">아래 AI 분석은 참고용입니다. 법률 판단 항목을 직접 확인하신 뒤 최종 결정을 확정해주세요.</div>

        <div className="hitlSection">
          <h3>상담원 분석 내용</h3>
          <div className="resultCard lawyerAnalysisCard">
            <div className="lawyerAnalysisHeader">
              <strong>검토 요청에 포함된 상담 분석 패키지</strong>
              <span>상담원이 저장한 AI 분석·보완자료·채택 항목을 기준으로 최종 판단합니다.</span>
            </div>
            <p>{analysis.summary || review.summary || '상담원이 저장한 분석 요약이 없습니다.'}</p>
            <div className="hitlAnalysisGrid">
              <span>사건 유형: {analysis.caseType || review.type}</span>
              <span>사건 소분류: {analysis.caseSubtype || '미입력'}</span>
              <span>긴급도: {analysis.urgency || review.urgency || '중'}</span>
              <span>구조대상: {analysis.eligibility || review.eligibility || '검토 필요'}</span>
            </div>
            {analysis.counselorReviewNote ? <pre className="counselorReviewNote">{analysis.counselorReviewNote}</pre> : null}
            {analysis.caseTypeReason ? <p className="reasonText">분류 근거: {analysis.caseTypeReason}</p> : null}
            {analysis.emergency?.reason ? <p className="reasonText">긴급도 근거: {analysis.emergency.reason}</p> : null}
            {/* 상담원 화면에서 AI가 제시한 사건유형 후보(비율·근거)입니다. 상담원이 위 사건 유형으로
                확정하기 전에 어떤 후보들을 봤는지 변호사도 같이 확인할 수 있어야 합니다. */}
            {analysis.caseCandidates?.length ? (
              <div className="caseCandidateSummaryList">
                <strong>AI 사건유형 후보</strong>
                {analysis.caseCandidates.map((candidate) => (
                  <span key={candidate.type}>{candidate.type} {Math.round((candidate.ratio || 0) * 100)}% · {candidate.reason || '근거 없음'}</span>
                ))}
              </div>
            ) : null}
            {analysis.eligibilityCheck ? (
              <div className={analysis.eligibilityCheck.isTargetCandidate && !analysis.eligibilityCheck.evidenceSubmitted ? 'eligibilitySummary missingEvidence' : 'eligibilitySummary'}>
                <span>대상 유형: {analysis.eligibilityCheck.applicantType}</span>
                <span>필요 증빙: {analysis.eligibilityCheck.requiredEvidence}</span>
                <span>증빙 제출: {analysis.eligibilityCheck.evidenceSubmitted ? '확인됨' : '미제출'}</span>
              </div>
            ) : null}
            {/* 승소·집행 가능성, 구조 타당성 신호 — 상담원 화면과 같은 컴포넌트로 그려서 표시가 어긋나지 않게 합니다. */}
            {analysis.reliefReview ? <ReliefReviewSummary review={analysis.reliefReview} /> : null}
          </div>
        </div>

        <div className="hitlSection">
          <h3>누락 자료·체크리스트</h3>
          <div className="resultCard hitlEvidenceGrid">
            <div>
              <strong>누락 자료</strong>
              {analysis.missingInfo?.length ? analysis.missingInfo.map((item) => (
                <span key={item}>
                  {item}
                  {analysis.evidenceStatus?.[item] ? ` · ${analysis.evidenceStatus[item] === 'submitted' ? '제출 확인' : '미제출'}` : ''}
                </span>
              )) : <span>표시된 누락 자료 없음</span>}
            </div>
            <div>
              <strong>상담원 확인 항목</strong>
              {analysis.checklist?.length ? analysis.checklist.map((item) => <span key={item.label}>{item.checked ? '확인' : '미확인'} · {item.label}</span>) : <span>체크리스트 없음</span>}
            </div>
          </div>
        </div>

        <div className="hitlSection">
          <h3>STT 개인정보 마스킹</h3>
          <div className="resultCard lawyerSttGrid">
            <div>
              <strong>마스킹본</strong>
              <p>{sttMasked}</p>
            </div>
            <div>
              <strong>원문</strong>
              <p>{sttOriginal}</p>
              <span>원문에는 민감정보가 포함될 수 있으므로 검증 목적으로만 확인합니다.</span>
            </div>
          </div>
        </div>

        <div className="hitlSection">
          <h3>검토 근거 상세</h3>
          <div className="resultCard lawyerEvidenceBundle">
            <div>
              <strong>상담원 채택 항목</strong>
              {adoptedItems.map((item) => <span key={typeof item === 'string' ? item : item.text}>{typeof item === 'string' ? item : item.text}</span>)}
            </div>
            <div>
              <strong>입력자료 구성</strong>
              {modalityItems.map((item) => <span key={item.key}>{item.key}: {item.count}건</span>)}
            </div>
            <div>
              <strong>첨부파일 추출 상태</strong>
              {extractedItems.map((item, index) => (
                <span key={`${item.fileLink || item.note}-${index}`}>
                  {fileExtractionLabel(item.status)} · {item.fileLink || item.note || '파일명 없음'}
                </span>
              ))}
            </div>
            <div>
              <strong>첨부 저장 위치</strong>
              {attachmentItems.map((item, index) => {
                const location = item.fileKey || item.fileUrl || item.fileName || '저장 위치 없음';
                return (
                  <span key={`${location}-${index}`}>
                    {item.fileName || '첨부파일'} · {location}
                  </span>
                );
              })}
            </div>
            <div>
              <strong>AI 응답 검증</strong>
              <span>형식: {analysis.verification?.format ? '통과' : '확인 필요'}</span>
              <span>근거: {analysis.verification?.grounded ? '첨부자료 근거 확인' : '근거 보강 필요'}</span>
              <span>환각 위험: {analysis.verification?.hallucinationRisk ? '확인 필요' : '낮음'}</span>
            </div>
          </div>
        </div>

        <div className="hitlSection">
          <h3>사실관계 타임라인</h3>
          <div className="resultCard lawyerTimeline">
            {timelineItems.map((item, index) => (
              <span key={`${item.date}-${item.text}-${index}`}>
                <strong>{item.date || '-'}</strong>
                {item.text || item}
              </span>
            ))}
          </div>
        </div>

        <div className="hitlSection">
          <h3>법률 판단 항목 확인</h3>
          <div className="resultCard checklistBox">
            <label><input type="checkbox" checked={checks.eligibility} onChange={() => setChecks((c) => ({ ...c, eligibility: !c.eligibility }))} />법률구조 대상 요건을 확인했습니다.</label>
            <label><input type="checkbox" checked={checks.evidence} onChange={() => setChecks((c) => ({ ...c, evidence: !c.evidence }))} />제출된 자료·증빙을 확인했습니다.</label>
            <label><input type="checkbox" checked={checks.hallucination} onChange={() => setChecks((c) => ({ ...c, hallucination: !c.hallucination }))} />AI가 제시한 법령·판례 근거의 실재 여부를 확인했습니다.</label>
          </div>
        </div>

        <div className="hitlSection">
          <h3>검토 결과 선택</h3>
          <div className="hitlDecisionGrid">
            {hitlDecisions.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`hitlDecisionCard tone-${item.tone}${decision === item.key ? ' selected' : ''}`}
                onClick={() => setDecision(item.key)}
              >
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </button>
            ))}
          </div>
        </div>

        {selectedDecision?.needsReason ? (
          <label className="field">
            <span>사유 <strong className="requiredMark">필수</strong></span>
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="사유를 입력하세요." />
          </label>
        ) : null}

        {reasonRequired ? <p className="formError">{decision} 결정에는 사유 입력이 필요합니다.</p> : null}
        {decision && !allChecked ? <p className="formError">법률 판단 항목을 모두 확인해야 결정을 확정할 수 있습니다.</p> : null}

        <div className="inlineControls statusConfirmActions">
          <button className="smallButton light" type="button" onClick={onClose}>취소</button>
          <button className="primaryButton hitlSubmitButton" type="button" disabled={!canSubmit} onClick={() => setShowFinalHitlConfirm(true)}>검토 확정</button>
        </div>
        <p className="helperText">결정자: {reviewer} · 확정하면 감사 로그와 담당 상담원 알림에 반영됩니다.</p>
        {showFinalHitlConfirm ? (
          <HitlConfirmModal
            title="검토 결과 확정 전 최종 확인"
            actionLabel="확인 후 확정"
            caseInfo={`${review.caseNo} · ${review.title} · ${decision}`}
            onConfirm={completeDecision}
            onCancel={() => setShowFinalHitlConfirm(false)}
            nested
          />
        ) : null}
      </div>
    </div>
  );
}

function ReviewLog({ logs, onDelete }) {
  const confirm = useConfirm();
  const columnCount = onDelete ? 7 : 6;
  const handleDelete = async (row) => {
    if (!onDelete) return;
    const accepted = await confirm({
      title: '이 결정 로그를 삭제할까요?',
      message: `R-${row.id} · ${row.caseNo} 「${row.title || '제목 없음'}」\n목록에서 삭제하며 되돌릴 수 없습니다.`,
      confirmLabel: '삭제',
      tone: 'danger',
    });
    if (accepted) onDelete(row);
  };
  // 예전엔 slice(0, 6)으로 최신 6건만 보여주고 그 이전 기록은 화면에서 아예 사라졌습니다.
  // '최근 상담 목록'과 같은 규칙(6칸을 유지하되, 넘치면 스크롤로 나머지를 본다)으로 맞춥니다.
  const visibleRowCount = 6;
  const scrollable = logs.length > visibleRowCount;
  return (
    <section className="panel">
      <div className="panelTitleRow"><h2>최근 검토 결정 로그</h2></div>
      <div className={scrollable ? 'tableScroll' : ''}>
        <table className="dataTable">
          <thead><tr><th>검토 번호</th><th>사건 번호</th><th>상담 제목</th><th>처리일</th><th>결정</th><th>사유</th>{onDelete ? <th>삭제</th> : null}</tr></thead>
          <tbody>
            {logs.map((row) => (
              <tr key={`${row.id}-${row.status}-${row.loggedAt}`}>
                <td>R-{row.id}</td>
                <td>{row.caseNo}</td>
                <td>{row.title}</td>
                <td>{row.loggedAt}</td>
                <td><span className={reviewStatusTone(row.status)}>{row.status}</span></td>
                <td>{row.reason || '-'}</td>
                {onDelete ? <td><button className="tableAction danger" type="button" onClick={() => handleDelete(row)}>삭제</button></td> : null}
              </tr>
            ))}
            {scrollable ? null : <EmptyRows count={Math.max(0, visibleRowCount - logs.length)} columns={columnCount} isEmpty={logs.length === 0} emptyLabel="아직 검토 결정 이력이 없습니다." />}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const roleLabels = { counselor: '상담원', lawyer: '변호사', admin: '관리자' };

function AdminDashboard({ users, onUpdateUserStatus, consultations, reviews, activeView, currentUser, onUpdateProfile, notifications, onReadNotifications, onDeleteNotification, onOpenNotification }) {
  const [activeAdminView, setActiveAdminView] = useState('consultations');
  // 관리자 자신을 포함해 전체 회원가입 신청자를 대상으로 승인 현황을 관리합니다.
  const userFilter = activeAdminView === 'pendingUsers' ? '대기' : activeAdminView === 'activeUsers' ? '승인' : statusAll;
  const filteredUsers = userFilter === statusAll ? users : users.filter((item) => item.status === userFilter);

  // GET /api/admin/stats(신규): 요약 카드 4개를 로컬 배열(users/consultations/reviews)로 어림잡아 계산하는
  // 대신, 실제 DB 집계값을 그대로 받아 씁니다. core-api 연결 전이거나 호출 실패 시에는 기존 로컬 계산으로
  // 자연스럽게 폴백합니다(화면이 빈 값으로 깨지지 않도록).
  const [adminStats, setAdminStats] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchCoreAdminStats(currentUser?.token)
      .then((stats) => { if (!cancelled) setAdminStats(stats); })
      .catch(() => { if (!cancelled) setAdminStats(null); });
    return () => { cancelled = true; };
  }, [currentUser?.token]);

  const localAnalysisRate = reviews.length ? Math.round((reviews.filter((item) => item.status === '승인').length / reviews.length) * 100) : 0;
  const cards = [
    { title: '전체 상담 건수', value: `${adminStats ? adminStats.total_consultations : consultations.length}건`, filter: 'consultations' },
    { title: '활성 사용자', value: `${adminStats ? adminStats.active_users : users.filter((item) => item.status === '승인').length}명`, filter: 'activeUsers' },
    { title: '분석 처리율', value: `${adminStats ? Math.round(adminStats.analysis_processing_rate * 100) : localAnalysisRate}%`, filter: 'analysis' },
    { title: '직원 승인 대기', value: `${adminStats ? adminStats.pending_user_approvals : users.filter((item) => item.status === '대기').length}건`, filter: 'pendingUsers' },
  ];

  // 관리자 업무 범위(전체 조회/계정 권한 관리/통계 대시보드/DB 관리/감사로그)에는
  // 상담 등록이나 서식 초안 생성이 포함되지 않으므로, 그 메뉴들은 관리자 네비게이션에서 아예 제외했습니다.
  // (상담원/변호사 전용 워크벤치가 실수로라도 노출되지 않도록 여기서도 대시보드/프로필/운영관리/알림 4가지만 분기합니다.)
  if (activeView === '프로필') return <UtilityPanel view={activeView} role="admin" currentUser={currentUser} onUpdateProfile={onUpdateProfile} />;
  if (activeView === '기타') return <AdminOpsPanel currentUser={currentUser} />;
  if (activeView === '알림') return <UtilityPanel view={activeView} role="admin" currentUser={currentUser} notifications={notifications} onReadNotifications={onReadNotifications} onDeleteNotification={onDeleteNotification} onOpenNotification={onOpenNotification} />;
  return (
    <main className="dashboard dashboard-admin">
      <SummaryCards cards={cards} activeFilter={activeAdminView} onFilter={setActiveAdminView} allowToggle={false} />
      {activeAdminView === 'consultations' ? (
        <div className="adminSplit">
          <ConsultationStatsPanel consultations={consultations} />
          <BarChartMock consultations={consultations} />
        </div>
      ) : null}
      {activeAdminView === 'analysis' ? (
        <div className="adminSplit">
          <AnalysisStatsPanel reviews={reviews} />
          <DonutChartMock reviews={reviews} />
        </div>
      ) : null}
      {activeAdminView === 'activeUsers' ? <ActiveUsersPanel users={users} /> : null}
      {activeAdminView === 'pendingUsers' ? <AccountTable rows={filteredUsers} onUpdate={onUpdateUserStatus} title="회원가입 승인 대기" /> : null}
    </main>
  );
}

// 활성(승인된) 사용자 요약 패널. 역할별 인원 수와 계정 목록(이름/소속/이메일/가입 신청일)을 함께 보여줍니다.
function ActiveUsersPanel({ users }) {
  const approved = users.filter((user) => user.status === '승인');
  const roleOrder = ['counselor', 'lawyer', 'admin'];
  const roleCounts = roleOrder.map((role) => ({
    role,
    label: roleLabels[role],
    count: approved.filter((user) => user.role === role).length,
  }));

  return (
    <section className="panel activeUsersPanel">
      <div className="panelTitleRow"><h2>활성 사용자 현황</h2><span className="panelCountBadge">총 {approved.length}명</span></div>
      <div className="roleCountRow">
        {roleCounts.map((item) => (
          <div className={`roleCountChip role-${item.role}`} key={item.role}>
            <strong>{item.count}명</strong>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
      <table className="dataTable">
        <thead><tr><th>이름</th><th>역할</th><th>소속기관 / 부서</th><th>지부</th><th>연락처</th><th>이메일</th><th>가입 신청일</th></tr></thead>
        <tbody>
          {approved.map((row) => (
            <tr key={row.email}>
              <td>{row.name}</td>
              <td>{roleLabels[row.role] || row.role}</td>
              <td>{row.organization || '-'}</td>
              <td>{row.branch || '-'}</td>
              <td>{row.phone || '-'}</td>
              <td>{row.email}</td>
              <td>{row.requestedAt || '-'}</td>
            </tr>
          ))}
          <EmptyRows count={Math.max(0, 6 - approved.length)} columns={7} isEmpty={approved.length === 0} emptyLabel="활성 사용자가 없습니다." />
        </tbody>
      </table>
    </section>
  );
}

function AccountTable({ rows, onUpdate, title = '회원가입 승인 관리', compact = false }) {
  return (
    <section className="panel">
      <div className="panelTitleRow"><h2>{title}</h2></div>
      <table className="dataTable">
        <thead><tr><th>이름</th><th>신청 역할</th>{compact ? null : <th>소속</th>}<th>이메일</th>{compact ? null : <th>신청일</th>}<th>승인/거절</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.email}>
              <td>{row.name}</td><td>{roleLabels[row.role] || row.role}</td>{compact ? null : <td>{row.organization}</td>}<td>{row.email}</td>{compact ? null : <td>{row.requestedAt}</td>}
              {/* 관리자만 상담원/변호사 계정을 승인·거절할 수 있고, 승인 전에는 로그인이 막힙니다. */}
              <td><div className="statusActions"><StatusButton active={row.status === '승인'} onClick={() => onUpdate(row.email, '승인')}>승인</StatusButton><StatusButton active={row.status === '거절'} onClick={() => onUpdate(row.email, '거절')}>거절</StatusButton></div></td>
            </tr>
          ))}
          <EmptyRows count={Math.max(0, 3 - rows.length)} columns={compact ? 4 : 6} isEmpty={rows.length === 0} emptyLabel="가입 승인 대기 중인 계정이 없습니다." />
        </tbody>
      </table>
    </section>
  );
}

const weekdayLabels = ['일', '월', '화', '수', '목', '금', '토'];

function toIsoDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 기준일(today)이 속한 주의 일요일을 구하고, weekOffset(주 단위)만큼 이동시킵니다.
function getWeekStart(weekOffset) {
  const base = new Date(today);
  base.setDate(base.getDate() - base.getDay() + weekOffset * 7);
  base.setHours(0, 0, 0, 0);
  return base;
}

function formatWeekRangeLabel(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const fmt = (date) => `${date.getMonth() + 1}.${date.getDate()}`;
  return `${weekStart.getFullYear()}년 ${fmt(weekStart)} ~ ${fmt(weekEnd)}`;
}

// 이 화면의 막대그래프들(요일별 상담 건수, 사건 유형별 상담 건수)이 공용으로 쓰는 눈금 계산입니다.
// 실제 최댓값을 그대로 100%로 잡으면 건수가 적을 때는 막대가 꽉 차 보이고, 건수가 아주 많아지면
// 반대로 눈금 갱신이 안 따라가는 문제가 생깁니다. 그래서 최댓값의 3배 정도를 목표로 잡고
// 1/2/5/10 단위의 "보기 좋은 눈금"으로 올림해서, 하루 2건이든 법률구조공단 실제 규모(하루 수십~백여 건)든
// 막대가 항상 절제된(대략 20~35%대) 비율로 표현되도록 합니다.
function computeNiceScaleMax(rawMax) {
  if (rawMax <= 0) return 10;
  const headroomMultiplier = 3;
  const targetMax = rawMax * headroomMultiplier;
  const magnitude = 10 ** Math.floor(Math.log10(targetMax));
  const normalized = targetMax / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

function ConsultationStatsPanel({ consultations }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState(today);

  const weekStart = useMemo(() => getWeekStart(weekOffset), [weekOffset]);
  const days = useMemo(() => weekdayLabels.map((label, index) => {
    const date = new Date(weekStart);
    date.setDate(date.getDate() + index);
    const iso = toIsoDateLocal(date);
    return {
      label,
      iso,
      dayOfMonth: date.getDate(),
      monthNum: date.getMonth() + 1,
      year: date.getFullYear(),
      closed: index === 0 || index === 6,
      isToday: iso === today,
      count: consultations.filter((item) => item.date === iso).length,
    };
  }), [weekStart, consultations]);
  const scaleMax = computeNiceScaleMax(Math.max(0, ...days.map((item) => item.count)));

  // 주를 이동하면 선택된 날짜가 화면에 보이는 주 밖으로 벗어나므로, 같은 요일로 자동 재선택합니다.
  useEffect(() => {
    const selectedWeekday = new Date(selectedDate).getDay();
    const matched = days.find((item) => new Date(item.iso).getDay() === selectedWeekday);
    if (matched && matched.iso !== selectedDate) setSelectedDate(matched.iso);
  }, [weekStart]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedDay = days.find((item) => item.iso === selectedDate) || days[0];
  const dayRows = consultations.filter((item) => item.date === selectedDay.iso);

  return (
    <section className="panel consultationStatsPanel">
      <div className="panelTitleRow consultationStatsHeader">
        <h2>전체 상담 현황</h2>
        <div className="weekNav">
          <button type="button" className="weekNavButton" onClick={() => setWeekOffset((value) => value - 1)} aria-label="이전 주"><ChevronLeft size={16} /></button>
          <span>{formatWeekRangeLabel(weekStart)}</span>
          <button type="button" className="weekNavButton" onClick={() => setWeekOffset((value) => value + 1)} aria-label="다음 주"><ChevronRight size={16} /></button>
          {/* 항상 노출해 컨트롤 폭을 고정합니다. 이번 주를 보고 있어도 선택 날짜를 오늘로 되돌립니다. */}
          <button
            type="button"
            className="weekNavToday"
            onClick={() => { setWeekOffset(0); setSelectedDate(today); }}
          >
            오늘
          </button>
        </div>
      </div>
      <div className="weekdayStats">
        {days.map((item) => (
          <button
            type="button"
            key={item.iso}
            className={[
              'weekdayStat',
              item.closed ? 'closed' : '',
              item.iso === selectedDay.iso ? 'selected' : '',
              item.isToday ? 'isToday' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => setSelectedDate(item.iso)}
          >
            <span>{item.label} <em>{item.dayOfMonth}</em></span>
            <div className="weekdayBarTrack">
              {item.closed ? <em className="closedLabel">휴무</em> : <i style={{ height: `${item.count ? Math.max(14, (item.count / scaleMax) * 100) : 0}%` }} />}
            </div>
            <strong>{item.closed ? '상담 없음' : `${item.count}건`}</strong>
          </button>
        ))}
      </div>
      <div className="adminTableScroll">
        <table className="dataTable adminConsultationTable">
          <thead>
            <tr>
              <th colSpan={7} className="adminTableCaption">
                {selectedDay.closed ? `${selectedDay.label}요일 (휴무) 상담 내역` : `${selectedDay.year}.${selectedDay.monthNum}.${selectedDay.dayOfMonth} (${selectedDay.label}) 상담 내역 · ${dayRows.length}건`}
              </th>
            </tr>
            <tr><th>사건 번호</th><th>상담자</th><th>담당 상담원</th><th>검토 변호사</th><th>사건 유형</th><th>등록일</th><th>처리 단계</th></tr>
          </thead>
          <tbody>
            {dayRows.map((row) => <tr key={row.id}><td>{row.caseNo}</td><td>{row.name}</td><td>{row.counselor?.name || '미지정'}</td><td>{row.lawyer?.name || row.reviewAction?.reviewer?.name || '미지정'}</td><td>{row.type}</td><td>{row.date}</td><td><span className={workflowStatusTone(row.workflowStatus)}>{row.workflowStatus || '분석 전'}</span></td></tr>)}
            <EmptyRows count={Math.max(0, 5 - dayRows.length)} columns={7} isEmpty={dayRows.length === 0} emptyLabel="선택한 날짜에 등록된 상담이 없습니다." />
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AnalysisStatsPanel({ reviews }) {
  return (
    <section className="panel">
      <div className="panelTitleRow"><h2>분석 처리 상세</h2></div>
      <table className="dataTable">
        <thead><tr><th>사건 번호</th><th>사건 제목</th><th>상태</th><th>요청일</th></tr></thead>
        <tbody>
          {reviews.map((row) => <tr key={row.id}><td>{row.caseNo}</td><td>{row.title}</td><td><span className={reviewStatusTone(row.status)}>{row.status}</span></td><td>{row.requestedAt}</td></tr>)}
          <EmptyRows count={Math.max(0, 5 - reviews.length)} columns={4} isEmpty={reviews.length === 0} emptyLabel="분석 처리 이력이 없습니다." />
        </tbody>
      </table>
    </section>
  );
}

function AdminOpsPanel({ currentUser }) {
  const [templateStatus, setTemplateStatus] = useState('검사 전');
  const [auditRows, setAuditRows] = useState(() => getAuditLogs());
  const [aiApiStatus, setAiApiStatus] = useState({ tone: 'muted', label: '확인 전' });
  const [coreApiStatus, setCoreApiStatus] = useState({ tone: 'muted', label: '확인 전', users: 0, consultations: 0 });
  // core-api가 SEC-01-01-01 요구사항(상담 조회/AI 분석 실행·수정/검토 승인·반려/문서 다운로드)에 따라
  // 서버에서 직접 남기는 감사 로그입니다. 위 auditRows(브라우저 로컬 기록)와는 별개 시스템이라
  // 표를 합치지 않고, 기존 '서버 상태 확인' 버튼들과 같은 패턴으로 체인 위변조 여부만 확인합니다.
  const [serverAuditStatus, setServerAuditStatus] = useState({ tone: 'muted', label: '확인 전' });
  const runWithLoading = useAsyncAction();
  // 실행 중인 점검의 키. 로딩 오버레이는 1초 뒤에야 뜨므로 그 사이 연타를 여기서 막습니다.
  const [runningCheck, setRunningCheck] = useState(null);

  const runCheck = async (key, task, loadingMessage) => {
    if (runningCheck) return;
    setRunningCheck(key);
    try {
      await runWithLoading(task, loadingMessage);
    } finally {
      setRunningCheck(null);
    }
  };

  const runTemplateCheck = () => runCheck('template', async () => {
    await simulateBackendLatency();
    const result = checkTemplateRevision();
    setTemplateStatus(result.message);
    setAuditRows(appendAuditLog({ actor: '관리자', action: '서식 개정 확인', target: result.source, metadata: result }));
  }, '서식 개정 여부를 확인하고 있습니다');

  // ai-api(FastAPI) 서버가 실제로 떠 있고 프론트에서 호출 가능한지 확인하는 실제 네트워크 요청입니다.
  const runAiApiHealthCheck = () => runCheck('ai', async () => {
    try {
      await checkAiApiHealth();
      setAiApiStatus({ tone: 'success', label: '연결됨' });
    } catch (error) {
      setAiApiStatus({ tone: 'danger', label: error.message });
    }
  }, 'AI API 서버 연결을 확인하고 있습니다');

  const runCoreApiHealthCheck = () => runCheck('core', async () => {
    try {
      const result = await checkCoreApiStatus();
      setCoreApiStatus({
        tone: 'success',
        label: '연결됨',
        users: result.userCount,
        consultations: result.consultationCount,
      });
    } catch (error) {
      const isSchemaMismatch = error.message.includes('approval_status 컬럼이 없습니다');
      setCoreApiStatus({
        tone: isSchemaMismatch ? 'warn' : 'danger',
        label: isSchemaMismatch ? 'DB 스키마 확인 필요' : error.message,
        detail: error.message,
        users: 0,
        consultations: 0,
      });
    }
  }, 'Core API 서버 연결을 확인하고 있습니다');

  const runServerAuditCheck = () => runCheck('serverAudit', async () => {
    try {
      const [logs, verification] = await Promise.all([
        fetchCoreAuditLogs(currentUser?.token),
        verifyCoreAuditLogChain(currentUser?.token),
      ]);
      setServerAuditStatus({
        tone: verification?.intact ? 'success' : 'danger',
        label: verification?.intact ? `이상 없음 (${logs.length}건)` : `위변조 의심 (log id ${verification?.brokenAtLogId})`,
      });
    } catch (error) {
      setServerAuditStatus({ tone: 'danger', label: error.message });
    }
  }, '서버 감사 로그 체인을 검증하고 있습니다');
  // 감사 로그는 ISO 문자열(UTC, 예: "2026-07-28T09:07:37.214Z")로 저장돼 있어 그대로 보여주면
  // 관리자가 시각을 바로 읽기 어렵고, UTC라 실제 한국 시간과 9시간 차이도 납니다.
  // 화면에는 한국 시간 기준으로 보기 좋게 바꿔서 보여줍니다.
  const formatAuditTimestamp = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '-';
    return date.toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  };
  // 로그인/로그아웃 기록은 대상(target)에 사건번호 대신 역할 키(admin/lawyer/counselor)가 들어있어,
  // 다른 화면과 같은 한글 라벨(관리자/변호사/상담원)로 통일해 보여줍니다.
  const formatAuditTarget = (target) => roleLabels[target] || target || '-';
  const formatAuditDetail = (row) => {
    const metadata = row.metadata || {};
    if (metadata.before || metadata.after) return `${metadata.before || '-'} → ${metadata.after || '-'}`;
    if (metadata.reason) return `사유: ${metadata.reason}`;
    if (metadata.title || metadata.type) return [metadata.title, metadata.type].filter(Boolean).join(' · ');
    if (metadata.caseType || metadata.eligibility) return [metadata.caseType, metadata.eligibility].filter(Boolean).join(' · ');
    if (metadata.emailChanged || metadata.organizationChanged || metadata.passwordChanged) {
      return [
        metadata.emailChanged ? `이메일: ${metadata.emailBefore || '-'} → ${metadata.emailAfter || '-'}` : '',
        metadata.organizationChanged ? `소속: ${metadata.organizationBefore || '-'} → ${metadata.organizationAfter || '-'}` : '',
        metadata.passwordChanged ? '비밀번호 변경' : '',
      ].filter(Boolean).join(' / ');
    }
    if (metadata.name || metadata.email || metadata.role) return [metadata.name, metadata.email, metadata.role].filter(Boolean).join(' · ');
    if (metadata.message) return metadata.message;
    return '-';
  };

  return (
    <main className="workspacePage">
      <section className="workflowPanel">
        <h2>운영 관리</h2>
        <div className="workflowColumns">
          <div>
            <h3>감사 로그</h3>
            <div className="adminTableScroll">
              <table className="dataTable auditTable">
                <thead><tr><th>일시</th><th>주체</th><th>작업</th><th>대상</th><th>상세</th></tr></thead>
                <tbody>
                  {auditRows.map((row) => <tr key={`${row.action}-${row.target}-${row.id}`}><td>{formatAuditTimestamp(row.createdAt || today)}</td><td>{row.actor}</td><td>{row.action}</td><td>{formatAuditTarget(row.target)}</td><td>{formatAuditDetail(row)}</td></tr>)}
                  <EmptyRows count={Math.max(0, 4 - auditRows.length)} columns={5} isEmpty={auditRows.length === 0} emptyLabel="감사 로그가 없습니다." />
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h3>서식 개정 모니터링</h3>
            <div className="resultCard">
              <p>Helplaw24 서식 개정 여부를 점검하는 운영 기능입니다.</p>
              <strong>상태: {templateStatus}</strong>
            </div>
            <button className="primaryButton" type="button" onClick={runTemplateCheck} disabled={Boolean(runningCheck)}>{runningCheck === 'template' ? '확인하는 중…' : '서식 개정 확인'}</button>
            <h3>AI API 서버 연결 상태</h3>
            <div className="resultCard">
              <p>backend/ai-api(FastAPI) 서버가 프론트에서 실제로 호출 가능한 상태인지 확인합니다.</p>
              <strong>
                상태: <span className={`statusChip tone-${aiApiStatus.tone}`}>{aiApiStatus.label}</span>
              </strong>
            </div>
            <button className="primaryButton" type="button" onClick={runAiApiHealthCheck} disabled={Boolean(runningCheck)}>{runningCheck === 'ai' ? '확인하는 중…' : 'AI API 연결 확인'}</button>
            <h3>Core API 서버 연결 상태</h3>
            <div className="resultCard apiStatusCard">
              <p>backend/core-api(Spring Boot) 상담·사용자 API가 프론트에서 호출 가능한지 확인합니다.</p>
              <strong>
                상태: <span className={`statusChip tone-${coreApiStatus.tone}`}>{coreApiStatus.label}</span>
              </strong>
              {coreApiStatus.tone === 'success' ? (
                <div className="apiMetricGrid">
                  <span>사용자 {coreApiStatus.users}명</span>
                  <span>상담 {coreApiStatus.consultations}건</span>
                </div>
              ) : null}
              {coreApiStatus.detail ? <p className="helperText">{coreApiStatus.detail}</p> : null}
            </div>
            <button className="primaryButton" type="button" onClick={runCoreApiHealthCheck} disabled={Boolean(runningCheck)}>{runningCheck === 'core' ? '확인하는 중…' : 'Core API 연결 확인'}</button>
            <h3>서버 감사 로그 검증</h3>
            <div className="resultCard">
              <p>상담 조회·AI 분석 실행/수정·검토 승인/반려·문서 다운로드를 서버가 직접 남긴 감사 로그(해시체인)의 위변조 여부를 확인합니다.</p>
              <strong>
                상태: <span className={`statusChip tone-${serverAuditStatus.tone}`}>{serverAuditStatus.label}</span>
              </strong>
            </div>
            <button className="primaryButton" type="button" onClick={runServerAuditCheck} disabled={Boolean(runningCheck)}>{runningCheck === 'serverAudit' ? '검증하는 중…' : '서버 감사 로그 검증'}</button>
          </div>
        </div>
      </section>
    </main>
  );
}

function BarChartMock({ consultations }) {
  // 소분류(29개)가 아니라 대분류(친족/상속/가사소송/가족관계등록) 4개 기준으로 집계해 한눈에 보이게 합니다.
  const countByCategory = (key) => consultations.filter((item) => (item.category || getCaseCategory(item.type)) === key).length;
  // 아는 4개 분류에 속하지 않는 상담(AI가 다른 체계의 유형을 돌려준 경우 등)은 '기타'로 모입니다.
  // 이 줄이 없으면 그런 상담이 통계에서 통째로 사라져, 합계가 실제 건수와 맞지 않게 됩니다.
  const knownKeys = caseCategories.map((category) => category.key);
  const categoryKeys = countByCategory('기타') ? [...knownKeys, '기타'] : knownKeys;
  const rawMax = Math.max(0, ...categoryKeys.map(countByCategory));
  const scaleMax = computeNiceScaleMax(rawMax);
  return <section className="chartPanel"><h2>사건 유형별 상담 통계</h2><div className="barChart">{categoryKeys.map((key) => { const count = countByCategory(key); const isZero = count === 0; return <div className="barRow" key={key}><span>{key}</span><i className={isZero ? 'zero' : ''} style={{ width: isZero ? 0 : `${Math.max(8, (count / scaleMax) * 100)}%` }}>{count}</i></div>; })}</div></section>;
}

// 도넛의 각 구간(stroke-dasharray/offset)을 계산하는 저수준 기하 로직입니다.
// pathLength="100"으로 원 둘레를 정규화해두면 퍼센트를 그대로 대시 길이로 쓸 수 있습니다.
function buildDonutArcs(visibleSegments, total, gapPercent) {
  let cumulativePercent = 0;
  return visibleSegments.map((segment) => {
    const percent = total ? (segment.value / total) * 100 : 0;
    const trimmedPercent = Math.max(0, percent - gapPercent);
    const dashOffset = 100 - cumulativePercent;
    cumulativePercent += percent;
    return { key: segment.key, className: segment.toneClass, dashArray: `${trimmedPercent} ${100 - trimmedPercent}`, dashOffset };
  });
}

function DonutChart({ total, segments }) {
  const visibleSegments = segments.filter((segment) => segment.value > 0);
  const arcs = buildDonutArcs(visibleSegments, total, visibleSegments.length > 1 ? 2.4 : 0);
  const summary = segments.map((segment) => `${segment.label} ${segment.value}건`).join(', ');
  return (
    <div className="donutChart" role="img" aria-label={`전체 ${total}건 중 ${summary}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="donutTrack" cx="50" cy="50" r="40" pathLength="100" />
        {arcs.map((arc) => (
          <circle key={arc.key} className={`donutArc ${arc.className}`} cx="50" cy="50" r="40" pathLength="100" strokeDasharray={arc.dashArray} strokeDashoffset={arc.dashOffset} />
        ))}
      </svg>
      <div className="donutCenter">
        <strong>{total}<em>건</em></strong>
      </div>
    </div>
  );
}

function DonutChartMock({ reviews }) {
  const total = reviews.length;
  const approved = reviews.filter((item) => item.status === '승인').length;
  const rejected = reviews.filter((item) => item.status === '반려').length;
  const pending = Math.max(0, total - approved - rejected);
  // 승인/반려/대기 색상은 나머지 화면의 처리 단계 톤(tone-success/danger/warn)과 그대로 맞춰 일관성을 유지합니다.
  const segments = [
    { key: 'approved', label: '승인', value: approved, toneClass: 'tone-success' },
    { key: 'rejected', label: '반려', value: rejected, toneClass: 'tone-danger' },
    { key: 'pending', label: '대기', value: pending, toneClass: 'tone-warn' },
  ];
  return (
    <section className="chartPanel">
      <h2>분석 처리 현황</h2>
      <div className="donutWrap">
        <DonutChart total={total} segments={segments} />
        <ul className="legendList">
          <li className="legendTotalRow">전체 <strong>{total}건</strong> 접수</li>
          {segments.map((segment) => (
            <li className="legendRow" key={segment.key}>
              <span className={`legendDot ${segment.toneClass}`} />
              <span className="legendLabel">{segment.label}</span>
              <span className="legendValue">{segment.value}건</span>
              <span className="legendPercent">{total ? Math.round((segment.value / total) * 100) : 0}%</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export { CounselorDashboard, LawyerDashboard, AdminDashboard };
