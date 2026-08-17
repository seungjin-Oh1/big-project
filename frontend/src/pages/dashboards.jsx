import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, ClipboardCheck, Search, Trash2,
  CheckCircle2, XCircle, FileEdit, FilePlus2, PauseCircle,
  ListChecks, ShieldCheck, FileText, MessageSquareText, Clock,
  EyeOff, Scale, CheckSquare, Square, AlertTriangle, Info,
  ClipboardList, FolderOpen, Sparkles, LayoutDashboard, X,
} from 'lucide-react';
import { statusAll, today } from '../constants.jsx';
import { EmptyRows, InlineEmptyNotice, StatusButton, SummaryCards, ConsultationTable, HitlConfirmModal, WorkPageHeader, workflowStatusTone, HorizontalScrollBox, ScrollableDataTable, FIRST_SEVEN_COLUMN_MIN_WIDTHS, CollapsibleSection, friendlyErrorMessage } from '../components/common.jsx';
import { useConfirm, useToast } from '../components/feedback.jsx';
import { UtilityPanel, ReliefReviewSummary, DOCUMENT_STATUS_LABEL, documentStatusTone, GeneratedFileLink, DraftContentReviewLabel, SummaryBulletList, resolveConfirmedCaseType } from './workflows/index.jsx';
import { dedupeDocumentsByForm } from './workflows/shared/documentHelpers.js';
import { referenceTypeLabel } from './workflows/shared/referenceTypes.js';
import { appendAuditLog, getAuditLogs, readStorage, storageKeys, writeStorage } from '../services/storage.js';
import { checkAiApiHealth, checkFormRevisions, acknowledgeFormRevisions } from '../services/aiApiClient.js';
import { approveCoreAnalysis, approveCoreDocument, checkCoreApiStatus, coreAuthHeader, CORE_API_BASE_URL, fetchCoreAdminStats, fetchCoreAuditLogs, fetchCoreDocuments, fetchCoreUsers, fetchMaskedTranscript, mapCoreUserToLocal, requestCoreAnalysisRevision, verifyCoreAuditLogChain } from '../services/coreApiClientV2.js';
import { readSubmittedLocalDocumentReviews, updateLocalDocumentReview, removeLocalDocumentReview, dismissDocumentReview, isDocumentReviewDismissed, saveLawyerDraftEdit, readLawyerDraftEdit } from '../services/documentReviewStore.js';
import { hydrateDraftDocument } from '../services/draftDocumentStore.js';
import { caseCategories, getCaseCategory, isKnownCaseType, legalTemplateSeed } from '../data/domain.js';
import { useAsyncAction } from '../components/loading.jsx';
import { statusChipClass } from '../utils/statusTone.js';
import { formatTimelineItems, resolveTimelineForDisplay } from './workflows/shared/timeline.js';

// 표 하나에서 한 번에 보여줄 데이터 줄 수입니다. 이름을 포함한 머리글 1줄 + 이 개수만큼의
// 본문 줄까지만 스크롤 없이 바로 보이고, 더 있으면 마우스로 내려야 볼 수 있게 표 전체에서
// 이 기준 하나로 통일합니다(회원 목록·감사 로그처럼 표마다 3/4/5로 제각각이던 것을 맞춥니다).
const VISIBLE_ROW_COUNT = 6;

// 긴급도(상→중→하) 순 정렬 기준입니다. 법률구조 검토 요청 표와 서류 검토 대기 목록이 같은
// 기준을 공유해야, 어느 화면을 열어도 변호사가 "지금 뭐부터 봐야 하는지"를 같은 규칙으로
// 알 수 있습니다.
const URGENCY_RANK = { 상: 0, 중: 1, 하: 2 };

// 테스트 계정으로 생성된 사건은 API가 담당자 프로필을 생략해도 화면에서 '미지정'으로
// 보이지 않게 합니다. 실제 담당자 이름·이메일이 있으면 그 값을 우선하고, 데모용 C-CORE
// 사건에서만 테스트 상담원이라는 명시적인 폴백을 사용합니다.
function counselorDisplayName(counselor = {}, caseNo = '', recipientEmail = '') {
  const name = counselor?.name || counselor?.displayName || '';
  if (name.trim()) return name;
  const email = String(counselor?.email || recipientEmail || '').trim().toLowerCase();
  if (email === 'test_talker@test.test' || String(caseNo).startsWith('C-CORE-')) return '테스트 상담원';
  return '미지정';
}

const adminCardUnitsByFilter = {
  consultations: '건',
  activeUsers: '명',
  pendingUsers: '건',
};

function withAdminCardUnit(card) {
  const unit = adminCardUnitsByFilter[card.filter];
  if (!unit || String(card.value).endsWith(unit)) return card;
  return { ...card, value: `${card.value}${unit}` };
}

function counselorReviewFeedbackKey(row = {}) {
  const action = row.reviewAction || {};
  return `${row.caseNo || ''}|${action.status || ''}|${action.reason || ''}`;
}

function CounselorDashboard({ consultations, setConsultations, onCreateConsultation, onRequestLegalReview, onAnalysisSaved, onSaveTranscript, onDeleteConsultation, onOpenConsultationForm, onOpenAnalysis, onOpenDraft, onOpenUpload, onGoToDashboard, activeView, currentUser, onUpdateProfile, notifications, onReadNotifications, onDeleteNotification, onOpenNotification, onNotify, focusedConsultationId, focusedTemplateName, analysisRuns, onStartAnalysis }) {
  const [filter, setFilter] = useState(statusAll);
  const [selectedDate, setSelectedDate] = useState(today);
  const [dismissedFeedbackKeys, setDismissedFeedbackKeys] = useState(() => readStorage(storageKeys.dismissedCounselorReviewFeedback, []));
  const filtered = filter === statusAll ? consultations : consultations.filter((item) => item.status === filter);
  const dateRows = filtered.filter((item) => item.date === selectedDate);
  // '총 상담'을 변호사 대시보드의 같은 자리 카드('전체 검토 요청')와 같은 말('전체')로
  // 맞춰, 두 대시보드가 같은 표 구조를 쓰는데 용어만 다르게 느껴지지 않게 합니다.
  const cards = [
    { title: '전체 상담', value: `${consultations.length}건`, filter: statusAll },
    { title: '진행 중인 상담', value: `${consultations.filter((item) => item.status === '진행 중').length}건`, filter: '진행 중' },
    { title: '완료된 상담', value: `${consultations.filter((item) => item.status === '완료').length}건`, filter: '완료' },
    { title: '보류 상담', value: `${consultations.filter((item) => item.status === '보류').length}건`, filter: '보류' },
  ];
  // 변호사 피드백은 계정을 전환하면 core-api에서 다시 읽은 상담 데이터에 reviewAction이
  // 아직 없을 수 있습니다. 반면 알림은 해당 상담원에게 전달된 결과의 원본이므로, 두 정보를
  // 합쳐 대시보드 이력에서도 추가자료 요청과 서류 검토 완료를 빠짐없이 보여줍니다.
  const reworkRows = useMemo(() => {
    const rowsByFeedback = new Map();
    consultations.filter((item) => item.reviewAction).forEach((item) => {
      const action = item.reviewAction;
      rowsByFeedback.set(`${item.caseNo}|${action.status}|${action.reason || ''}`, item);
    });
    notifications
      .filter((item) => (
        item.roles?.includes('counselor')
        && item.detail?.type === 'reviewFeedback'
        && (!item.recipientEmail || item.recipientEmail === currentUser?.email)
      ))
      .forEach((item) => {
        // 서버 목록이 갱신되기 전이거나 다른 계정에서 생성된 상담이면 매칭이 잠시 없을 수
        // 있습니다. 이 경우에도 변호사 피드백을 숨기지 않고, 알림에 담긴 사건 번호·제목으로
        // 이력 행을 먼저 보여 줍니다. 상담이 로드되면 같은 행에서 바로 처리할 수 있습니다.
        const fallbackTitle = (() => {
          let text = String(item.message || '상담 제목 미확인');
          if (item.target && text.startsWith(item.target)) text = text.slice(String(item.target).length).trim();
          return text.split(' · ')[0].trim() || '상담 제목 미확인';
        })();
        // 사건번호가 예전 방식(예: C-2026-001)으로 알림에 굳어진 뒤 해당 상담이 나중에
        // C-CORE-{id}로 다시 동기화된 경우, 사건번호만으로는 영영 못 찾습니다. 그럴 때는
        // 알림 문구에 들어있던 상담 제목으로 한 번 더 찾아봅니다 — 상담 제목은 알림을 만든
        // 시점의 실제 상담 객체에서 그대로 가져온 값이라, 사건번호가 바뀌어도 안 바뀝니다.
        const matchedConsultation = consultations.find((consultation) => consultation.caseNo === item.target)
          || consultations.find((consultation) => consultation.title && consultation.title === fallbackTitle);
        const feedbackCase = matchedConsultation || {
          id: `feedback-${item.id}`,
          caseNo: item.target || '사건 번호 미확인',
          title: fallbackTitle,
          eligibilityCheck: null,
        };
        const detail = item.detail || {};
        const status = detail.status || item.title || '검토 완료';
        const action = {
          status,
          reason: detail.reason || detail.comment || detail.editedSummary || '변호사 검토 결과를 확인해주세요.',
          reviewer: null,
          requestedAt: item.createdAt || today,
          resolved: status === '서류 검토 완료',
          workbench: item.view === '서식 생성' ? '서식 생성' : '상담 분석',
          formName: detail.formName || '',
          notificationId: item.id,
        };
        const key = `${feedbackCase.caseNo}|${status}|${action.reason}`;
        if (!rowsByFeedback.has(key)) rowsByFeedback.set(key, { ...feedbackCase, reviewAction: action });
      });
    return [...rowsByFeedback.values()]
      .filter((row) => !dismissedFeedbackKeys.includes(counselorReviewFeedbackKey(row)))
      .sort((left, right) => (
        String(right.reviewAction?.requestedAt || '').localeCompare(String(left.reviewAction?.requestedAt || ''))
      ));
  }, [consultations, currentUser?.email, dismissedFeedbackKeys, notifications]);
  const dismissReviewFeedback = (row) => {
    const key = counselorReviewFeedbackKey(row);
    setDismissedFeedbackKeys((keys) => {
      if (keys.includes(key)) return keys;
      const nextKeys = [...keys, key];
      writeStorage(storageKeys.dismissedCounselorReviewFeedback, nextKeys);
      return nextKeys;
    });
  };

  if (activeView !== '대시보드') {
    // onOpenConsultationForm은 UtilityPanel이 '실시간 상담' 화면에서 '상담 자료 업로드'로
    // 넘어가는 다음 단계 링크(onGoToUpload)에도 그대로 재사용합니다. onOpenDraft는 분석이 끝난
    // 직후 추천 서식 패널에서 '이 서식으로 초안 만들기'를 눌렀을 때 서식 생성 화면으로 사건을
    // 그대로 이어서 넘기는 데 씁니다.
    return <UtilityPanel view={activeView} role="counselor" consultations={consultations} onCreateConsultation={onCreateConsultation} onRequestLegalReview={onRequestLegalReview} onAnalysisSaved={onAnalysisSaved} onSaveTranscript={onSaveTranscript} onUpdateConsultation={(id, updates) => setConsultations((items) => items.map((item) => item.id === id ? { ...item, ...updates } : item))} currentUser={currentUser} onUpdateProfile={onUpdateProfile} onGoToDashboard={onGoToDashboard} notifications={notifications} onReadNotifications={onReadNotifications} onDeleteNotification={onDeleteNotification} onOpenNotification={onOpenNotification} onNotify={onNotify} focusedConsultationId={focusedConsultationId} focusedTemplateName={focusedTemplateName} onOpenConsultationForm={onOpenConsultationForm} onOpenAnalysis={onOpenAnalysis} onOpenDraft={onOpenDraft} analysisRuns={analysisRuns} onStartAnalysis={onStartAnalysis} />;
  }
  return (
    <>
      <div className="dashboardIntroWrap">
        <div className="dashboardIntroRow">
          <div className="dashboardIntro">
            <h1><ClipboardList size={22} strokeWidth={2.2} className="dashboardIntroIcon" aria-hidden="true" /> 상담 현황</h1>
          <p>전체 {consultations.length}건 · 변호사 검토 이력 {reworkRows.length}건</p>
          </div>
          {/* '새 상담을 어디서 시작하지'를 찾을 때 가장 먼저 보는 자리는 페이지 제목 줄입니다.
              예전엔 이 버튼이 '보완 요청 상담'(문제 있는 기존 건을 다시 처리하는) 패널 안에
              끼어 있어, 정작 새 상담을 시작하려는 사람은 그 패널을 열어봐야만 찾을 수 있었습니다
              (.dashboardIntroRow는 이 자리에 오른쪽 끝 버튼을 두도록 이미 justify-content:
              space-between으로 설계돼 있었습니다). 가장 자주 쓰는 동작을 제목 줄로 옮깁니다. */}
          <button className="addConsultationButton" type="button" onClick={onOpenConsultationForm}>+ 새 상담 접수</button>
        </div>
      </div>
      <main className="dashboard dashboard-counselor">
        <section className="dashboardLeft">
          <SummaryCards cards={cards} activeFilter={filter} onFilter={setFilter} />
          <ConsultationTable title={filter === statusAll ? '최근 상담 목록' : `${filter} 상담 목록`} rows={filtered} onDelete={onDeleteConsultation} onOpenAnalysis={onOpenAnalysis} searchable />
        </section>
        <section className="dashboardRight">
          <CounselorReworkPanel rows={reworkRows} onOpenAnalysis={onOpenAnalysis} onOpenDraft={onOpenDraft} onOpenUpload={onOpenUpload} onDeleteRow={dismissReviewFeedback} />
          <ConsultationTable title="일정별 상담 목록" rows={dateRows} onOpenAnalysis={onOpenAnalysis} tall selectedDate={selectedDate} onDateChange={setSelectedDate} />
        </section>
      </main>
    </>
  );
}

// 변호사 검토 결정(승인/수정 요청/추가자료 요청/보류/반려) 종류별로 상담원이 실제로 할 수
// 있는 다음 행동이 다릅니다. 전부 "수정 진행"처럼 뭉뚱그리면 뭘 눌러야 문제가 풀리는지
// 알 수 없으므로, 버튼 문구와 이동할 화면을 상태별로 갈라둡니다.
function reworkActionMeta(row) {
  if (String(row.id || '').startsWith('feedback-')) {
    return { label: '상담 정보 확인 중', disabled: true };
  }
  if (row.reviewAction.resolved) {
    return { label: '처리 내용 보기', disabled: false };
  }
  const status = row.reviewAction?.status;
  if (status === '반려') {
    // 법률구조 대상 부적합으로 확정된 결과라 상담원이 더 진행할 수 있는 일이 없습니다.
    // 되돌릴 방법이 없으므로 버튼이 아니라 상태만 보여줍니다.
    return { label: '반려', disabled: true };
  }
  if (status === '추가자료 요청') {
    return { label: '자료 올리기', disabled: false };
  }
  if (status === '보류') {
    // 보류는 변호사가 판단할 근거가 더 필요하다는 뜻이라, 분석 내용을 다시 살펴보고
    // 보완할 부분을 확인하는 상담 분석 화면으로 보냅니다.
    return { label: '재검토하기', disabled: false };
  }
  // '수정 요청'은 무엇을 고쳐야 하는지(서식 문서 vs 상담 분석 내용)에 따라 문구를 갈라줍니다.
  if (row.reviewAction?.workbench === '서식 생성') {
    return { label: '서식 수정하기', disabled: false };
  }
  return { label: '상담 내용 수정', disabled: false };
}

function CounselorReworkPanel({ rows, onOpenAnalysis, onOpenDraft, onOpenUpload, onDeleteRow }) {
  const confirm = useConfirm();
  const openRework = (row) => {
    if (String(row.id || '').startsWith('feedback-')) return;
    const status = row.reviewAction?.status;
    // '반려'는 되돌릴 수 없는 결과라 이동할 곳이 없습니다(버튼도 비활성).
    if (status === '반려') return;
    // '추가자료 요청'은 상담원이 실제로 할 수 있는 일이 증빙자료를 더 올리는 것뿐이므로,
    // 분석 화면이 아니라 바로 상담 자료 올리기로 보냅니다.
    if (status === '추가자료 요청') {
      onOpenUpload?.(row.id);
      return;
    }
    // 문서(서식) 관련 수정 요청은 서식 생성 화면으로, 그 외(상담 내용 수정 요청·보류)는
    // 상담 분석 화면으로 보냅니다.
    if (row.reviewAction?.workbench === '서식 생성') {
      onOpenDraft?.(row.id);
      return;
    }
    onOpenAnalysis?.(row.id);
  };
  const handleDelete = async (row) => {
    const accepted = await confirm({
      title: '검토 이력을 삭제할까요?',
      message: `${row.caseNo} 「${row.title || '상담 제목 없음'}」 이력이 목록에서 숨겨집니다.`,
      confirmLabel: '삭제',
      tone: 'danger',
    });
    if (accepted) onDeleteRow?.(row);
  };

  return (
    <section className="panel reworkPanel">
      <div className="panelTitleRow">
        <h2>변호사 검토 이력</h2>
        <span className="panelCountBadge">{rows.length}건</span>
      </div>
      {rows.length ? (
        <div className="reworkList">
          {rows.map((row) => (
            <article className={`reworkItem${row.reviewAction.resolved ? ' is-resolved' : ''}`} key={`${row.id}-${row.reviewAction.notificationId || row.reviewAction.requestedAt || row.reviewAction.status}`}>
              <div>
                <strong>{row.caseNo} {row.title}</strong>
                <p><span>{row.reviewAction.resolved ? '처리 완료' : row.reviewAction.status}</span>{row.reviewAction.reason || '사유가 입력되지 않았습니다.'}</p>
                {row.reviewAction.formName ? <p className="missingEvidenceLine">보완 서식: {row.reviewAction.formName}</p> : null}
                {row.eligibilityCheck?.isTargetCandidate && !row.eligibilityCheck?.evidenceSubmitted ? (
                  <p className="missingEvidenceLine">미제출 증빙: {row.eligibilityCheck.requiredEvidence}</p>
                ) : null}
              </div>
              <div className="reworkItemActions">
                {(() => {
                  const { label, disabled } = reworkActionMeta(row);
                  return (
                    <button className="tableAction reviewActionButton" type="button" onClick={() => openRework(row)} disabled={disabled}>
                      {label}
                    </button>
                  );
                })()}
                <button className="tableAction danger" type="button" onClick={() => handleDelete(row)} aria-label={`${row.caseNo} 검토 이력 삭제`}><Trash2 size={12} strokeWidth={2.4} />삭제</button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <InlineEmptyNotice>변호사 검토 이력이 없습니다.</InlineEmptyNotice>
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

function LawyerDashboard({ reviews, setReviews, consultations = [], onReviewDecision, onGoToDashboard, activeView, currentUser, onUpdateProfile, notifications, onReadNotifications, onDeleteNotification, onOpenNotification, onNotify, onAnalysisSaved, focusedReviewCaseNo }) {
  const showToast = useToast();
  const [filter, setFilter] = useState(statusAll);
  // 결정 로그는 화면을 다시 열어도 남아야 합니다. 저장 전 버전에서 이미 남긴 결정은
  // 감사 로그를 한 번 읽어 복원해, UI 변경 뒤에 이력이 갑자기 0건이 되지 않게 합니다.
  const [logs, setLogs] = useState(() => {
    const savedLogs = readStorage(storageKeys.reviewDecisionLogs, []);
    if (savedLogs.length) return savedLogs;
    return getAuditLogs()
      .filter((entry) => String(entry.action || '').startsWith('법률구조 검토 결정:'))
      .map((entry) => {
        const status = String(entry.action).replace('법률구조 검토 결정:', '').trim();
        const matchingReview = reviews.find((review) => review.caseNo === entry.target);
        return {
          id: matchingReview?.id || entry.id,
          caseNo: entry.target || '',
          title: entry.metadata?.title || matchingReview?.title || '',
          status,
          reason: entry.metadata?.reason || '',
          loggedAt: entry.createdAt?.slice(0, 10) || today,
        };
      });
  });
  const [activeReview, setActiveReview] = useState(null);
  // review.analysis(긴급도·구조대상 등)는 검토 요청 시점의 스냅샷이라, 그 뒤 상담원이 분석을
  // 다시 저장하면 검토 목록·상세 화면엔 옛 값이 남아 다른 화면(법령·판례 등, 실시간 consultations
  // 기준)과 값이 어긋났습니다. 최신 상담 분석이 있으면 그걸 우선해 목록·상세 모두 같은 값을 보게 합니다.
  const reviewsWithLiveAnalysis = reviews.map((review) => {
    const live = consultations.find((item) => item.id === review.id);
    if (!live?.analysis) return review;
    return {
      ...review,
      urgency: live.analysis.urgency || review.urgency,
      eligibility: live.analysis.eligibility || review.eligibility,
      analysis: { ...review.analysis, ...live.analysis },
    };
  });
  const filtered = filter === statusAll ? reviewsWithLiveAnalysis : reviewsWithLiveAnalysis.filter((item) => item.status === filter);

  // 변호사가 볼 수 있는 사건 후보 전체(coreId 있는 것만). '변호사 검토 요청'(분석 검토, reviews)을
  // 거친 사건뿐 아니라, 상담원이 분석 검토는 안 거치고 서식 초안만 먼저 제출한 사건도 여기 포함해야
  // DocumentReviewQueuePanel과 서식 생성 화면(CasePicker)에서 그 사건을 놓치지 않습니다.
  // (submitCoreDocumentForReview는 requestLegalReview와 무관하게 호출할 수 있어서, reviews에만
  // 의존하면 "분석 검토 요청 없이 서식만 보낸 사건"이 변호사 쪽에서 통째로 안 보이는 문제가 있었습니다)
  const documentReviewCases = buildLawyerDocumentCases(reviews, consultations);
  const handleOpenReview = (row) => {
    // 변호사가 검토 화면을 새로 열 때마다 이전 확인 표시를 이어서 쓰지 않습니다.
    // '검토하기'와 '재검토하기' 모두 해당 사건만 초기화해, 매번 항목을 다시 확인하게 합니다.
    const progress = readStorage(storageKeys.hitlSectionProgress, {});
    const progressKey = String(row.caseNo || row.id || 'unknown');
    if (Object.prototype.hasOwnProperty.call(progress, progressKey)) {
      const nextProgress = { ...progress };
      delete nextProgress[progressKey];
      writeStorage(storageKeys.hitlSectionProgress, nextProgress);
    }
    setActiveReview(row);
  };
  useEffect(() => {
    if (!focusedReviewCaseNo) return;
    const target = documentReviewCases.find((item) => item.caseNo === focusedReviewCaseNo);
    if (target) {
      setFilter(statusAll);
      setActiveReview(target);
    }
  }, [activeView, documentReviewCases, focusedReviewCaseNo]);
  const countByStatus = (status) => reviews.filter((item) => item.status === status).length;
  const waitingCount = countByStatus('검토 대기');
  // 변호사 검토 요청의 범위와 진행 상태를 같은 문맥으로 표시합니다.
  const cards = [
    { title: '전체 검토 요청', value: `${reviews.length}건`, filter: statusAll },
    { title: '법률구조 검토 대기', value: `${waitingCount}건`, filter: '검토 대기' },
    { title: '법률구조 검토 중', value: `${countByStatus('검토 중')}건`, filter: '검토 중' },
    // 카드 이름과 실제 표에 찍히는 상태값('승인')이 서로 다른 말이면, 이 카드를 눌러 걸러본
    // 사람이 표에서는 '완료'가 아니라 '승인'이라고 적힌 걸 보고 헷갈립니다(코치 피드백).
    // 표에 그대로 나오는 값과 같은 말로 맞춥니다.
    { title: '법률구조 검토 승인', value: `${countByStatus('승인')}건`, filter: '승인' },
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
  const decideReview = async (id, status, reason, recipientEmail, editorial = {}) => {
    const { lawyerComment = '', editedSummary = '' } = editorial;
    const target = reviews.find((item) => item.id === id);
    const reviewerInfo = {
      name: currentUser?.name || '변호사',
      email: currentUser?.email || '',
      organization: currentUser?.organization || '',
    };
    const recipient = recipientEmail || target?.counselor?.email || '';
    // 이 동기화가 조용히 빠지거나 실패하면, 화면(로컬)에는 결정이 반영된 것처럼 보이지만
    // 서버 상태(AnalysisReviewStatus)는 그대로 SUBMITTED_FOR_REVIEW에 남습니다. 그러면 상담원이
    // 나중에 자료를 보완해 재검토를 요청할 때 "작성 또는 반려 상태에서만 검토 요청할 수
    // 있습니다"라는, 이 결정 화면과는 전혀 안 이어져 보이는 에러를 받게 됩니다. 원인을 그 자리에서
    // 알 수 있도록, 여기서 실패/누락을 감추지 않고 바로 알립니다.
    if (target?.coreId && target?.coreAnalysisId) {
      try {
        if (status === '승인') {
          await approveCoreAnalysis(target.coreId, target.coreAnalysisId, reason || '', currentUser?.token);
        } else {
          await requestCoreAnalysisRevision(target.coreId, target.coreAnalysisId, reason || '', currentUser?.token);
        }
      } catch (error) {
        console.warn('[법률구조 검토 결정] core-api 동기화 실패, 로컬 처리만 반영합니다:', error.message);
        showToast(`이 결정이 서버에는 반영되지 않았습니다(로컬에만 저장됨). 상담원이 나중에 재검토를 요청할 때 오류가 날 수 있습니다: ${friendlyErrorMessage(error, '서버 연결 실패')}`, 'warn');
      }
    } else if (target?.coreId) {
      // coreId(상담)는 있는데 coreAnalysisId(저장된 분석)가 없는 경우 — 상담원이 "분석 내용
      // 저장"을 누르기 전에 검토가 넘어온 것이라, 서버에 반영할 분석 자체가 없습니다.
      console.warn('[법률구조 검토 결정] coreAnalysisId가 없어 core-api 동기화를 건너뜁니다.');
      showToast('이 사건은 저장된 분석이 없어 서버 상태가 갱신되지 않았습니다(로컬에만 저장됨). 상담원이 나중에 재검토를 요청할 때 오류가 날 수 있습니다.', 'warn');
    }
    setReviews((items) => items.map((item) => item.id === id ? { ...item, status, reason: reason || '', lawyer: reviewerInfo, recipientEmail: recipient } : item));
    onReviewDecision?.({
      id,
      status,
      reason,
      reviewer: reviewerInfo,
      recipientEmail: recipient,
      lawyerComment,
      editedSummary,
    });
    if (target) {
      setLogs((items) => {
        const nextLogs = [{ ...target, status, reason: reason || '', loggedAt: today }, ...items];
        writeStorage(storageKeys.reviewDecisionLogs, nextLogs);
        return nextLogs;
      });
    }
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
        // 카드 안 상태 태그(detail.status)에 실제 결과(승인/추가자료 요청 등)가 이미 뜨므로,
        // 제목에는 같은 문구를 반복하지 않고 알림 종류만 알려줍니다.
        title: '법률구조 검토 결과 도착',
        message: `${target.caseNo} ${target.title} · 변호사 검토 결과를 확인하고 후속 조치를 진행해주세요.`,
        target: target.caseNo,
        recipientEmail: recipient,
        view: '기타',
        detail: {
          type: 'reviewFeedback',
          status,
          reason: reason || '',
          comment: lawyerComment || '',
          editedSummary: editedSummary || '',
        },
      });
    }
    setActiveReview(null);
  };

  if (activeView !== '대시보드' && activeView !== '서식 생성') {
    // 분석 검토 요청(reviews)을 거친 사건뿐 아니라, 서식만 먼저 제출된 사건까지 합쳐둔
    // documentReviewCases를 그대로 넘깁니다. 여기서 빠뜨리면 변호사 쪽 법률·판례 화면에서
    // 그 사건 자체를 CasePicker에서 고를 수 없게 됩니다.
    // onAnalysisSaved: 변호사가 '법령·판례' 화면에서 담은 자료를 분석 행
    // (recommendation_json)에 저장할 때 씁니다. 이 prop이 없으면 화면은 뜨지만
    // 저장 버튼이 동작하지 않습니다 — 상담원 경로에만 연결돼 있었습니다.
    return <UtilityPanel view={activeView} role="lawyer" currentUser={currentUser} onUpdateProfile={onUpdateProfile} consultations={documentReviewCases} onUpdateConsultation={() => {}} onCreateConsultation={() => {}} onGoToDashboard={onGoToDashboard} notifications={notifications} onReadNotifications={onReadNotifications} onDeleteNotification={onDeleteNotification} onOpenNotification={onOpenNotification} onNotify={onNotify} onAnalysisSaved={onAnalysisSaved} />;
  }
  // 법률구조 최종 검토는 다른 업무 화면(실시간 상담 분석·서식 생성 등)과 같은 '화면 전환' 방식입니다.
  // 예전엔 대시보드 위에 반투명 배경 모달로 덮어 띄웠지만, 상단 네비게이션 바가 그대로 보이는
  // 일반 업무 페이지로 통일합니다(위 UtilityPanel 조기 리턴과 같은 규칙).
  if (activeReview) {
    return (
      <HitlReviewPage
        review={activeReview}
        reviewer={currentUser?.name || '변호사'}
        onDecide={decideReview}
        onClose={() => setActiveReview(null)}
      />
    );
  }
  return (
    <>
      {/* 상담원 대시보드의 제목 영역과 완전히 같은 래퍼 구조(dashboardIntroWrap > dashboardIntroRow >
          dashboardIntro)를 씁니다. 이 화면엔 상담원 쪽의 '+ 새 상담 접수' 같은 버튼이 없지만, 껍데기
          구조를 맞춰야 여백·정렬 계산이 완전히 같아져 두 화면의 제목 영역이 위치·크기·모양까지
          그대로 일치합니다. */}
      <div className="dashboardIntroWrap lawyerIntroWrap">
        <div className="dashboardIntroRow">
          <div className="dashboardIntro">
            <h1><ClipboardCheck size={22} strokeWidth={2.2} className="dashboardIntroIcon" aria-hidden="true" /> 검토</h1>
            <p>전체 검토 요청 {reviews.length}건 · 검토 대기 {waitingCount}건</p>
          </div>
        </div>
      </div>
      <main className="dashboard dashboard-lawyer">
      <section className="dashboardLeft">
        <SummaryCards cards={cards} activeFilter={filter} onFilter={setFilter} />
        <ReviewTable
          title={filter === statusAll ? '법률구조 검토 요청 목록' : `${filter} 검토 요청 목록`}
          rows={filtered}
           onOpenReview={handleOpenReview}
          onDelete={(id) => setReviews((items) => items.filter((item) => item.id !== id))}
        />
      </section>
      <section className="dashboardRight">
        <ReviewLog logs={logs} onDelete={(row) => setLogs((items) => {
          const nextLogs = items.filter((item) => !(item.id === row.id && item.status === row.status && item.loggedAt === row.loggedAt));
          writeStorage(storageKeys.reviewDecisionLogs, nextLogs);
          return nextLogs;
        })} />
        <div className="lawyerTopSlot">
          <DocumentReviewQueuePanel candidateCases={documentReviewCases} currentUser={currentUser} onNotify={onNotify} />
        </div>
      </section>
      </main>
    </>
  );
}

// 변호사가 상담원이 보낸 서식 초안을 사건별로 하나씩 열어봐야만 검토할 수 있던 문제를 없앱니다.
// (DraftWorkbench의 서식 검토 패널은 사건 하나를 고른 뒤에만 보입니다 — 대시보드에서는
// 어떤 사건에 검토할 서식이 와 있는지조차 알 수 없었습니다.)
// candidateCases: coreId가 있는 사건 후보 전체입니다(변호사 검토 요청을 거친 사건 + core-api에
// 저장된 상담 중 아직 분석 검토는 안 갔지만 서식만 먼저 검토 요청됐을 수 있는 사건 모두 포함 —
// LawyerDashboard에서 조립해 넘깁니다). 여기서는 그중 실제로 SUBMITTED_FOR_REVIEW 상태인
// 서식만 core-api에서 확인해 추려 보여주고, 그 자리에서 바로 승인/반려할 수 있게 합니다.
function DocumentReviewQueuePanel({ candidateCases, currentUser, onNotify }) {
  const showToast = useToast();
  const confirm = useConfirm();
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [reviewingKey, setReviewingKey] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [pending, setPending] = useState(false);
  // 코치 피드백: "변호사가 코멘트 및 편집할 수 있게끔". 승인/반려 메모와 별개로, 초안 본문
  // 자체를 변호사가 고쳐 쓸 수 있게 합니다. 로컬 전용 문서(ai-api-local 등)는 이 화면이
  // 유일한 저장소라 그대로 덮어써 반영되고, core-api 문서는 실제 HWPX를 다시 만들어주는
  // API가 없어 이 브라우저에 '변호사 수정본'으로만 남겨 상담원 화면에서 참고하게 합니다.
  const [contentDraft, setContentDraft] = useState('');

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
        setDocuments(dedupeDocumentsByForm(filterDismissed(merged)));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseKey]);

  const startReview = (doc) => {
    const key = reviewDocumentKey(doc);
    setReviewingKey(key);
    setNoteText('');
    // 변호사 수정본은 doc.document_id만으로 키를 잡습니다(DraftWorkbench의 사건별 검토 패널과
    // 같은 문서를 같은 값으로 가리켜야, 어느 화면에서 검토하든 서로의 수정본을 이어받습니다).
    setContentDraft(readLawyerDraftEdit(doc.document_id)?.content || doc.draft_content || '');
  };
  const cancelReview = () => {
    setReviewingKey(null);
  };

  // 로컬 큐 항목은 실제로 지우고, 코어 API 항목은 삭제 API가 없어 이 화면에서만 숨깁니다.
  // 브라우저 기본 confirm 팝업은 이 앱의 다른 확인창들과 생김새가 달라 화면이 갑자기 끊겨 보이므로,
  // 같은 스타일을 쓰는 useConfirm으로 통일합니다.
  const deleteDocument = async (doc) => {
    const key = reviewDocumentKey(doc);
    const confirmed = await confirm({
      title: '검토 요청 삭제',
      message: `'${doc.title || doc.caseNo}'의 서류 검토 요청을 목록에서 삭제할까요?`,
      confirmLabel: '삭제',
      tone: 'danger',
    });
    if (!confirmed) return;
    if (doc.source === 'ai-api-local' || doc.source === 'text-local' || doc.source === 'client-hwpx') {
      removeLocalDocumentReview(doc.local_key || doc.document_id);
    }
    dismissDocumentReview(key);
    if (reviewingKey === key) setReviewingKey(null);
    reload();
  };

  const confirmReview = async (doc) => {
    const isLocalDocument = doc.source === 'ai-api-local' || doc.source === 'text-local' || doc.source === 'client-hwpx';
    const contentEdited = contentDraft.trim() !== (doc.draft_content || '').trim();
    setPending(true);
    try {
      if (isLocalDocument) {
        updateLocalDocumentReview(doc.local_key || doc.document_id, {
          status: 'APPROVED',
          review_note: noteText || '',
          requested_materials: [],
          // 로컬 전용 문서는 이 화면이 유일한 저장소라, 변호사가 고친 내용을 그대로 반영합니다.
          ...(contentEdited ? { draft_content: contentDraft } : {}),
        });
      } else {
        // core-api 문서는 서버 원본을 다시 만들어주는 API가 없어, 승인 요청이 실패(예: 권한 없음)
        // 하더라도 변호사가 고친 내용을 이 브라우저에 먼저 남겨 작업이 사라지지 않게 합니다.
        if (contentEdited) saveLawyerDraftEdit(doc.document_id, contentDraft);
        const token = currentUser?.token;
        await approveCoreDocument(doc.coreId, doc.document_id, noteText, token);
      }
      appendAuditLog({
        actor: currentUser?.email || '변호사',
        action: '서류 검토 완료',
        target: doc.caseNo,
        metadata: { formName: doc.form_name, note: noteText || '', contentEdited },
      });
      // 검토 결과를 저장하는 것만으로는 상담원이 놓칠 수 있으므로, 해당 사건의
      // 상담원에게 알림을 보냅니다. 알림의 view와 target을 함께 저장해 클릭하면
      // 서식 생성 화면에서 같은 사건의 제출 서식 상태를 바로 열 수 있습니다.
      onNotify?.({
        roles: 'counselor',
        // 카드 안 상태 태그(detail.status: '서류 검토 완료')와 겹치지 않도록 제목은 종류만 알려줍니다.
        title: '제출 서식 검토 결과 도착',
        message: `${doc.caseNo} ${doc.requested_form_name || doc.form_name || doc.title || '제출 서식'} 검토가 완료되었습니다.${contentEdited ? ' 수정본이 있습니다.' : ''}${noteText.trim() ? ' 검토 메모를 확인해주세요.' : ''}`,
        target: doc.caseNo,
        recipientEmail: doc.counselor?.email || doc.recipientEmail || '',
        view: '서식 생성',
        detail: {
          type: 'reviewFeedback',
          status: '서류 검토 완료',
          reason: '',
          comment: noteText.trim(),
          editedSummary: contentEdited ? '변호사가 서식 본문을 수정했습니다. 파란색 표시를 확인해주세요.' : '',
          formName: doc.requested_form_name || doc.form_name || doc.title || '',
        },
      });
      setReviewingKey(null);
      reload();
    } catch (error) {
      showToast(`검토 처리에 실패했습니다: ${friendlyErrorMessage(error, '잠시 후 다시 시도해 주세요.')}`, 'warn');
    } finally {
      setPending(false);
    }
  };

  // 이 패널은 이미 .lawyerTopSlot .documentReviewQueuePanel(max-height 360px) +
  // .documentReviewList(flex:1, overflow-y:auto)로 칸이 고정되고 넘치면 스크롤되도록
  // 되어 있어서, 다른 표처럼 별도 tableScroll을 씌우지 않아도 같은 동작을 합니다.

  // 이름·사건번호·서식명 기준으로 로컬 검색합니다(ReviewTable과 같은 검색 범위).
  const normalizedQuery = query.trim().toLowerCase();
  const matchedDocuments = normalizedQuery
    ? documents.filter((doc) => [doc.caseNo, doc.title, doc.requested_form_name, doc.form_name].some((value) => (value || '').toLowerCase().includes(normalizedQuery)))
    : documents;
  // ReviewTable(법률구조 검토 요청 목록)과 같은 기준: 긴급도(상→중→하) 먼저, 같은 긴급도
  // 안에서는 오래 기다린 순. 이 패널도 같은 긴급도·경과일 칼럼을 보여주면서 정렬만 안 돼
  // 있었는데, 변호사가 화면을 열자마자 뭐부터 볼지 알 수 있어야 하는 건 서류 검토도 마찬가지입니다.
  const displayDocuments = [...matchedDocuments].sort((left, right) => {
    const rankDiff = (URGENCY_RANK[left.urgency] ?? 3) - (URGENCY_RANK[right.urgency] ?? 3);
    if (rankDiff !== 0) return rankDiff;
    const leftDays = daysWaitingFrom(left.created_at || left.submitted_at || '') ?? 0;
    const rightDays = daysWaitingFrom(right.created_at || right.submitted_at || '') ?? 0;
    return rightDays - leftDays;
  });
  const noSearchResult = Boolean(normalizedQuery) && !displayDocuments.length;
  const reviewingDocument = documents.find((doc) => reviewDocumentKey(doc) === reviewingKey);

  return (
    <section className="panel documentReviewQueuePanel">
      <div className="panelTitleRow">
        <h2><FileText size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 서류 검토 대기</h2>
        <span className="panelCountBadge">{documents.length}건</span>
        <div className="tableSearchBox">
          <Search size={14} strokeWidth={2.2} />
          <input type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="상담번호·제목·서식명 검색" aria-label="서류 검토 대기 검색" />
        </div>
        {loading ? <span className="helperText">불러오는 중…</span> : null}
      </div>
      {noSearchResult ? <InlineEmptyNotice>검색 결과 없음</InlineEmptyNotice> : null}
      {displayDocuments.length ? (
        <div className="documentReviewList">
          <table className="dataTable reviewRequestTable documentReviewTable">
            <colgroup>
              <col style={{ width: '14%' }} />
              <col style={{ width: '30%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '17%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '12%' }} />
            </colgroup>
            <thead><tr><th>상담 번호</th><th>서식 정보</th><th>긴급도</th><th>요청 경과</th><th>검토</th><th>삭제</th></tr></thead>
            <tbody>
              {displayDocuments.map((doc) => {
                const key = reviewDocumentKey(doc);
                // 기존 행 내부 상세 영역은 유지하되 더 이상 열지 않습니다. 표 폭 안에서 편집기가
                // 찌그러지는 문제를 피하기 위해 실제 검토는 아래의 독립 모달에서 진행합니다.
                const isExpanded = false;
                const isReviewing = false;
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
                          <button className="tableAction reviewActionButton" type="button" onClick={() => startReview(doc)}><ClipboardCheck size={13} strokeWidth={2.4} />검토하기</button>
                        </div>
                      </td>
                      <td>
                        <div className="cellBody">
                          <button className="tableAction danger" type="button" onClick={() => deleteDocument(doc)} aria-label="검토 대기 목록에서 삭제"><Trash2 size={12} strokeWidth={2.4} />삭제</button>
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
                            {(() => {
                              const lawyerEdit = readLawyerDraftEdit(doc.document_id);
                              const isLocalOnlyDocument = doc.source === 'ai-api-local' || doc.source === 'text-local' || doc.source === 'client-hwpx';
                              const displayContent = lawyerEdit?.content || doc.draft_content;
                              return (
                                <>
                                  {/* 서버에 반영되지 않는 core-api 문서 수정본은, 편집 중이 아닐 때도 항상 눈에
                                      띄는 노란 캡션으로 남겨 '서버에 반영됐다'고 오해하지 않게 합니다. */}
                                  {lawyerEdit && !isLocalOnlyDocument ? (
                                    <p className="localEditOnlyCaption">로컬 임시 저장됨 · 서버에는 반영되지 않았습니다 (이 브라우저에서만 보입니다)</p>
                                  ) : null}
                                  {isReviewing ? (
                                    <div className="draftView">
                                      <div className="draftViewPane">
                                        <div className="draftViewPaneHeader"><strong>편집</strong></div>
                                        <textarea
                                          className="documentReviewContentEditor"
                                          value={contentDraft}
                                          onChange={(event) => setContentDraft(event.target.value)}
                                          placeholder="서류 내용을 입력하거나 수정하세요."
                                          aria-label="서류 내용 편집"
                                        />
                                      </div>
                                      <div className="draftViewPane">
                                        <div className="draftViewPaneHeader">
                                          <strong>미리보기</strong>
                                          <span className="statusChip tone-info">변호사 수정본</span>
                                        </div>
                                        {contentDraft ? <pre>{contentDraft}</pre> : <p className="helperText">입력 내용 없음</p>}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="documentReviewPreview">
                                      <div className="documentReviewPreviewHeader">
                                        <strong>검토 내용</strong>
                                        {lawyerEdit ? <span className="statusChip tone-warn">변호사 수정본</span> : null}
                                      </div>
                                  {displayContent ? (
                                        <pre>{displayContent}</pre>
                                      ) : doc.draft_file_path ? (
                                        // 서버 로컬 파일 절대경로를 그대로 보여주면 서버 디렉터리 구조가 그대로
                                        // 드러나고 변호사에게도 아무 의미가 없습니다. 파일은 위 GeneratedFileLink의
                                        // 다운로드 버튼으로 이미 받을 수 있으니, 여기는 그 사실만 안내합니다.
                                        <p className="helperText">본문 미리보기를 제공하지 않는 파일입니다. 다운로드 후 원본 서류를 확인해주세요.</p>
                                      ) : (
                                        <p>검토 본문 없음 · 상담원에게 재작성 요청</p>
                                      )}
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                            {isReviewing ? (
                              <div className="documentReviewForm">
                                {doc.source !== 'ai-api-local' && doc.source !== 'text-local' && doc.source !== 'client-hwpx' ? (
                                  <p className="localEditOnlyCaption">서버 문서 · 편집본은 이 화면에 임시 저장됩니다.</p>
                                ) : null}
                                <textarea
                                  value={noteText}
                                  onChange={(event) => setNoteText(event.target.value)}
                                  placeholder="내부 검토 메모 (선택)"
                                  aria-label="내부 검토 메모"
                                />
                                <div className="inlineControls documentReviewActions">
                                  <button className="reviewCancelButton" type="button" onClick={cancelReview} disabled={pending}>취소</button>
                                  <button
                                    className="reviewApproveButton"
                                    type="button"
                                    onClick={() => confirmReview(doc)}
                                    disabled={pending}
                                  >
                                    {pending ? '처리하는 중…' : '검토 완료'}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              // '검토 완료'는 실제로 승인 처리를 확정하는 버튼(618-622줄)의 라벨입니다.
                              // 편집을 시작하는 이 버튼에 같은 문구를 쓰면 눌러도 아무것도 끝나지 않아
                              // 헷갈린다는 피드백을 받아, 지금 하는 일(내용 확인하고 편집 시작)에
                              // 맞는 문구로 구분합니다.
                              <div className="inlineControls documentReviewActions">
                                <button className="reviewApproveButton" type="button" onClick={() => startReview(doc)}>검토하기</button>
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
        !loading && !noSearchResult ? <InlineEmptyNotice>검토 대기 중인 서류가 없습니다.</InlineEmptyNotice> : null
      )}
      {reviewingDocument ? (
        <DocumentReviewModal
          doc={reviewingDocument}
          contentDraft={contentDraft}
          noteText={noteText}
          pending={pending}
          onContentChange={setContentDraft}
          onNoteChange={setNoteText}
          onCancel={cancelReview}
          onConfirm={() => confirmReview(reviewingDocument)}
        />
      ) : null}
    </section>
  );
}

function buildDocumentDiffSegments(originalContent = '', editedContent = '') {
  if (originalContent === editedContent) return [{ text: editedContent, changed: false }];
  const originalTokens = String(originalContent).match(/\s+|[^\s]+/g) || [];
  const editedTokens = String(editedContent).match(/\s+|[^\s]+/g) || [];
  // 법률 초안이 아주 길어도 편집 경험이 느려지지 않도록, 일반적인 화면 초안 범위에서만
  // 단어 단위 비교를 수행합니다. 긴 문서는 현재 본문 전체를 변경된 내용으로 안전하게 표시합니다.
  if (originalTokens.length * editedTokens.length > 360000) return [{ text: editedContent, changed: true }];

  const table = Array.from({ length: originalTokens.length + 1 }, () => new Uint16Array(editedTokens.length + 1));
  for (let originalIndex = originalTokens.length - 1; originalIndex >= 0; originalIndex -= 1) {
    for (let editedIndex = editedTokens.length - 1; editedIndex >= 0; editedIndex -= 1) {
      table[originalIndex][editedIndex] = originalTokens[originalIndex] === editedTokens[editedIndex]
        ? table[originalIndex + 1][editedIndex + 1] + 1
        : Math.max(table[originalIndex + 1][editedIndex], table[originalIndex][editedIndex + 1]);
    }
  }

  const rawSegments = [];
  let originalIndex = 0;
  let editedIndex = 0;
  while (originalIndex < originalTokens.length && editedIndex < editedTokens.length) {
    if (originalTokens[originalIndex] === editedTokens[editedIndex]) {
      rawSegments.push({ text: editedTokens[editedIndex], changed: false });
      originalIndex += 1;
      editedIndex += 1;
    } else if (table[originalIndex + 1][editedIndex] >= table[originalIndex][editedIndex + 1]) {
      originalIndex += 1;
    } else {
      rawSegments.push({ text: editedTokens[editedIndex], changed: true });
      editedIndex += 1;
    }
  }
  while (editedIndex < editedTokens.length) {
    rawSegments.push({ text: editedTokens[editedIndex], changed: true });
    editedIndex += 1;
  }

  return rawSegments.reduce((segments, segment) => {
    const previous = segments.at(-1);
    if (previous && previous.changed === segment.changed) previous.text += segment.text;
    else segments.push(segment);
    return segments;
  }, []);
}

function DocumentDiffPreview({ originalContent, editedContent, scrollRef, onScroll }) {
  return (
    <pre ref={scrollRef} className="documentReviewDiffPreview" onScroll={onScroll}>
      {buildDocumentDiffSegments(originalContent, editedContent).map((segment, index) => (
        segment.changed
          ? <mark className="documentReviewDiffChange" key={`${index}-${segment.text}`}>{segment.text}</mark>
          : <React.Fragment key={`${index}-${segment.text}`}>{segment.text}</React.Fragment>
      ))}
    </pre>
  );
}

function DocumentReviewModal({ doc, contentDraft, noteText, pending, onContentChange, onNoteChange, onCancel, onConfirm }) {
  const reviewTitle = doc.requested_form_name || doc.form_name || '서식 초안';
  const lawyerEdit = readLawyerDraftEdit(doc.document_id);
  const isLocalOnlyDocument = doc.source === 'ai-api-local' || doc.source === 'text-local' || doc.source === 'client-hwpx';
  const revisionCount = doc.revision_count || doc.revisionCount || 0;
  const originalDraftContent = doc.draft_content || '';
  const hasDraftChanges = contentDraft !== originalDraftContent;
  const editorRef = useRef(null);
  const previewRef = useRef(null);
  const isSyncingDraftScrollRef = useRef(false);
  const syncDraftScroll = (source, target) => {
    if (!target || isSyncingDraftScrollRef.current) return;
    isSyncingDraftScrollRef.current = true;
    target.scrollTop = source.scrollTop;
    target.scrollLeft = source.scrollLeft;
    window.requestAnimationFrame(() => { isSyncingDraftScrollRef.current = false; });
  };

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape' && !pending) onCancel(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel, pending]);

  return (
    <div className="modalBackdrop documentReviewModalBackdrop" role="presentation" onClick={() => !pending && onCancel()}>
      <section className="modal documentReviewModal" role="dialog" aria-modal="true" aria-labelledby="document-review-modal-title" onClick={(event) => event.stopPropagation()}>
        <header className="documentReviewModalHeader">
          <div>
            <span className={`statusChip tone-${documentStatusTone(doc.status)} documentReviewModalStatus`}>{DOCUMENT_STATUS_LABEL[doc.status] || doc.status}</span>
            <h2 id="document-review-modal-title">{reviewTitle}</h2>
            <p>{doc.caseNo} · {doc.title}</p>
          </div>
          <button className="documentReviewCloseButton" type="button" onClick={onCancel} disabled={pending} aria-label="검토 창 닫기" title="닫기">
            <X size={18} strokeWidth={2.4} aria-hidden="true" />
            <span>닫기</span>
          </button>
        </header>
        <div className="documentReviewToolbar">초안 내용과 사건 정보를 확인한 뒤 검토 결과를 저장하세요.</div>
        <div className="documentReviewPageGrid">
          <div className="documentReviewPageMain">
            <div className="documentReviewRecipientBox">
              <div className="documentReviewRecipientIcon" aria-hidden="true"><FileText size={18} strokeWidth={2.2} /></div>
              <div className="documentReviewRecipientCopy">
                <strong>서류 검토 결과</strong>
                <span>검토 완료 후 상담원 화면에서 수정본을 확인할 수 있습니다.</span>
              </div>
              <div className="documentReviewModalMeta">
                {revisionCount > 0 ? <span className="statusChip tone-warn">{revisionCount}차 재제출</span> : null}
                <GeneratedFileLink path={doc.draft_file_path} label={`${reviewTitle} 초안 파일`} consultationId={doc.source ? undefined : doc.coreId} documentId={doc.source ? undefined : doc.document_id} content={doc.draft_content} downloadFileName={doc.download_file_name} />
              </div>
            </div>
            <div className="documentReviewNotice"><Info size={16} strokeWidth={2.3} aria-hidden="true" /><span><strong>서식 초안은 참고용입니다.</strong>사건 자료와 상담 내용을 함께 확인한 뒤 수정하세요.</span></div>
            <section className="documentReviewWorkSection">
              <h3><FileText size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 서식 초안 검토</h3>
              {lawyerEdit && !isLocalOnlyDocument ? <p className="localEditOnlyCaption">로컬 임시 저장됨 · 서버에는 반영되지 않았습니다 (이 브라우저에서만 보입니다)</p> : null}
              <div className="documentReviewModalBody documentReviewSplitView">
                <div className="draftViewPane">
                  <div className="draftViewPaneHeader documentReviewPaneHeader">
                    <div className="documentReviewPaneTitle">
                      <span className="documentReviewPaneIcon" aria-hidden="true"><FileEdit size={16} strokeWidth={2.2} /></span>
                      <div className="documentReviewPaneCopy"><strong>서식 내용 편집</strong><span>초안의 사실관계와 청구 취지를 검토해 수정하세요.</span></div>
                    </div>
                    <span className="statusChip tone-info">편집 중</span>
                  </div>
                  <textarea ref={editorRef} className="documentReviewContentEditor" value={contentDraft} onChange={(event) => onContentChange(event.target.value)} onScroll={(event) => syncDraftScroll(event.currentTarget, previewRef.current)} placeholder="서류 내용을 입력하거나 수정하세요." aria-label="서류 내용 편집" />
                </div>
                <div className="draftViewPane documentReviewPreviewPane">
                  <div className="draftViewPaneHeader documentReviewPaneHeader">
                    <div className="documentReviewPaneTitle">
                      <span className="documentReviewPaneIcon" aria-hidden="true"><ClipboardCheck size={16} strokeWidth={2.2} /></span>
                      <div className="documentReviewPaneCopy"><strong>수정본 미리보기</strong><span>저장될 본문을 확인합니다 · 수정한 문구만 강조됩니다.</span></div>
                    </div>
                    <span className={`statusChip ${hasDraftChanges ? 'tone-info' : 'tone-muted'}`}>{hasDraftChanges ? '수정 사항 표시' : '원본과 동일'}</span>
                  </div>
                  {contentDraft ? <DocumentDiffPreview originalContent={originalDraftContent} editedContent={contentDraft} scrollRef={previewRef} onScroll={(event) => syncDraftScroll(event.currentTarget, editorRef.current)} /> : <p className="helperText">입력 내용 없음</p>}
                </div>
              </div>
            </section>
            <section className="documentReviewWorkSection documentReviewNoteSection">
              <h3><MessageSquareText size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 내부 검토 메모 <span>선택</span></h3>
              <div className="documentReviewModalFooter">
                <div className="documentReviewForm">
                  {!isLocalOnlyDocument ? <p className="localEditOnlyCaption">서버 문서 · 검토 완료 시 편집본은 이 브라우저에 저장되며, 서버 원본은 변경되지 않습니다.</p> : null}
                  <textarea value={noteText} onChange={(event) => onNoteChange(event.target.value)} placeholder="예) 상가 담보대출 잔액증명서와 상속인 금융거래조회 결과 확인 후, 한정승인 및 상속재산분할 협의 내용을 보완해 주세요." aria-label="내부 검토 메모" />
                </div>
                <div className="documentReviewCompleteBar">
                  <div className="documentReviewCompleteCopy">
                    <strong>검토를 마칠 준비가 되셨나요?</strong>
                    <span>수정한 서식과 메모는 상담원 검토 화면에서 확인할 수 있습니다.</span>
                  </div>
                  <div className="inlineControls documentReviewActions">
                    <button className="reviewCancelButton" type="button" onClick={onCancel} disabled={pending}>취소</button>
                    <button className="reviewApproveButton" type="button" onClick={onConfirm} disabled={pending}>{pending ? '처리하는 중…' : '검토 완료'}</button>
                  </div>
                </div>
              </div>
            </section>
          </div>
          <aside className="documentReviewPageSide">
            <section className="documentReviewSideCard">
              <h3><FolderOpen size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 사건 요약</h3>
              <dl>
                <div><dt><ClipboardList size={14} strokeWidth={2.1} aria-hidden="true" /> 사건 번호</dt><dd>{doc.caseNo}</dd></div>
                <div><dt><FileText size={14} strokeWidth={2.1} aria-hidden="true" /> 서식 종류</dt><dd>{reviewTitle}</dd></div>
                <div><dt><AlertTriangle size={14} strokeWidth={2.1} aria-hidden="true" /> 긴급도</dt><dd>{doc.urgency || '미확인'}</dd></div>
                <div><dt><Clock size={14} strokeWidth={2.1} aria-hidden="true" /> 검토 상태</dt><dd><span className={`statusChip tone-${documentStatusTone(doc.status)}`}>{DOCUMENT_STATUS_LABEL[doc.status] || doc.status}</span></dd></div>
              </dl>
            </section>
          </aside>
        </div>
      </section>
    </div>
  );
}

// 검토 상태도 상담 상태와 같은 색 기준(statusTone)을 그대로 씁니다. (색상 일관성)
const reviewStatusTone = statusChipClass;

// 검토 상태 칩에 톤과 함께 작은 아이콘도 붙여, HITL 결정 카드·필 로우와 같은 "아이콘+라벨"
// 언어를 검토 표/로그에도 그대로 이어갑니다. 실제 색·판정 기준은 statusChipClass(단일 기준)를
// 그대로 따르고, 여기서는 그 톤 이름에 아이콘만 매핑합니다.
const REVIEW_STATUS_TONE_ICONS = {
  success: CheckCircle2,
  danger: XCircle,
  warn: PauseCircle,
  info: Clock,
  muted: Info,
};
function reviewStatusIcon(status) {
  const tone = reviewStatusTone(status).replace('statusChip tone-', '');
  return REVIEW_STATUS_TONE_ICONS[tone] || Info;
}

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

function ReviewTable({ title = '법률구조 검토 요청 목록', rows, onOpenReview, onDelete }) {
  const [query, setQuery] = useState('');
  const confirm = useConfirm();
  const normalizedQuery = query.trim().toLowerCase();
  const matchedRows = normalizedQuery
    ? rows.filter((row) => [row.caseNo, row.type, row.title, counselorDisplayName(row.counselor, row.caseNo, row.recipientEmail)].some((value) => (value || '').toLowerCase().includes(normalizedQuery)))
    : rows;
  // 긴급도(상→중→하) 순으로 먼저 훑고, 같은 긴급도 안에서는 오래 기다린 요청부터 보이도록 정렬합니다.
  // 변호사가 화면을 열자마자 '지금 뭐부터 봐야 하는지' 바로 알 수 있게 하기 위함입니다.
  const displayRows = [...matchedRows].sort((left, right) => {
    const rankDiff = (URGENCY_RANK[left.urgency] ?? 3) - (URGENCY_RANK[right.urgency] ?? 3);
    if (rankDiff !== 0) return rankDiff;
    return (daysWaitingFrom(right.requestedAt) ?? 0) - (daysWaitingFrom(left.requestedAt) ?? 0);
  });
  const noSearchResult = Boolean(normalizedQuery) && !displayRows.length;
  const columnCount = onDelete ? 7 : 6;
  // '최근 상담 목록'과 같은 규칙: 6칸을 유지하고, 그보다 많으면 칸을 늘리지 않고 스크롤로 봅니다.
  const visibleRowCount = VISIBLE_ROW_COUNT;
  const scrollable = displayRows.length > visibleRowCount;
  const handleDelete = async (row) => {
    if (!onDelete) return;
    const accepted = await confirm({
      title: '이 검토 요청을 삭제할까요?',
      message: `${row.caseNo} · 「${row.title || '제목 없음'}」\n검토 대기 목록에서 삭제됩니다.`,
      confirmLabel: '삭제',
      tone: 'danger',
    });
    if (accepted) onDelete(row.id);
  };

  return (
    <section className="panel reviewRequestPanel">
      <div className="panelTitleRow">
        <h2><ClipboardCheck size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> {title}</h2>
        <span className="panelCountBadge">{rows.length}건</span>
        <div className="tableSearchBox">
          <Search size={14} strokeWidth={2.2} />
          <input type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름·사건번호·제목 검색" aria-label="상담번호·유형·제목·상담원으로 검토 요청 검색" />
        </div>
      </div>
      <div className={scrollable ? 'tableScroll' : ''}>
      <table className="dataTable reviewRequestTable">
        <colgroup>
          <col style={{ width: '14%' }} />
          <col style={{ width: '22%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '15%' }} />
          {/* '추가자료 요청'처럼 긴 상태 문구가 잘리지 않도록 다른 칸보다 넓게 잡습니다. */}
          <col style={{ width: '14%' }} />
          <col style={{ width: '13%' }} />
          {onDelete ? <col style={{ width: '10%' }} /> : null}
        </colgroup>
        <thead><tr><th>상담 번호</th><th>사건 정보</th><th>긴급도</th><th>요청 경과</th><th>상태</th><th>검토</th>{onDelete ? <th>삭제</th> : null}</tr></thead>
        <tbody>
          {noSearchResult ? (
            <tr><td className="tableEmptyNotice" colSpan={columnCount}>검색 결과 없음</td></tr>
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
                    {(() => {
                      const StatusIcon = reviewStatusIcon(row.status);
                      return (
                        <span className={reviewStatusTone(row.status)}><StatusIcon size={12} strokeWidth={2.4} aria-hidden="true" />{row.status}</span>
                      );
                    })()}
                  </div>
                </td>
                {/* HITL: 결정을 바로 누르지 않고 검토 모달을 열어 AI 결과 확인 후 사유와 함께 확정합니다. */}
                <td>
                  <div className="cellBody">
                    <button className="tableAction reviewActionButton" type="button" onClick={() => onOpenReview(row)}><ClipboardCheck size={13} strokeWidth={2.4} />{row.status === '검토 대기' || row.status === '검토 중' ? '검토하기' : '재검토하기'}</button>
                  </div>
                </td>
                {onDelete ? (
                  <td>
                    <div className="cellBody">
                      <button className="tableAction danger" type="button" onClick={() => handleDelete(row)}><Trash2 size={12} strokeWidth={2.4} />삭제</button>
                    </div>
                  </td>
                ) : null}
              </tr>
            );
          })}
          {noSearchResult || scrollable ? null : <EmptyRows count={Math.max(0, visibleRowCount - displayRows.length)} columns={columnCount} isEmpty={rows.length === 0} emptyLabel="검토 요청 없음" />}
        </tbody>
      </table>
      </div>
    </section>
  );
}

// 법률구조 HITL(Human-in-the-loop) 최종 결정 모달.
// AI 분석은 참고용이고, 변호사/공익법무관이 법률 판단 항목을 확인한 뒤 결정과 사유를 확정합니다.
// needsReason은 카드 자체에 작은 "사유 필수" 배지로 보여주므로, 힌트 문장에서는
// 중복으로 적지 않습니다.
const hitlDecisions = [
  { key: '승인', label: '승인', hint: '법률구조 대상으로 확정하고 다음 단계로 진행', tone: 'success', needsReason: false, icon: CheckCircle2 },
  { key: '수정 요청', label: '수정 요청', hint: '상담원에게 서식·내용 수정을 요청', tone: 'warn', needsReason: true, icon: FileEdit },
  { key: '추가자료 요청', label: '추가자료 요청', hint: '판단에 필요한 자료 보완을 요청', tone: 'warn', needsReason: true, icon: FilePlus2 },
  // 순서는 부드러운 결정(주의)에서 강한 결정(위험)으로 이어지도록 둡니다. 예전엔 danger
  // 톤인 '반려'가 warn 톤 '보류'보다 앞에 있어 성공→주의→주의→위험→주의로 중간에 색
  // 강도가 꺾여 보였습니다. 보류를 반려 앞으로 옮겨 성공→주의→주의→주의→위험으로 자연스럽게 이어지게 합니다.
  { key: '보류', label: '보류', hint: '추가 검토가 필요해 결정을 보류', tone: 'warn', needsReason: true, icon: PauseCircle },
  { key: '반려', label: '반려', hint: '구조 대상 부적합으로 거절', tone: 'danger', needsReason: true, icon: XCircle },
];

function formatAnalysisList(items, emptyText) {
  return Array.isArray(items) && items.length ? items : [emptyText];
}

function evidenceDisplayName(item = {}) {
  return item.fileName || item.name || item.fileKey || item.fileUrl || '첨부파일';
}

function evidenceDisplayLocation(item = {}) {
  return item.fileKey || item.fileUrl || item.uploadedUrl || item.storageBucket || '저장 위치 없음';
}

function evidenceOpenUrl(item = {}) {
  if (!item || typeof item !== 'object') return '';
  const value = item.fileUrl || item.uploadedUrl || item.fileKey || '';
  if (/^https?:\/\//i.test(value) || value.startsWith('blob:')) return value;
  if (value.startsWith(`${CORE_API_BASE_URL}/`)) return value;
  if (value.startsWith('/api/')) return `${CORE_API_BASE_URL}${value}`;
  return '';
}

function attachmentMimeType(item = {}, fileName = '', responseType = '') {
  const evidence = `${fileName} ${item.fileType || ''} ${item.mimeType || ''} ${responseType}`.toLowerCase();
  if (/\.pdf(?:\s|$)|application\/pdf/.test(evidence)) return 'application/pdf';
  if (/\.hwpx(?:\s|$)|hwpx/.test(evidence)) return 'application/vnd.hancom.hwpx';
  if (/\.hwp(?:\s|$)|haansofthwp|application\/x-hwp/.test(evidence)) return 'application/x-hwp';
  if (/\.(png)(?:\s|$)|image\/png/.test(evidence)) return 'image/png';
  if (/\.(jpe?g)(?:\s|$)|image\/jpe?g/.test(evidence)) return 'image/jpeg';
  if (/\.(webp)(?:\s|$)|image\/webp/.test(evidence)) return 'image/webp';
  if (/\.(txt|md)(?:\s|$)|text\/plain/.test(evidence)) return 'text/plain;charset=utf-8';
  return responseType.split(';')[0] || 'application/octet-stream';
}

function attachmentDownloadName(fileName = '', mimeType = '') {
  const normalized = String(fileName || '첨부파일').trim().replace(/[\\/:*?"<>|]/g, '_') || '첨부파일';
  if (/\.[a-z0-9]{2,8}$/i.test(normalized)) return normalized;
  if (mimeType === 'application/vnd.hancom.hwpx') return `${normalized}.hwpx`;
  if (mimeType === 'application/x-hwp') return `${normalized}.hwp`;
  if (mimeType === 'application/pdf') return `${normalized}.pdf`;
  if (mimeType === 'image/png') return `${normalized}.png`;
  if (mimeType === 'image/jpeg') return `${normalized}.jpg`;
  if (mimeType === 'image/webp') return `${normalized}.webp`;
  return normalized;
}

function isHancomDocument(item = {}, fileName = '') {
  return /\.hwpx?(?:\s|$)|hwpx|haansofthwp|application\/x-hwp/i.test(`${fileName} ${item.fileType || ''} ${item.mimeType || ''}`);
}

function AttachmentOpenButton({ item, fileName }) {
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState('');
  const url = evidenceOpenUrl(item);
  const isHancomFile = isHancomDocument(item, fileName);

  const openAttachment = async () => {
    setError('');
    if (!url) {
      setError('열 수 있는 파일 주소가 없습니다.');
      return;
    }
    if (!url.startsWith(CORE_API_BASE_URL)) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }

    // core-api 자료는 JWT 인증을 요구합니다. 새 탭을 먼저 열고 인증 헤더가 포함된 요청으로
    // 파일을 받아 연결하면, 주소를 직접 여는 경우의 401 오류 없이 PDF·이미지를 바로 볼 수 있습니다.
    const previewWindow = window.open('', '_blank');
    setIsOpening(true);
    try {
      const response = await fetch(url, { headers: coreAuthHeader() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // 일부 서버는 PDF여도 application/octet-stream과 식별자 파일명만 내려줍니다.
      // 실제 파일명·확장자를 근거로 MIME 타입을 다시 지정하면 브라우저가 내려받기 목록이
      // 아니라 내장 PDF 뷰어에서 문서를 엽니다.
      const bytes = await response.arrayBuffer();
      const mimeType = attachmentMimeType(item, fileName, response.headers.get('content-type') || '');
      const blob = new Blob([bytes], { type: mimeType });
      const objectUrl = URL.createObjectURL(blob);
      const opensInBrowser = mimeType === 'application/pdf' || mimeType.startsWith('image/') || mimeType.startsWith('text/');
      if (opensInBrowser && previewWindow) {
        previewWindow.location.href = objectUrl;
      } else {
        previewWindow?.close();
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = attachmentDownloadName(fileName, mimeType);
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (openError) {
      previewWindow?.close();
      setError(`자료를 열지 못했습니다 (${openError.message}).`);
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <span className="lawyerAttachmentAction">
      <button type="button" onClick={openAttachment} disabled={isOpening}>{isOpening ? '처리 중…' : isHancomFile ? '한글 파일 내려받기' : '자료 열기'}</button>
      {error ? <span className="lawyerAttachmentError" role="alert">{error}</span> : null}
    </span>
  );
}

// 분석 응답에 소분류가 비어 있어도, 검토 중인 서식명은 기존 서식 목록의 정확한 키입니다.
// 그 서식의 사건 소분류를 읽어 변호사에게 이미 알고 있는 정보를 '미입력'으로 보여주지 않습니다.
function reviewCaseSubtype(review, analysis) {
  const formName = review.requested_form_name || review.form_name || review.title || '';
  const matchedTemplate = legalTemplateSeed.find((template) => template.templateName === formName);
  const analysisSubtype = String(analysis?.caseSubtype || '').trim();
  // '상속'처럼 사건 유형과 같은 값은 소분류로 쓰지 않습니다. 서식 목록의 실제 소분류가
  // 더 구체적이므로 상속재산분할협의서라면 '상속재산분할'을 먼저 보여줍니다.
  if (analysisSubtype && analysisSubtype !== matchedTemplate?.caseCategory) return analysisSubtype;
  return matchedTemplate?.caseType || analysisSubtype || review.subtype || resolveConfirmedCaseType({ ...review, analysis }) || '분류 확인 필요';
}

function LawyerReviewBrief({ review, analysis, attachments }) {
  const submittedEvidenceCount = attachments.filter((item) => evidenceDisplayLocation(item) !== '저장 위치 없음').length;
  const urgencyValue = analysis.urgency || review.urgency || '';
  return (
    <div className="lawyerReviewBrief">
      <article>
        <strong><Sparkles size={14} strokeWidth={2.4} className="sectionIcon" aria-hidden="true" /> AI 상담 요약</strong>
        {/* 변호사 피드백: "AI 상담요약은 좀 더 간략하게 한눈에". 여기는 검토를 시작하기 전
            훑어보는 자리라 핵심 두 줄만 먼저 보여주고, 전체 내용은 아래 '상담원 분석 내용'에서
            펼쳐 볼 수 있습니다. */}
        <SummaryBulletList text={analysis.summary || review.memo || review.title} emptyText="상담 요약 없음" maxItems={2} />
      </article>
      <article>
        <strong><ShieldCheck size={14} strokeWidth={2.4} className="sectionIcon" aria-hidden="true" /> 법률구조 검토 신호</strong>
        <dl>
          <div><dt>구조대상</dt><dd>{analysis.eligibility || review.eligibility || '검토 필요'}</dd></div>
          <div>
            <dt>긴급도</dt>
            <dd>{urgencyValue ? <span className={`statusChip tone-${urgencyTone(urgencyValue)}`}>{urgencyValue}</span> : '미확인'}</dd>
          </div>
          <div><dt>증빙자료</dt><dd>{submittedEvidenceCount}건 확인</dd></div>
        </dl>
      </article>
    </div>
  );
}

function fileExtractionLabel(status) {
  const labels = { success: '추출 성공', empty: '내용 없음', unsupported: '미지원', failed: '처리 실패' };
  return labels[status] || status || '상태 미확인';
}

function summarizeExtractionItems(items = []) {
  return items.reduce((summary, item) => {
    summary.total += 1;
    if (item?.status === 'success') summary.success += 1;
    else if (item?.status === 'failed') summary.failed += 1;
    else summary.other += 1;
    return summary;
  }, { total: 0, success: 0, failed: 0, other: 0 });
}

function extractionItemName(item, index) {
  if (item?.fileName || item?.name) return item.fileName || item.name;
  const pathName = String(item?.fileLink || '').split('/').pop()?.split('?')[0];
  return pathName && !pathName.startsWith('attachments') ? pathName : `자료 ${index + 1}`;
}

// 법률구조 최종 검토 화면입니다. 모달이 아니라 대시보드를 대체하는 업무 페이지라서
// 다른 업무 화면과 같은 껍데기(.workspacePage + WorkPageHeader)를 씁니다.
function HitlReviewPage({ review, reviewer, onDecide, onClose }) {
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [privacyTranscriptView, setPrivacyTranscriptView] = useState('masked');
  const [serverMaskedTranscript, setServerMaskedTranscript] = useState('');
  const [isMaskedTranscriptLoading, setIsMaskedTranscriptLoading] = useState(Boolean(review.coreId));
  const [maskedTranscriptError, setMaskedTranscriptError] = useState('');
  const [recipientEmail] = useState(review.counselor?.email || '');
  const [checks, setChecks] = useState({ eligibility: false, evidence: false, hallucination: false });
  const [showFinalHitlConfirm, setShowFinalHitlConfirm] = useState(false);
  const selectedDecision = hitlDecisions.find((item) => item.key === decision);
  const analysis = review.analysis || {};
  const caseSubtype = reviewCaseSubtype(review, analysis);
  // 이전 버전은 재분석 직후 체크를 전부 false로 저장했습니다. 대상 여부·증빙 제출은
  // analysis에 이미 판정값이 있으므로, 과거 요청도 그 두 항목만큼은 화면에서 바로 복원합니다.
  // 승소·집행·타당성은 변호사 판단이 필요한 항목이라 실제로 확인하기 전에는 건드리지 않습니다.
  const reviewChecklist = (analysis.checklist || []).map((item) => {
    if (item.checked) return item;
    if (item.label.includes('대상 여부')) return { ...item, checked: Boolean(analysis.eligibilityCheck) };
    if (item.label.includes('증빙')) return { ...item, checked: Boolean(analysis.eligibilityCheck?.evidenceSubmitted) };
    return item;
  });
  const adoptedItems = formatAnalysisList(analysis.adoptedItems, '상담원이 채택한 검토 반영 항목 없음');
  // 법령·판례 화면에서 담아 저장한 자료(recommendation_json.adopted).
  const adoptedReferences = Array.isArray(analysis.recommendation?.adopted)
    ? analysis.recommendation.adopted
    : [];
  const reviewTranscript = [
    analysis.sttPreview?.original,
    review.memo,
    review.inpersonMemo,
  ].filter(Boolean).join('\n\n');
  const orderedTimelineItems = formatTimelineItems(resolveTimelineForDisplay(analysis, reviewTranscript));
  const extractedItems = formatAnalysisList(analysis.extractionDetail, { status: '', fileLink: '', note: '첨부파일 추출 정보 없음' });
  const attachmentItems = formatAnalysisList(analysis.sourceAttachments?.length ? analysis.sourceAttachments : analysis.extractedJson?.attachment_links, { fileName: '첨부 링크 정보 없음', fileKey: '', fileUrl: '' });
  const modalityItems = formatAnalysisList(analysis.modalities, { key: '입력자료', count: 0 });
  const sttOriginal = analysis.sttPreview?.original || '원문 텍스트 없음';
  const savedMaskedTranscript = analysis.sttPreview?.masked;
  const hasSavedMaskedTranscript = savedMaskedTranscript && savedMaskedTranscript !== '가릴 개인정보가 확인된 상담 내용이 아직 없습니다.';
  // 분석 저장본의 sttPreview는 재분석·새로고침 과정에서 비어 있을 수 있습니다.
  // 검토 화면에서도 상담원 화면과 동일하게 서버가 원문을 즉시 가려 돌려주는 값을 우선 사용합니다.
  useEffect(() => {
    let cancelled = false;
    if (!review.coreId) {
      setIsMaskedTranscriptLoading(false);
      setServerMaskedTranscript('');
      return undefined;
    }

    setIsMaskedTranscriptLoading(true);
    setMaskedTranscriptError('');
    fetchMaskedTranscript(review.coreId)
      .then((text) => {
        if (cancelled) return;
        setServerMaskedTranscript(text || '');
        if (!text && sttOriginal === '원문 텍스트 없음') setMaskedTranscriptError('가림 처리할 상담 내용이 아직 저장되지 않았습니다.');
      })
      .catch(() => {
        if (!cancelled) setMaskedTranscriptError('개인정보 가림본을 불러오지 못했습니다. 잠시 후 다시 열어주세요.');
      })
      .finally(() => { if (!cancelled) setIsMaskedTranscriptLoading(false); });
    return () => { cancelled = true; };
  }, [review.coreId, sttOriginal]);

  // 서버 가림 결과가 없더라도, 원문을 가림 탭에 그대로 노출하지 않습니다.
  //
  // 예전에는 여기서 공용 마스커(maskConsultationText)로 대체 가림본을 만들었는데, 그
  // 결과가 서버 가림과 겹치면서 '[[1]민등록[2]]'처럼 깨진 글이 검토 화면에 올라갔습니다.
  // 그 함수가 주민번호를 '[주민등록번호]'라는 글자로 바꾸고, 그 글자에 서버 가림이 다시
  // 걸려 '주'와 '번호'가 각각 [1], [2]가 된 것입니다. 변호사가 읽는 화면이라 더 나쁩니다.
  //
  // 가림은 서버 한 곳만 합니다. 못 받았으면 못 받았다고 적습니다.
  const sttMasked = serverMaskedTranscript
    || (hasSavedMaskedTranscript ? savedMaskedTranscript : '')
    || '개인정보 가림 텍스트 없음';
  const allChecked = checks.eligibility && checks.evidence && checks.hallucination;
  const trimmedReason = reason.trim();
  const reasonRequired = selectedDecision?.needsReason && !trimmedReason;
  const canSubmit = decision && allChecked && !reasonRequired;
  // 코치 피드백: "변호사가 코멘트 및 편집할 수 있게끔 수정". 반려·수정요청처럼 부정적 결정에만
  // 남기던 '사유'와 별개로, 승인 포함 모든 결정에서 남길 수 있는 코멘트와, AI 요약을 변호사가
  // 직접 다듬을 수 있는 편집 칸을 둡니다.
  const [lawyerComment, setLawyerComment] = useState('');
  const [editedSummary, setEditedSummary] = useState(analysis.summary || '');
  const [isSummaryEditOpen, setIsSummaryEditOpen] = useState(false);
  // 섹션 헤더를 누르면 오른쪽 '검토 항목' 빠른 이동 목록에서 지금 보고 있는 항목이 무엇인지
  // 바로 알 수 있도록 강조합니다.
  const [activeQuickNavId, setActiveQuickNavId] = useState('hitlSectionAnalysis');
  // 실제로 펼쳐서 내용을 확인한 항목을 기록합니다. defaultOpen인 두 항목은 펼친 채로
  // 시작하므로 처음부터 '확인함'으로 봅니다. 나머지는 상담원이 헤더를 눌러 펼쳐야 표시됩니다.
  const hitlProgressKey = String(review.caseNo || review.id || 'unknown');
  const [viewedSectionIds, setViewedSectionIds] = useState(() => {
    const saved = readStorage(storageKeys.hitlSectionProgress, {});
    return new Set(Array.isArray(saved?.[hitlProgressKey]) ? saved[hitlProgressKey] : []);
  });
  const markSectionViewed = (id) => setViewedSectionIds((current) => {
    if (current.has(id)) return current;
    const next = new Set(current).add(id);
    const saved = readStorage(storageKeys.hitlSectionProgress, {});
    writeStorage(storageKeys.hitlSectionProgress, { ...saved, [hitlProgressKey]: [...next] });
    return next;
  });
  // 아코디언 5개(분석 확인~타임라인)를 나열만 해두면 "어느 걸 먼저 봐야 하나" 감이 안 온다는
  // 의견을 받아, 순서를 하나 정해두고 각 섹션 끝에 "확인하고 다음으로" 버튼을 둡니다. 눌러도
  // 새 창을 띄우거나 다른 섹션에 못 가게 막지는 않습니다 — 오른쪽 빠른 이동으로 언제든 건너뛰거나
  // 이미 지나온 섹션을 다시 열어 대조해볼 수 있어야, 검토 중 항목끼리 비교하는 작업이 안 막힙니다.
  const hitlAccordionOrder = ['hitlSectionAnalysis', 'hitlSectionMissing', 'hitlSectionPrivacy', 'hitlSectionEvidence', 'hitlTimelineSection'];
  const [activeAccordionId, setActiveAccordionId] = useState(null);
  const goToNextHitlSection = (currentId) => {
    markSectionViewed(currentId);
    const nextId = hitlAccordionOrder[hitlAccordionOrder.indexOf(currentId) + 1];
    setActiveAccordionId(nextId || null);
    setActiveQuickNavId(nextId || currentId);
    const targetId = nextId || 'hitlSectionFinalCheck';
    // 접힘/펼침 애니메이션(220ms)이 끝나기 전에 스크롤하면 다음 섹션이 아직 제자리로 오지
    // 않은 채로 화면이 멈춰, 눈대중으로 다시 스크롤해야 하는 경우가 있어 애니메이션 뒤로 미룹니다.
    window.setTimeout(() => document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 240);
  };
  const summaryEdited = editedSummary.trim() !== (analysis.summary || '').trim();
  // 확정은 core-api 호출이 끝나야 화면이 넘어갑니다(decideReview가 await 후 setActiveReview(null)).
  // 그동안 아무 표시가 없으면 안 눌린 줄 알고 '검토 확정'을 다시 누르게 되고, 그 사이 첫 요청은
  // 이미 처리되고 있어 승인이 두 번 나갈 수 있습니다. 진행 중임을 버튼에 드러내고 잠급니다.
  const [submitting, setSubmitting] = useState(false);
  const completeDecision = async () => {
    if (submitting) return;
    setSubmitting(true);
    setShowFinalHitlConfirm(false);
    try {
      await onDecide(review.id, decision, trimmedReason, recipientEmail, {
        lawyerComment: lawyerComment.trim(),
        editedSummary: summaryEdited ? editedSummary.trim() : '',
      });
    } finally {
      // 성공하면 이 화면 자체가 사라지지만(setActiveReview(null)), 실패해 남아 있을 때는
      // 다시 시도할 수 있어야 하므로 잠금을 푼다.
      setSubmitting(false);
    }
  };

  return (
    <main className="workspacePage hitlReviewPage">
      {/* 제목과 검토 내용을 별개의 흰 카드 두 장으로 나누면 모서리끼리 어긋나 겹쳐 보인다는
          피드백을 받아, 하나의 카드(.hitlReviewPanel) 안에 제목 · 툴바 · 검토 내용을 모두
          담습니다 — 카드는 이 화면 전체에 하나만 있습니다. */}
      <section className="hitlReviewPanel">
        <div className="workflowIntro hitlWorkflowIntro roleAccent-lawyer">
          <div className="hitlReviewTitleBlock">
            <span className="roleIdentityBadge roleIdentityBadge-lawyer"><Scale size={12} strokeWidth={2.4} aria-hidden="true" /> 검토하기</span>
            <h1>법률구조 최종 검토 <span className="statusChip tone-info">검토 진행중</span></h1>
            <p>{review.caseNo} · {review.type} · {review.title}</p>
          </div>
          <button className="hitlReviewCloseButton hitlReviewHeaderCloseButton" type="button" onClick={onClose} aria-label="검토 화면 닫기">닫기</button>
        </div>
        <div className="hitlReviewToolbar reviewToolbarSticky">
          <span>핵심 내용과 근거를 확인한 뒤 결과를 확정하세요.</span>
        </div>

        {/* 코치 피드백: "배치를 바꿔달라" — 예전엔 사건 정보부터 결정 버튼까지 위에서
            아래로 한 줄로 쭉 이어져, 결정을 내리려면 맨 위 근거를 다시 스크롤해 올라가야
            했습니다. 왼쪽에 근거(사건 정보·요약·자료)를, 오른쪽에 결정(최종 확인 체크·
            승인/반려 선택·확정 버튼)을 좌우로 나눠 스크롤하지 않고 같이 볼 수 있게 합니다. */}
        <div className="hitlReviewGrid">
        <div className="hitlReviewMain">
        {/* 사건 번호·유형·제목은 바로 위 페이지 제목 줄({review.caseNo} · {review.type} ·
            {review.title})과 오른쪽 '사건 요약' 카드에도 나와 있어, 여기 세 번째로 또
            보여주면 같은 정보가 반복돼 산만합니다(코치 피드백). 이 자리는 지웁니다. */}
        <div className="reviewRecipientBox">
          <div className="reviewRecipientSummary">
            <span className="reviewRecipientIcon" aria-hidden="true"><MessageSquareText size={18} strokeWidth={2.4} /></span>
            <div className="reviewRecipientCopy">
              <strong>검토 결과 전달</strong>
              <span>검토를 확정하면 담당 상담원에게 자동으로 전달됩니다.</span>
            </div>
            <div className="reviewRecipientAssignee">
              <span>담당 상담원</span>
              <strong>{counselorDisplayName(review.counselor, review.caseNo, review.recipientEmail)}</strong>
              {(review.counselor?.organization || review.counselor?.email) && (
                <small>{[review.counselor?.organization, review.counselor?.email].filter(Boolean).join(' · ')}</small>
              )}
            </div>
          </div>
        </div>

        {/* AI 분석은 참고용임을 명확히 (HITL 원칙) */}
        <div className="hitlBanner">
          <Info className="hitlBannerIcon" size={16} strokeWidth={2.4} aria-hidden="true" />
          <span>
            <strong>AI 분석은 참고용</strong>
            <small>최종 판단과 결과 확정은 변호사가 직접 진행합니다.</small>
          </span>
        </div>

        {/* 코치 피드백 반영: 한눈에 보기(pinned) → 아코디언 그룹 → 제출 확인(pinned)을
            맨 마지막에 두는 순서로 정리합니다. */}
        <CollapsibleSection className="hitlSection" id="hitlSectionOverview" icon={Sparkles} title="한눈에 보기" pinned onToggle={(nextOpen) => { setActiveQuickNavId('hitlSectionOverview'); if (nextOpen) markSectionViewed('hitlSectionOverview'); }}>
          <LawyerReviewBrief review={review} analysis={analysis} attachments={attachmentItems} />
        </CollapsibleSection>

        <CollapsibleSection className="hitlSection" id="hitlSectionAnalysis" icon={ClipboardList} title="상담 분석 확인" open={activeAccordionId === 'hitlSectionAnalysis'} onToggle={(nextOpen) => { setActiveQuickNavId('hitlSectionAnalysis'); setActiveAccordionId(nextOpen ? 'hitlSectionAnalysis' : null); if (nextOpen) markSectionViewed('hitlSectionAnalysis'); }}>
          <div className="resultCard lawyerAnalysisCard">
            <div className="lawyerAnalysisHeader">
              <strong>검토 요청에 포함된 상담 분석</strong>
              <span>AI 분석 · 보완자료 · 채택 항목</span>
            </div>
            <SummaryBulletList text={analysis.summary || review.summary} emptyText="저장된 분석 요약 없음" maxItems={3} />
            {isSummaryEditOpen || summaryEdited ? (
              <label className="field lawyerSummaryEditField">
                <span className="lawyerSummaryEditLabel">변호사 수정본 {summaryEdited ? <em className="requiredMark">수정됨</em> : null}</span>
                <textarea
                  value={editedSummary}
                  onChange={(event) => setEditedSummary(event.target.value)}
                  placeholder="AI 요약을 변호사 판단에 맞게 직접 다듬을 수 있습니다."
                />
                <span className="lawyerSummaryEditActions">
                  <small className="helperText">확정 시 상담원에게 전달</small>
                  {!summaryEdited ? <button type="button" className="smallButton light" onClick={() => { setEditedSummary(analysis.summary || ''); setIsSummaryEditOpen(false); }}>수정 취소</button> : null}
                </span>
              </label>
            ) : (
              <button type="button" className="smallButton light lawyerSummaryEditButton" onClick={() => setIsSummaryEditOpen(true)}>
                <FileEdit size={14} strokeWidth={2.3} aria-hidden="true" /> 요약 수정
              </button>
            )}
            {/* 긴급도·구조대상은 '한눈에 보기'(법률구조 검토 신호)와 오른쪽 사건 요약 카드에
                이미 나와 있어, 여기서는 그 둘에 없는 사건 유형·소분류만 보여줍니다. */}
            <div className="hitlAnalysisGrid">
              <span>사건 유형: {analysis.caseType || review.type}</span>
              <span>사건 소분류: {caseSubtype}</span>
            </div>
            {/* 예전엔 줄바꿈만 있는 <pre> 원문을 그대로 보여줘서 변호사가 한눈에 훑기 어려웠습니다
                (코치 피드백: 줄글이 아닌 개요 형식으로). 다른 요약 카드와 같은 방식으로 개조식
                불릿 목록으로 보여줍니다. */}
            {analysis.counselorReviewNote ? (
              <div className="counselorReviewNote">
                <SummaryBulletList text={analysis.counselorReviewNote} />
              </div>
            ) : null}
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
          <div className="hitlSectionNextRow">
            <button type="button" className="smallButton light hitlSectionNextButton" onClick={() => goToNextHitlSection('hitlSectionAnalysis')}>
              확인하고 다음으로 <ChevronRight size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection className="hitlSection" id="hitlSectionMissing" icon={AlertTriangle} title="누락 자료와 확인 항목" open={activeAccordionId === 'hitlSectionMissing'} onToggle={(nextOpen) => { setActiveQuickNavId('hitlSectionMissing'); setActiveAccordionId(nextOpen ? 'hitlSectionMissing' : null); if (nextOpen) markSectionViewed('hitlSectionMissing'); }}>
          <div className="resultCard hitlEvidenceGrid">
            <div>
              <strong>누락 자료</strong>
              {analysis.missingInfo?.length ? analysis.missingInfo.map((item) => {
                const submitted = analysis.evidenceStatus?.[item] === 'submitted';
                return (
                  <span key={item} className={`hitlPillRow ${submitted ? 'is-submitted' : 'is-missing'}`}>
                    {submitted ? <CheckCircle2 size={13} strokeWidth={2.4} aria-hidden="true" /> : <XCircle size={13} strokeWidth={2.4} aria-hidden="true" />}
                    {item}
                    <em className="hitlPillState">{analysis.evidenceStatus?.[item] ? (submitted ? '제출 확인' : '미제출') : '확인 대기'}</em>
                  </span>
                );
              }) : <span>아직 받지 못한 자료가 없습니다.</span>}
            </div>
            <div>
              <strong>상담원 확인 항목</strong>
              {reviewChecklist.length ? reviewChecklist.map((item) => (
                <span key={item.label} className={`hitlPillRow ${item.checked ? 'is-submitted' : 'is-missing'}`}>
                  {item.checked ? <CheckSquare size={13} strokeWidth={2.4} aria-hidden="true" /> : <Square size={13} strokeWidth={2.4} aria-hidden="true" />}
                  {item.label}
                  <em className="hitlPillState">{item.checked ? '확인' : '미확인'}</em>
                </span>
              )) : <span>확인할 항목이 없습니다.</span>}
            </div>
          </div>
          <div className="hitlSectionNextRow">
            <button type="button" className="smallButton light hitlSectionNextButton" onClick={() => goToNextHitlSection('hitlSectionMissing')}>
              확인하고 다음으로 <ChevronRight size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection className="hitlSection" id="hitlSectionPrivacy" icon={EyeOff} title="개인정보가 가려진 상담 내용" open={activeAccordionId === 'hitlSectionPrivacy'} onToggle={(nextOpen) => { setActiveQuickNavId('hitlSectionPrivacy'); setActiveAccordionId(nextOpen ? 'hitlSectionPrivacy' : null); if (nextOpen) markSectionViewed('hitlSectionPrivacy'); }}>
          {/* 'STT'·'마스킹'은 개발팀 용어라 변호사에게는 '통화 내용 텍스트'·'개인정보 가림'으로 풀어 씁니다. */}
          <section className="resultCard lawyerSttGrid" aria-label="개인정보 가림 상담 내용 비교">
            <header className="lawyerTranscriptToolbar">
              <div className="lawyerTranscriptTitle">
                <strong>상담 내용 비교</strong>
                <span>가림본을 먼저 확인하고, 필요한 경우에만 원문을 검증하세요.</span>
              </div>
              <div className="lawyerTranscriptTabs" role="tablist" aria-label="상담 내용 보기 방식">
                <button type="button" role="tab" aria-selected={privacyTranscriptView === 'masked'} className={privacyTranscriptView === 'masked' ? 'isActive' : ''} onClick={() => setPrivacyTranscriptView('masked')}>개인정보 가림</button>
                <button type="button" role="tab" aria-selected={privacyTranscriptView === 'original'} className={privacyTranscriptView === 'original' ? 'isActive' : ''} onClick={() => setPrivacyTranscriptView('original')}>원문 확인</button>
              </div>
            </header>
            <article className="lawyerTranscriptReadingPane" role="tabpanel">
              <div className="lawyerTranscriptReadingMeta">
                <strong>{privacyTranscriptView === 'masked' ? '개인정보 가림본' : '원문 검증'}</strong>
                <span>{privacyTranscriptView === 'masked' ? '개인정보가 가려진 상태로 표시됩니다.' : '민감정보가 포함될 수 있으므로 검증 목적으로만 확인합니다.'}</span>
              </div>
              <p className="lawyerTranscriptText">
                {privacyTranscriptView === 'masked'
                  ? (isMaskedTranscriptLoading ? '개인정보 가림본을 불러오는 중입니다.' : sttMasked)
                  : sttOriginal}
              </p>
              {privacyTranscriptView === 'masked' && maskedTranscriptError && !serverMaskedTranscript && sttOriginal === '원문 텍스트 없음' ? <p className="lawyerTranscriptLoadError" role="status">{maskedTranscriptError}</p> : null}
            </article>
          </section>
          <div className="hitlSectionNextRow">
            <button type="button" className="smallButton light hitlSectionNextButton" onClick={() => goToNextHitlSection('hitlSectionPrivacy')}>
              확인하고 다음으로 <ChevronRight size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection className="hitlSection" id="hitlSectionEvidence" icon={Scale} title="검토 근거" open={activeAccordionId === 'hitlSectionEvidence'} onToggle={(nextOpen) => { setActiveQuickNavId('hitlSectionEvidence'); setActiveAccordionId(nextOpen ? 'hitlSectionEvidence' : null); if (nextOpen) markSectionViewed('hitlSectionEvidence'); }}>
          <div className="resultCard lawyerEvidenceBundle">
            {/* 변호사가 '법령·판례' 화면에서 담아 저장한 자료입니다. 그 화면은 검색을
                하러 들어가는 곳이라, 검토 중에 무엇을 근거로 삼았는지 확인하려면
                여기 사건 화면에 같이 보여야 합니다. */}
            <div>
              <strong>검토한 법령·판례</strong>
              {adoptedReferences.length
                ? adoptedReferences.map((item) => (
                  <span key={item.id}>
                    [{referenceTypeLabel(item.type)}] {item.title}
                    {item.reason ? ` · ${item.reason}` : ''}
                  </span>
                ))
                : <span>담아둔 법령·판례 없음</span>}
            </div>
            <div>
              <strong>상담원 채택 항목</strong>
              {adoptedItems.map((item) => <span key={typeof item === 'string' ? item : item.text}>{typeof item === 'string' ? item : item.text}</span>)}
            </div>
            <div>
              <strong>받은 자료</strong>
              {modalityItems.map((item) => <span key={item.key}>{item.key}: {item.count}건</span>)}
            </div>
            <div>
              <strong>자료 읽기 결과</strong>
              {extractedItems.length ? (() => {
                const extractionSummary = summarizeExtractionItems(extractedItems);
                return (
                  <div className="lawyerExtractionSummary">
                    <div className="extractionResultStats" aria-label="자료 읽기 요약">
                      <span className="extractSummaryChip tone-success">추출 완료 <strong>{extractionSummary.success}건</strong></span>
                      {extractionSummary.failed > 0 ? <span className="extractSummaryChip tone-danger">처리 실패 <strong>{extractionSummary.failed}건</strong></span> : null}
                      {extractionSummary.other > 0 ? <span className="extractSummaryChip tone-muted">확인 필요 <strong>{extractionSummary.other}건</strong></span> : null}
                      <span className="extractionResultTotal">총 {extractionSummary.total}건</span>
                    </div>
                    <details className="extractionResultDetails">
                      <summary><ChevronRight size={15} aria-hidden="true" />상세 결과 보기</summary>
                      <div className="extractionResultList">
                        {extractedItems.map((item, index) => (
                          <div key={`${item.fileLink || item.note || index}-${index}`} className={`extractDetailRow status-${item.status}`}>
                            <span className="extractDetailStatus">{fileExtractionLabel(item.status)}</span>
                            <span className="extractDetailName">{extractionItemName(item, index)}</span>
                            {item.note ? <span className="extractDetailNote">{item.note}</span> : null}
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                );
              })() : <span>첨부파일 추출 정보 없음</span>}
            </div>
            <div className="lawyerAttachmentList">
              <strong>첨부 자료</strong>
              <span className="lawyerAttachmentListHint">자료 열기를 눌러 원문을 확인할 수 있습니다.</span>
              {attachmentItems.map((item, index) => {
                const location = evidenceDisplayLocation(item);
                return (
                  <div className="lawyerAttachmentItem" key={`${location}-${index}`}>
                    <div className="lawyerAttachmentMeta">
                      <span className="lawyerAttachmentName"><FileText size={14} strokeWidth={2.2} aria-hidden="true" /> {evidenceDisplayName(item)}</span>
                      <span className="lawyerAttachmentPath">{location}</span>
                    </div>
                    <AttachmentOpenButton item={item} fileName={evidenceDisplayName(item)} />
                  </div>
                );
              })}
            </div>
            <div>
              <strong>AI 응답 검증</strong>
              <span title="필수 항목과 데이터 형식이 화면 표시 규칙에 맞는지 확인합니다.">형식: {analysis.verification?.formatLabel || '검증 미실행'}</span>
              <span title="상담 원문·첨부자료와 분석 요약의 단어가 충분히 연결되는지 참고로 확인합니다.">근거: {analysis.verification?.evidenceLabel || '검증 미실행'}</span>
              <span title="환각 위험은 자동 경고일 뿐이며, 최종 판단은 변호사가 사실관계를 직접 확인합니다.">환각 위험: {analysis.verification?.riskLabel || '검증 미실행'}</span>
              <small className="verificationHelperText">자동 참고 점검 · 최종 판단은 담당자가 확인합니다.</small>
            </div>
          </div>
          <div className="hitlSectionNextRow">
            <button type="button" className="smallButton light hitlSectionNextButton" onClick={() => goToNextHitlSection('hitlSectionEvidence')}>
              확인하고 다음으로 <ChevronRight size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection className="hitlSection" id="hitlTimelineSection" icon={Clock} title="사실관계 타임라인" open={activeAccordionId === 'hitlTimelineSection'} onToggle={(nextOpen) => { setActiveQuickNavId('hitlTimelineSection'); setActiveAccordionId(nextOpen ? 'hitlTimelineSection' : null); if (nextOpen) markSectionViewed('hitlTimelineSection'); }}>
          <ol className="resultCard lawyerTimeline" aria-label="사실관계 진행 순서">
            {/* ai-api가 만드는 timeline_json 항목은 {날짜, 내용} 키를 씁니다
                (backend/ai-api/app/schemas/analysis.py의 TimelineItem).
                예전엔 마지막 폴백이 `item` 자체여서, 변환을 안 거친 항목이 하나라도 있으면
                React가 객체를 자식으로 받고 이 화면 전체가 흰 화면이 됐습니다.
                timeline_json은 원래 항상 null이라 티가 안 나다가, 파이프라인이 이 필드를
                채우기 시작하면서 드러났습니다. 두 가지 키를 모두 받고, 객체는 절대 그리지 않습니다. */}
            {orderedTimelineItems.length ? orderedTimelineItems.map((item, index) => {
              return (
                <li key={`${item.date}-${item.index}`}>
                  <span className="lawyerTimelineMarker" aria-label={`타임라인 ${index + 1}번`}>{index + 1}</span>
                  <time dateTime={Number.isFinite(item.timestamp) ? new Date(item.timestamp).toISOString().slice(0, 10) : undefined}>{item.date}</time>
                  <p>{item.text || '기록 내용 없음'}</p>
                </li>
              );
            }) : <li className="emptyTimelineNotice">확인된 타임라인 자료가 없습니다.</li>}
          </ol>
          <div className="hitlSectionNextRow">
            <button type="button" className="smallButton light hitlSectionNextButton" onClick={() => goToNextHitlSection('hitlTimelineSection')}>
              확인하고 제출 확인으로 <ChevronRight size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
        </CollapsibleSection>

        {/* 최종 결정 전 반드시 체크해야 하는 섹션이라 항상 펼쳐둡니다(pinned). 아코디언
            그룹 다음, 맨 마지막에 둬서 검토를 다 훑은 뒤 확인하는 흐름에 맞춥니다. */}
        <CollapsibleSection className="hitlSection" id="hitlSectionFinalCheck" icon={ShieldCheck} title="제출 확인" pinned onToggle={(nextOpen) => { setActiveQuickNavId('hitlSectionFinalCheck'); if (nextOpen) markSectionViewed('hitlSectionFinalCheck'); }}>
          {/* 세 번째 항목은 원래 "법령·판례 근거의 실재 여부를 확인했습니다"였다.
              LLM이 없는 판례를 지어내는 것을 막으려는 문구인데, 우리 시스템에는
              맞지 않는다 - 법령·판례는 실제 색인(조문 2,258개, 판례 342건)에서
              검색해 온 것만 내보내므로 존재는 검색 단계에서 이미 보장된다.
              남는 위험은 다른 쪽이다. 판례는 진짜인데 AI가 붙인 근거 문구가 그
              판례 내용과 다를 수 있다. 변호사가 실제로 봐야 할 것이 그것이라,
              확인할 수 없는 것 대신 확인해야 할 것을 묻는다. */}
          <div className="resultCard checklistBox hitlFinalChecklist">
            {[
              { key: 'eligibility', text: '법률구조 대상 요건을 확인했습니다.' },
              { key: 'evidence', text: '제출된 자료·증빙을 확인했습니다.' },
              { key: 'hallucination', text: 'AI가 붙인 근거 설명이 법령·판례 내용과 맞는지 확인했습니다.' },
            ].map((row) => (
              <label key={row.key} className={`hitlFinalCheckItem${checks[row.key] ? ' is-checked' : ''}`}>
                <input type="checkbox" checked={checks[row.key]} onChange={() => setChecks((c) => ({ ...c, [row.key]: !c[row.key] }))} />
                {checks[row.key] ? <CheckSquare size={16} strokeWidth={2.4} aria-hidden="true" /> : <Square size={16} strokeWidth={2.4} aria-hidden="true" />}
                <span>{row.text}</span>
                <em className={`statusChip ${checks[row.key] ? 'tone-success' : 'tone-muted'}`}>{checks[row.key] ? '확인됨' : '미확인'}</em>
              </label>
            ))}
          </div>
        </CollapsibleSection>

        </div>

        {/* 코치 피드백: "결과 선택을 오른쪽 말고 아래쪽에 배치". 좁은 오른쪽 레일에 결정 카드
            5개를 세로로 쌓아두니 답답해 보인다는 의견을 받아, 결정 UI는 페이지 하단에
            전체 폭으로 옮겨 카드를 가로로 넉넉하게 펼칩니다. 대신 오른쪽 레일은 긴 검토
            흐름을 스크롤하는 동안에도 사건 핵심 정보와 지금 어디를 보고 있는지를 계속
            보여주는 '요약 + 빠른 이동' 자리로 씁니다. */}
        <div className="hitlReviewSide">
          <div className="hitlSection hitlCaseSummaryCard">
            <h3><FolderOpen size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 사건 요약</h3>
            <dl className="hitlCaseSummaryList">
              <div><dt>사건 번호</dt><dd>{review.caseNo}</dd></div>
              <div><dt>사건 유형</dt><dd>{analysis.caseType || review.type}</dd></div>
              <div>
                <dt>긴급도</dt>
                <dd>
                  {(() => {
                    const level = analysis.urgency || review.urgency || '';
                    const tone = { 상: 'danger', 중: 'warn', 하: 'success' }[level] || 'muted';
                    return level ? <span className={`statusChip tone-${tone}`}>{level}</span> : '미확인';
                  })()}
                </dd>
              </div>
              <div><dt>구조대상</dt><dd>{analysis.eligibility || review.eligibility || '검토 필요'}</dd></div>
              <div><dt>담당 상담원</dt><dd>{counselorDisplayName(review.counselor, review.caseNo, review.recipientEmail)}</dd></div>
            </dl>
          </div>

          <nav className="hitlSection hitlQuickNav" aria-label="검토 항목 빠른 이동">
            <h3><ListChecks size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 검토 항목</h3>
            <div className="hitlQuickNavList">
              {[
                { id: 'hitlSectionAnalysis', label: '상담 분석 확인', icon: ClipboardList },
                { id: 'hitlSectionMissing', label: '누락 자료와 확인 항목', icon: AlertTriangle },
                { id: 'hitlSectionPrivacy', label: '개인정보가 가려진 상담 내용', icon: EyeOff },
                { id: 'hitlSectionEvidence', label: '검토 근거', icon: Scale },
                { id: 'hitlTimelineSection', label: '사실관계 타임라인', icon: Clock },
              ].map((item) => {
                const NavIcon = item.icon;
                // 우측 목록에는 접어서 확인하는 중간 검토 항목만 남깁니다. 실제로 열어본
                // 항목은 체크 배지로 표시해 검토 진행 상태를 바로 알 수 있게 합니다.
                const isActive = item.id === activeQuickNavId;
                const isViewed = viewedSectionIds.has(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`hitlQuickNavItem${isActive ? ' is-active' : ''}${isViewed ? ' is-viewed' : ''}`}
                    onClick={() => { setActiveQuickNavId(item.id); markSectionViewed(item.id); document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                  >
                    <NavIcon size={14} strokeWidth={2.2} aria-hidden="true" />
                    <span>{item.label}</span>
                    {isViewed ? (
                      <em className="hitlQuickNavBadge is-complete">
                        <CheckCircle2 size={12} strokeWidth={2.4} aria-hidden="true" />
                      </em>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </nav>
        </div>
        </div>

        <div className="hitlSection hitlDecisionSection">
          <h3><ListChecks size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 결과 선택</h3>
          <div className="hitlDecisionGrid hitlDecisionGridBottom">
            {hitlDecisions.map((item) => {
              const DecisionIcon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`hitlDecisionCard tone-${item.tone}${decision === item.key ? ' selected' : ''}`}
                  onClick={() => setDecision(item.key)}
                >
                  <span className="hitlDecisionCardHead">
                    <DecisionIcon size={17} strokeWidth={2.2} className="hitlDecisionCardIcon" aria-hidden="true" />
                    <strong>{item.label}</strong>
                  </span>
                  <span className="hitlDecisionCardMeta">
                    <small>{item.hint}</small>
                    {item.needsReason ? <em className="hitlReasonRequiredBadge">사유 필수</em> : null}
                    {decision === item.key ? <em className="hitlDecisionSelectedBadge">선택됨</em> : null}
                  </span>
                </button>
              );
            })}
          </div>

          {decision ? (
            <div className="hitlDecisionWorkspace">
              <div className={`hitlDecisionWorkspaceHeader tone-${selectedDecision?.tone || 'info'}`}>
                <span>선택한 검토 결과</span>
                <strong>{selectedDecision?.label}</strong>
                <small>{selectedDecision?.hint}</small>
              </div>
              {selectedDecision?.needsReason ? (
                <label className="field">
                  <span>사유 <strong className="requiredMark">필수</strong></span>
                  <textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="상담원이 바로 보완할 수 있도록 필요한 자료나 수정 내용을 적어주세요." />
                </label>
              ) : null}
              <label className="field hitlCommentField">
                <span>상담원 전달 메모 <em>선택</em></span>
                <textarea value={lawyerComment} onChange={(event) => setLawyerComment(event.target.value)} placeholder="추가 안내가 있으면 적어주세요." />
              </label>
            </div>
          ) : <p className="hitlDecisionSelectionHint">결과를 먼저 선택하면, 필요한 입력과 확정 단계가 이곳에 표시됩니다.</p>}

          {reasonRequired ? <p className="formError">{decision} 결정에는 사유 입력이 필요합니다.</p> : null}
          {decision && !allChecked ? <p className="formError">법률 판단 항목을 모두 확인해야 결정을 확정할 수 있습니다.</p> : null}

          <div className="inlineControls statusConfirmActions">
            <p className="hitlDecisionActionHint">
              {decision ? <><strong>{decision}</strong> 결과를 확정합니다. 확정 후에는 변경할 수 없습니다.</> : '결과를 선택한 뒤 검토 결과를 확정하세요.'}
              <small>결정자 {reviewer}</small>
            </p>
            <div className="hitlDecisionActionButtons">
              <button className="smallButton light" type="button" onClick={onClose}>취소</button>
              <button className="primaryButton hitlSubmitButton" type="button" disabled={!canSubmit} onClick={() => setShowFinalHitlConfirm(true)}>검토 결과 확정</button>
            </div>
          </div>
        </div>
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
      </section>
    </main>
  );
}

function ReviewLog({ logs, onDelete }) {
  const confirm = useConfirm();
  const handleDelete = async (row) => {
    if (!onDelete) return;
    const accepted = await confirm({
      title: '이 결정 로그를 삭제할까요?',
      message: `R-${row.id} · ${row.caseNo} 「${row.title || '제목 없음'}」\n목록에서 삭제됩니다.`,
      confirmLabel: '삭제',
      tone: 'danger',
    });
    if (accepted) onDelete(row);
  };
  // 최근 이력은 사건 제목과 사유처럼 길이가 다른 정보가 한데 섞입니다. 고정 폭 표에서는
  // 제목·사유가 낱말 단위로 잘려 읽기 어려우므로, 한 건씩 읽는 목록형으로 보여줍니다.
  // 한 건은 전부 보이고, 두 건부터는 패널 높이를 고정해 같은 자리에서 이력을
  // 스크롤로 훑습니다. 대시보드 우측 열이 아래 카드에 밀려 잘리는 것을 막습니다.
  const scrollable = logs.length > 1;
  return (
    <section className="panel recentDecisionLogPanel">
      <div className="panelTitleRow">
        <h2><ListChecks size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 최근 검토 결정 로그</h2>
        <span className="panelCountBadge">{logs.length}건</span>
      </div>
      {logs.length ? (
        <div className={`decisionLogList${scrollable ? ' is-scrollable' : ''}`} aria-label="최근 검토 결정 이력">
          {logs.map((row) => {
            const StatusIcon = reviewStatusIcon(row.status);
            return (
              <article className="decisionLogItem" key={`${row.id}-${row.status}-${row.loggedAt}`}>
                <div className="decisionLogItemHeader">
                  <div className="decisionLogIdentity">
                    <strong>{row.title || '상담 제목 없음'}</strong>
                    <span>R-{row.id} · {row.caseNo || '사건 번호 없음'} · {row.loggedAt || '처리일 미확인'}</span>
                  </div>
                  <div className="decisionLogActions">
                    <span className={reviewStatusTone(row.status)}><StatusIcon size={12} strokeWidth={2.4} aria-hidden="true" />{row.status}</span>
                    {onDelete ? <button className="tableAction danger" type="button" onClick={() => handleDelete(row)} aria-label={`R-${row.id} 검토 로그 삭제`}><Trash2 size={12} strokeWidth={2.4} />삭제</button> : null}
                  </div>
                </div>
                <p className="decisionLogReason"><span>사유</span>{row.reason || '사유 없음'}</p>
              </article>
            );
          })}
        </div>
      ) : <InlineEmptyNotice>검토 결정 이력 없음</InlineEmptyNotice>}
    </section>
  );
}

const roleLabels = { counselor: '상담원', lawyer: '변호사', admin: '관리자' };

function AdminDashboard({ users, onUpdateUserStatus, consultations, reviews, activeView, currentUser, onUpdateProfile, notifications, onReadNotifications, onDeleteNotification, onOpenNotification, focusedAdminView }) {
  const [activeAdminView, setActiveAdminView] = useState('consultations');
  const showToast = useToast();
  const [serverUsers, setServerUsers] = useState(null);
  const [userListRefreshKey, setUserListRefreshKey] = useState(0);
  // 알림의 '바로 처리'로 들어온 경우, 요약 카드를 다시 눌러 필터를 바꿀 필요 없이 해당 목록(예:
  // 회원가입 승인 대기)이 바로 보이게 맞춰줍니다.
  useEffect(() => {
    if (focusedAdminView) setActiveAdminView(focusedAdminView);
  }, [focusedAdminView]);
  useEffect(() => {
    let cancelled = false;
    fetchCoreUsers(currentUser?.token)
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        setServerUsers(rows.map(mapCoreUserToLocal));
      })
      .catch(() => { if (!cancelled) setServerUsers(null); });
    return () => { cancelled = true; };
  }, [currentUser?.token, userListRefreshKey]);
  // 관리자 자신을 포함해 전체 회원가입 신청자를 대상으로 승인 현황을 관리합니다.
  const userRows = serverUsers || users;
  const userFilter = activeAdminView === 'pendingUsers' ? '대기' : activeAdminView === 'activeUsers' ? '승인' : statusAll;
  const filteredUsers = userFilter === statusAll ? userRows : userRows.filter((item) => item.status === userFilter);
  // onUpdateUserStatus는 core-api 승인/거절 호출이 실패하면 성공한 것처럼 화면을 바꾸지 않고
  // { ok: false, message } 를 돌려줍니다. 실패 이유(대개는 "테스트용 빠른 로그인"이라 관리자
  // 토큰이 없어서 403)를 토스트로 보여줘야, 화면에서는 승인됐는데 실제 로그인은 계속 막히는
  // 상황(화면과 DB가 어긋난 상태)을 admin이 바로 알아챌 수 있습니다.
  const handleUpdateUserStatus = async (row, status) => {
    const result = await onUpdateUserStatus(row?.email, status, row?.backendId);
    if (result?.ok === false) {
      showToast(result.message || `계정 ${status} 처리에 실패했습니다.`, 'warn');
      return;
    }
    showToast(`${row?.name || row?.email || '계정'} · ${status} 처리했습니다.`, 'success');
    setUserListRefreshKey((key) => key + 1);
  };

  // GET /api/admin/stats(신규): 요약 카드 4개를 로컬 배열(users/consultations/reviews)로 어림잡아 계산하는
  // 대신, 실제 DB 집계값을 그대로 받아 씁니다. core-api 연결 전이거나 호출 실패 시에는 기존 로컬 계산으로
  // 자연스럽게 폴백합니다(화면이 빈 값으로 깨지지 않도록).
  const [adminStats, setAdminStats] = useState(null);
  // /api/admin/stats는 ADMIN 토큰이 있어야 하는데, "테스트용 빠른 로그인"은 실제 백엔드 로그인을
  // 거치지 않아 토큰이 없습니다(currentUser.token === undefined) — 이 경우 항상 403이 나서 로컬
  // 계산으로 폴백합니다. 그 사실을 화면에서도 알 수 있게 실패 여부를 별도로 기억해둡니다.
  const [adminStatsFailed, setAdminStatsFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchCoreAdminStats(currentUser?.token)
      .then((stats) => { if (!cancelled) { setAdminStats(stats); setAdminStatsFailed(false); } })
      .catch(() => { if (!cancelled) { setAdminStats(null); setAdminStatsFailed(true); } });
    return () => { cancelled = true; };
  }, [currentUser?.token]);

  const localAnalysisRate = reviews.length ? Math.round((reviews.filter((item) => item.status === '승인').length / reviews.length) * 100) : 0;
  const pendingApprovals = adminStats ? adminStats.pending_user_approvals : userRows.filter((item) => item.status === '대기').length;
  // KPI 타일에는 단위 없이 숫자만 둡니다(시안 기준). 무엇을 센 값인지는 아래 라벨이 말해 줍니다.
  const cards = [
    { title: '전체 상담 건수', value: `${adminStats ? adminStats.total_consultations : consultations.length}`, filter: 'consultations' },
    { title: '활성 사용자', value: `${adminStats ? adminStats.active_users : userRows.filter((item) => item.status === '승인').length}`, filter: 'activeUsers' },
    { title: '분석 처리율', value: `${adminStats ? Math.round(adminStats.analysis_processing_rate * 100) : localAnalysisRate}%`, filter: 'analysis' },
    { title: '직원 승인 대기', value: `${pendingApprovals}`, filter: 'pendingUsers' },
  ];

  // 관리자 업무 범위(전체 조회/계정 권한 관리/통계 대시보드/DB 관리/감사로그)에는
  // 상담 등록이나 서식 초안 생성이 포함되지 않으므로, 그 메뉴들은 관리자 네비게이션에서 아예 제외했습니다.
  // (상담원/변호사 전용 워크벤치가 실수로라도 노출되지 않도록 여기서도 대시보드/프로필/운영관리/알림 4가지만 분기합니다.)
  if (activeView === '프로필') return <UtilityPanel view={activeView} role="admin" currentUser={currentUser} onUpdateProfile={onUpdateProfile} />;
  if (activeView === '기타') return <AdminOpsPanel currentUser={currentUser} />;
  if (activeView === '알림') return <UtilityPanel view={activeView} role="admin" currentUser={currentUser} notifications={notifications} onReadNotifications={onReadNotifications} onDeleteNotification={onDeleteNotification} onOpenNotification={onOpenNotification} />;
  return (
    <>
      <div className="dashboardIntroWrap">
        <div className="dashboardIntro">
          <h1><LayoutDashboard size={22} strokeWidth={2.2} className="dashboardIntroIcon" aria-hidden="true" /> 운영 현황</h1>
          <p>가입 승인 대기 {pendingApprovals}건 · 상담/분석 운영 상태</p>
        </div>
      </div>
      <main className="dashboard dashboard-admin">
      {adminStatsFailed ? (
        <p className="adminStatsNotice">
          {currentUser?.token
            ? 'DB 통계 연결 실패 · 브라우저 임시 데이터 표시'
            : '테스트 로그인 중 · DB 통계 대신 브라우저 임시 데이터 표시'}
        </p>
      ) : null}
      <SummaryCards cards={cards.map(withAdminCardUnit)} activeFilter={activeAdminView} onFilter={setActiveAdminView} allowToggle={false} />
      {/* 시안: 왼쪽은 주간 상담 현황, 오른쪽은 '사건 유형별 상담 통계'와 '분석 처리 현황'을 위아래로 둡니다. */}
      {activeAdminView === 'consultations' ? (
        <div className="adminSplit">
          <ConsultationStatsPanel consultations={consultations} />
          <div className="adminSplitStack">
            <BarChartMock consultations={consultations} serverStats={adminStats} />
            <DonutChartMock reviews={reviews} serverStats={adminStats} />
          </div>
        </div>
      ) : null}
      {activeAdminView === 'analysis' ? (
        <div className="adminSplit">
          <AnalysisStatsPanel reviews={reviews} />
          <DonutChartMock reviews={reviews} serverStats={adminStats} />
        </div>
      ) : null}
      {activeAdminView === 'activeUsers' ? <ActiveUsersPanel users={userRows} /> : null}
      {activeAdminView === 'pendingUsers' ? <AccountTable rows={filteredUsers} onUpdate={handleUpdateUserStatus} title="회원가입 승인 대기" /> : null}
      </main>
    </>
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
  const scrollable = approved.length > VISIBLE_ROW_COUNT;

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
      <div className={scrollable ? 'tableScroll' : ''}>
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
            {scrollable ? null : <EmptyRows count={Math.max(0, VISIBLE_ROW_COUNT - approved.length)} columns={7} isEmpty={approved.length === 0} emptyLabel="활성 사용자 없음" />}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AccountTable({ rows, onUpdate, title = '회원가입 승인 관리', compact = false }) {
  const scrollable = rows.length > VISIBLE_ROW_COUNT;
  return (
    <section className="panel">
      <div className="panelTitleRow"><h2>{title}</h2><span className="panelCountBadge">{rows.length}건</span></div>
      <div className={scrollable ? 'tableScroll' : ''}>
        <table className="dataTable">
          <thead><tr><th>이름</th><th>신청 역할</th>{compact ? null : <th>소속</th>}<th>이메일</th>{compact ? null : <th>신청일</th>}<th>승인/거절</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.email}>
                <td>{row.name}</td><td>{roleLabels[row.role] || row.role}</td>{compact ? null : <td>{row.organization}</td>}<td>{row.email}</td>{compact ? null : <td>{row.requestedAt}</td>}
                {/* 관리자만 상담원/변호사 계정을 승인·거절할 수 있고, 승인 전에는 로그인이 막힙니다. */}
                <td><div className="statusActions"><StatusButton active={row.status === '승인'} onClick={() => onUpdate(row, '승인')}>승인</StatusButton><StatusButton active={row.status === '거절'} onClick={() => onUpdate(row, '거절')}>거절</StatusButton></div></td>
              </tr>
            ))}
            {scrollable ? null : <EmptyRows count={Math.max(0, VISIBLE_ROW_COUNT - rows.length)} columns={compact ? 4 : 6} isEmpty={rows.length === 0} emptyLabel="승인 대기 계정 없음" />}
          </tbody>
        </table>
      </div>
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
            {/* '휴무'(주말)라도 실제로 접수된 상담이 있으면 건수를 그대로 보여줍니다.
                예전엔 주말이면 무조건 '상담 없음'으로 표시해, 바로 아래 상세 표에는 그날 접수된
                상담이 있는데도 요약 칸만 "없다"고 말하는 모순이 실사용 중 확인됐습니다.
                (막대 그래프 대신 숫자만 크게 보여줘 한눈에 비교하기 쉽게 합니다) */}
            <strong>{item.closed && !item.count ? '상담 없음' : `${item.count}건`}</strong>
          </button>
        ))}
      </div>
      <HorizontalScrollBox>
        <div className={dayRows.length > VISIBLE_ROW_COUNT ? 'adminTableScroll tableScroll' : 'adminTableScroll'}>
          <ScrollableDataTable className="adminConsultationTable">
          <thead>
            <tr>
              <th colSpan={7} className="adminTableCaption">
                {selectedDay.closed ? `${selectedDay.label}요일 (휴무) 상담 내역 · ${dayRows.length}건` : `${selectedDay.year}.${selectedDay.monthNum}.${selectedDay.dayOfMonth} (${selectedDay.label}) 상담 내역 · ${dayRows.length}건`}
              </th>
            </tr>
            <tr>
              <th style={{ minWidth: FIRST_SEVEN_COLUMN_MIN_WIDTHS[1] }}>사건 번호</th>
              <th style={{ minWidth: FIRST_SEVEN_COLUMN_MIN_WIDTHS[0] }}>상담자</th>
              <th style={{ minWidth: 100 }}>담당 상담원</th>
              <th style={{ minWidth: 100 }}>검토 변호사</th>
              <th style={{ minWidth: FIRST_SEVEN_COLUMN_MIN_WIDTHS[3] }}>사건 유형</th>
              <th style={{ minWidth: FIRST_SEVEN_COLUMN_MIN_WIDTHS[4] }}>등록일</th>
              <th style={{ minWidth: FIRST_SEVEN_COLUMN_MIN_WIDTHS[5] }}>처리 단계</th>
            </tr>
          </thead>
          <tbody>
            {/* row.type(상담 등록 때 고른 유형)만 보면, AI 분석·상담원이 확정한 소분류가
                있어도 등록 당시 미분류였던 상담은 이 칸이 계속 빈 채로 보였습니다. 실시간
                상담·확정 전 확인 화면과 같은 기준(resolveConfirmedCaseType)으로 맞춥니다. */}
            {dayRows.map((row) => <tr key={row.id}><td>{row.caseNo}</td><td>{row.name || '이름 미입력'}</td><td>{counselorDisplayName(row.counselor, row.caseNo, row.recipientEmail)}</td><td>{row.lawyer?.name || row.reviewAction?.reviewer?.name || '미지정'}</td><td>{resolveConfirmedCaseType(row) || '미분류'}</td><td>{row.date}</td><td><span className={workflowStatusTone(row.workflowStatus)}>{row.workflowStatus || '분석 전'}</span></td></tr>)}
            {dayRows.length > VISIBLE_ROW_COUNT ? null : <EmptyRows count={Math.max(0, VISIBLE_ROW_COUNT - dayRows.length)} columns={7} isEmpty={dayRows.length === 0} emptyLabel="선택일 상담 없음" />}
          </tbody>
          </ScrollableDataTable>
        </div>
      </HorizontalScrollBox>
    </section>
  );
}

function AnalysisStatsPanel({ reviews }) {
  const scrollable = reviews.length > VISIBLE_ROW_COUNT;
  return (
    <section className="panel">
      <div className="panelTitleRow"><h2>분석 처리 상세</h2></div>
      <div className={scrollable ? 'tableScroll' : ''}>
        <table className="dataTable">
          <thead><tr><th>사건 번호</th><th>사건 제목</th><th>상태</th><th>요청일</th></tr></thead>
          <tbody>
            {reviews.map((row) => <tr key={row.id}><td>{row.caseNo}</td><td>{row.title}</td><td><span className={reviewStatusTone(row.status)}>{row.status}</span></td><td>{row.requestedAt}</td></tr>)}
            {scrollable ? null : <EmptyRows count={Math.max(0, VISIBLE_ROW_COUNT - reviews.length)} columns={4} isEmpty={reviews.length === 0} emptyLabel="분석 처리 이력 없음" />}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// 서식 개정 점검에서 바뀐 항목을 유형별로 보여줍니다.
// 무엇을 손봐야 하는지 알아야 하므로 건수만이 아니라 서식 이름까지 함께 보여줍니다.
const FORM_REVISION_LABELS = {
  revised: '개정(파일 교체)',
  added: '신규',
  removed: '삭제',
  recategorized: '분류 변경',
  renamed: '이름 변경',
};

function FormRevisionChanges({ changes }) {
  const groups = Object.entries(FORM_REVISION_LABELS)
    .map(([key, label]) => [label, changes[key] || []])
    .filter(([, rows]) => rows.length);

  return (
    <div className="formRevisionChanges">
      {groups.map(([label, rows]) => (
        <div key={label}>
          <strong>{label} {rows.length}건</strong>
          <ul>
            {rows.slice(0, 10).map((row) => (
              <li key={row.tmpltNo}>{row.tmpltNm || row.after || row.before}</li>
            ))}
            {rows.length > 10 ? <li>… 외 {rows.length - 10}건</li> : null}
          </ul>
        </div>
      ))}
    </div>
  );
}

function AdminOpsPanel({ currentUser }) {
  const [templateStatus, setTemplateStatus] = useState({ tone: 'muted', label: '검사 전' });
  // 마지막 점검 결과 원본. 변경 목록을 표로 펼치고 '확인 완료' 버튼을 띄울지 판단하는 데 씁니다.
  const [templateResult, setTemplateResult] = useState(null);
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

  // helplaw24 서식 목록을 받아 직전 기준선과 비교합니다 (요구사항 AI-05-04-01).
  // 서식 파일을 자동으로 바꾸지는 않습니다 — 원본이 .hwp라 구조가 달라진 걸 모른 채
  // 갈아끼우면 초안 생성이 조용히 어긋납니다. 무엇이 바뀌었는지 알려주는 데까지만 합니다.
  const runTemplateCheck = () => runCheck('template', async () => {
    try {
      const result = await checkFormRevisions();
      setTemplateResult(result);
      const changed = result.changes?.totalChanged || 0;
      setTemplateStatus({ tone: changed ? 'warning' : 'success', label: result.message });
      setAuditRows(appendAuditLog({
        actor: currentUser?.name || '관리자',
        action: '서식 개정 확인',
        target: result.source,
        metadata: { 감시서식: result.totalForms, 변경: changed },
      }));
    } catch (error) {
      // 수집 실패를 '변경 없음'으로 보여주면 점검이 정상이라고 오해합니다.
      setTemplateResult(null);
      setTemplateStatus({ tone: 'danger', label: error.message });
    }
  }, 'helplaw24 서식 목록을 확인하고 있습니다');

  // 관리자가 변경 내용을 확인했다는 표시. 이걸 눌러야 같은 변경이 다음 점검에 다시 뜨지 않습니다.
  const runTemplateAcknowledge = () => runCheck('templateAck', async () => {
    try {
      const result = await acknowledgeFormRevisions();
      setTemplateResult(null);
      setTemplateStatus({ tone: 'success', label: result.message });
      setAuditRows(appendAuditLog({
        actor: currentUser?.name || '관리자',
        action: '서식 개정 확인 완료',
        target: 'helplaw24',
        metadata: { 기준서식: result.totalForms },
      }));
    } catch (error) {
      setTemplateStatus({ tone: 'danger', label: error.message });
    }
  }, '기준 서식 목록을 갱신하고 있습니다');

  // ai-api(FastAPI) 서버가 실제로 떠 있고 프론트에서 호출 가능한지 확인하는 실제 네트워크 요청입니다.
  const runAiApiHealthCheck = () => runCheck('ai', async () => {
    try {
      await checkAiApiHealth();
      setAiApiStatus({ tone: 'success', label: '연결됨' });
    } catch (error) {
      setAiApiStatus({ tone: 'danger', label: error.message });
    }
  }, 'AI 분석 연결을 확인하고 있습니다');

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
  }, '상담 데이터 연결을 확인하고 있습니다');

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
    if (Number.isNaN(date.getTime())) return { date: value || '-', time: '', label: value || '-' };
    const dateLabel = date.toLocaleDateString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const timeLabel = date.toLocaleTimeString('ko-KR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    return { date: dateLabel, time: timeLabel, label: `${dateLabel} ${timeLabel}` };
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
        <WorkPageHeader
          title="운영 관리"
          description="감사 기록과 주요 서비스 연결 상태를 확인하세요."
        />
        <div className="adminOperationsLayout">
          <section className="adminAuditPanel" aria-labelledby="admin-audit-title">
            <div className="adminPanelHeading">
              <div>
                <h3 id="admin-audit-title">감사 로그</h3>
                <p>최근 수행된 운영 작업을 시간순으로 확인합니다.</p>
              </div>
              <span className="adminPanelCount">최근 {auditRows.length}건</span>
            </div>
            <div className="adminTableScroll">
              <table className="dataTable auditTable">
                <colgroup><col className="auditTimeColumn" /><col className="auditActorColumn" /><col /></colgroup>
                <thead><tr><th>일시</th><th>주체</th><th>작업 내용</th></tr></thead>
                <tbody>
                  {auditRows.map((row) => {
                    const timestamp = formatAuditTimestamp(row.createdAt || today);
                    const target = formatAuditTarget(row.target);
                    const detail = formatAuditDetail(row);
                    const activityDetail = [target, detail !== '-' ? detail : ''].filter(Boolean).join(' · ');
                    return (
                      <tr key={`${row.action}-${row.target}-${row.id}`}>
                        <td><time className="auditTimestamp" dateTime={row.createdAt || undefined} title={timestamp.label}><span>{timestamp.date}</span>{timestamp.time ? <strong>{timestamp.time}</strong> : null}</time></td>
                        <td><span className="auditActor" title={row.actor}>{row.actor}</span></td>
                        <td><div className="auditActivity"><strong>{row.action}</strong>{activityDetail ? <span title={activityDetail}>{activityDetail}</span> : null}</div></td>
                      </tr>
                    );
                  })}
                  {auditRows.length > VISIBLE_ROW_COUNT ? null : <EmptyRows count={Math.max(0, VISIBLE_ROW_COUNT - auditRows.length)} columns={3} isEmpty={auditRows.length === 0} emptyLabel="감사 로그 없음" />}
                </tbody>
              </table>
            </div>
          </section>

          <section className="adminServicePanel" aria-labelledby="admin-service-title">
            <div className="adminPanelHeading">
              <div>
                <h3 id="admin-service-title">서비스 점검</h3>
                <p>필요한 항목만 실행해 연결 상태와 변경 내용을 확인합니다.</p>
              </div>
            </div>

            <div className="adminServiceList">
              <article className="adminServiceCheck">
                <div className="adminServiceContent">
                  <h4>서식 개정 모니터링</h4>
                  <p>사용 중인 291개 서식의 변경 사항을 확인합니다. 서식 파일은 자동으로 바꾸지 않습니다.</p>
                  <strong>상태: <span className={`statusChip tone-${templateStatus.tone}`}>{templateStatus.label}</span></strong>
                  {templateResult?.changes?.totalChanged ? <FormRevisionChanges changes={templateResult.changes} /> : null}
                </div>
                <div className="adminServiceActions">
                  <button className="adminServiceAction" type="button" onClick={runTemplateCheck} disabled={Boolean(runningCheck)}>{runningCheck === 'template' ? '확인하는 중…' : '변경 확인'}</button>
                  {templateResult?.changes?.totalChanged ? (
                    <button className="adminServiceAction secondary" type="button" onClick={runTemplateAcknowledge} disabled={Boolean(runningCheck)}>{runningCheck === 'templateAck' ? '처리하는 중…' : '기준 갱신'}</button>
                  ) : null}
                </div>
              </article>

              <article className="adminServiceCheck">
                <div className="adminServiceContent">
                  <h4>AI 분석 연결</h4>
                  <p>AI 분석 기능이 현재 프론트엔드에서 호출 가능한지 확인합니다.</p>
                  <strong>상태: <span className={`statusChip tone-${aiApiStatus.tone}`}>{aiApiStatus.label}</span></strong>
                </div>
                <div className="adminServiceActions">
                  <button className="adminServiceAction" type="button" onClick={runAiApiHealthCheck} disabled={Boolean(runningCheck)}>{runningCheck === 'ai' ? '확인하는 중…' : '연결 확인'}</button>
                </div>
              </article>

              <article className="adminServiceCheck">
                <div className="adminServiceContent">
                  <h4>상담 데이터 연결</h4>
                  <p>상담 및 사용자 데이터에 정상적으로 접근할 수 있는지 확인합니다.</p>
                  <strong>상태: <span className={`statusChip tone-${coreApiStatus.tone}`}>{coreApiStatus.label}</span></strong>
                  {coreApiStatus.tone === 'success' ? (
                    <div className="apiMetricGrid">
                      <span>사용자 {coreApiStatus.users}명</span>
                      <span>상담 {coreApiStatus.consultations}건</span>
                    </div>
                  ) : null}
                  {coreApiStatus.detail ? <p className="helperText">{coreApiStatus.detail}</p> : null}
                </div>
                <div className="adminServiceActions">
                  <button className="adminServiceAction" type="button" onClick={runCoreApiHealthCheck} disabled={Boolean(runningCheck)}>{runningCheck === 'core' ? '확인하는 중…' : '연결 확인'}</button>
                </div>
              </article>

              <article className="adminServiceCheck">
                <div className="adminServiceContent">
                  <h4>서버 감사 로그 검증</h4>
                  <p>서버가 남긴 감사 로그 해시체인의 위변조 여부를 확인합니다.</p>
                  <strong>상태: <span className={`statusChip tone-${serverAuditStatus.tone}`}>{serverAuditStatus.label}</span></strong>
                </div>
                <div className="adminServiceActions">
                  <button className="adminServiceAction" type="button" onClick={runServerAuditCheck} disabled={Boolean(runningCheck)}>{runningCheck === 'serverAudit' ? '검증하는 중…' : '로그 검증'}</button>
                </div>
              </article>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

function BarChartMock({ consultations, serverStats }) {
  // 소분류(29개)가 아니라 대분류(친족/상속/가사소송/가족관계등록) 4개 기준으로 집계해 한눈에 보이게 합니다.
  // item.category/item.type은 '새 상담 만들기'에서 직접 고른 값만 채워지고, 통화 중 빠르게 만든
  // 상담이나 자료 업로드로 들어온 상담은 비어 있습니다 — 그런 상담은 AI 분석이 정리한
  // caseSubtype/caseType으로 대분류를 판단해야 실제로는 분류된 상담이 전부 '기타'로 잡히지 않습니다.
  const resolveKnownCaseType = (item) => {
    if (isKnownCaseType(item.analysis?.caseSubtype)) return item.analysis.caseSubtype;
    if (isKnownCaseType(item.analysis?.caseType)) return item.analysis.caseType;
    return item.type;
  };
  const serverCategoryStats = serverStats?.case_type_stats && typeof serverStats.case_type_stats === 'object'
    ? serverStats.case_type_stats
    : null;
  // core-api는 대분류(친족/상속/가사소송/가족관계등록)가 아니라 소분류(예: '약혼') 단위로
  // 집계해서 돌려줍니다. 소분류 키를 대분류 키로 그대로 조회하면 항상 0건으로 보여, 여기서
  // 로컬 집계와 같은 방식(getCaseCategory)으로 대분류로 다시 묶습니다.
  const serverCategoryTotals = serverCategoryStats
    ? Object.entries(serverCategoryStats).reduce((totals, [subType, count]) => {
        const category = getCaseCategory(subType);
        totals[category] = (totals[category] || 0) + Number(count || 0);
        return totals;
      }, {})
    : null;
  const countByCategory = (key) => {
    if (serverCategoryTotals) return Number(serverCategoryTotals[key] || 0);
    return consultations.filter((item) => (item.category || getCaseCategory(resolveKnownCaseType(item))) === key).length;
  };
  // 아는 4개 분류에 속하지 않는 상담(AI가 다른 체계의 유형을 돌려준 경우 등)은 '기타'로 모입니다.
  // 이 줄이 없으면 그런 상담이 통계에서 통째로 사라져, 합계가 실제 건수와 맞지 않게 됩니다.
  const knownKeys = caseCategories.map((category) => category.key);
  const categoryKeys = countByCategory('기타') ? [...knownKeys, '기타'] : knownKeys;
  // 막대 위에 숫자를 얹어 보여주던 이전 방식은 막대와 숫자가 겹쳐 보여 불편하다는 피드백에 따라,
  // 막대 그래프 대신 분류명과 건수를 나란히 둔 목록으로 단순화합니다.
  return (
    <section className="chartPanel">
      <h2>사건 유형별 상담 통계</h2>
      <div className="statList">
        {categoryKeys.map((key) => {
          const count = countByCategory(key);
          return (
            <div className={count === 0 ? 'statListRow zero' : 'statListRow'} key={key}>
              <span>{key}</span>
              <strong>{count}건</strong>
            </div>
          );
        })}
      </div>
    </section>
  );
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
    return { key: segment.key, index: segment.index, className: segment.toneClass, dashArray: `${trimmedPercent} ${100 - trimmedPercent}`, dashOffset };
  });
}

function DonutChart({ total, segments, hoveredIndex, onHoverChange }) {
  const visibleSegments = segments
    .map((segment, index) => ({ ...segment, index }))
    .filter((segment) => segment.value > 0);
  const arcs = buildDonutArcs(visibleSegments, total, visibleSegments.length > 1 ? 2.4 : 0);
  const summary = segments.map((segment) => `${segment.label} ${segment.value}건`).join(', ');
  return (
    <div className={`donutChart${hoveredIndex !== null ? ' has-hovered-segment' : ''}`} role="img" aria-label={`전체 ${total}건 중 ${summary}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="donutTrack" cx="50" cy="50" r="40" pathLength="100" />
        {arcs.map((arc) => (
          <circle
            key={arc.key}
            className={`donutArc ${arc.className}${hoveredIndex === arc.index ? ' is-hovered' : ''}`}
            cx="50"
            cy="50"
            r="40"
            pathLength="100"
            strokeDasharray={arc.dashArray}
            strokeDashoffset={arc.dashOffset}
            onMouseEnter={() => onHoverChange?.(arc.index)}
            onMouseLeave={() => onHoverChange?.(null)}
          />
        ))}
      </svg>
      <div className="donutCenter">
        <strong>{total}<em>건</em></strong>
      </div>
    </div>
  );
}

function DonutChartMock({ reviews, serverStats }) {
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const serverBreakdown = serverStats?.analysis_status_breakdown && typeof serverStats.analysis_status_breakdown === 'object'
    ? serverStats.analysis_status_breakdown
    : null;
  const total = serverBreakdown
    ? Object.values(serverBreakdown).reduce((sum, value) => sum + Number(value || 0), 0)
    : reviews.length;
  const approved = serverBreakdown ? Number(serverBreakdown.approved || 0) : reviews.filter((item) => item.status === '승인').length;
  const rejected = serverBreakdown ? Number(serverBreakdown.rejected || 0) : reviews.filter((item) => item.status === '반려').length;
  const pending = serverBreakdown
    ? Number(serverBreakdown.pending || 0)
    : Math.max(0, total - approved - rejected);
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
        <DonutChart total={total} segments={segments} hoveredIndex={hoveredIndex} onHoverChange={setHoveredIndex} />
        <ul className="legendList">
          <li className="legendTotalRow">전체 <strong>{total}건</strong> 접수</li>
          {segments.map((segment, index) => (
            <li key={segment.key}>
              <button
                className={`legendRow${hoveredIndex === index ? ' is-hovered' : ''}`}
                type="button"
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
                onFocus={() => setHoveredIndex(index)}
                onBlur={() => setHoveredIndex(null)}
                aria-pressed={hoveredIndex === index}
                aria-label={`${segment.label} ${segment.value}건, ${total ? Math.round((segment.value / total) * 100) : 0}% 강조`}
              >
              <span className={`legendDot ${segment.toneClass}`} />
              <span className="legendLabel">{segment.label}</span>
              <span className="legendValue">{segment.value}건</span>
              <span className="legendPercent">{total ? Math.round((segment.value / total) * 100) : 0}%</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export { CounselorDashboard, LawyerDashboard, AdminDashboard };
