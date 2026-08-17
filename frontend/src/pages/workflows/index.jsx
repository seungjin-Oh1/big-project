import React from 'react';
import { UploadWorkbench } from './upload/UploadWorkbench.jsx';
import { ProfilePanel } from './profile/ProfilePanel.jsx';
import { SearchWorkbench } from './search/SearchWorkbench.jsx';
import { AdoptedReferencePanel } from './search/AdoptedReferencePanel.jsx';
import { DraftWorkbench } from './draft/DraftWorkbench.jsx';
import { NotificationPanel } from './notifications/NotificationPanel.jsx';
import { AnalysisWorkbench } from './analysis/AnalysisWorkbench.jsx';
import { ReliefReviewSummary } from './relief/ReliefReviewSummary.jsx';
import { ReliefReviewDetailTabs } from './relief/ReliefReviewDetailTabs.jsx';
import { DOCUMENT_STATUS_LABEL, documentStatusTone } from './shared/documentHelpers.js';
import { GeneratedFileLink, DraftContentReviewLabel } from './documents/GeneratedFileBox.jsx';
import { SummaryBulletList } from './components/SummaryBulletList.jsx';
import { resolveConfirmedCaseType } from './shared/caseHelpers.js';
import { runConsultationAnalysis, hydrateAnalysisForDisplay, pickClientName } from './shared/analysisHelpers.js';

export function UtilityPanel({ view, role, consultations, onCreateConsultation, onRequestLegalReview, onAnalysisSaved, onSaveTranscript, onUpdateConsultation, currentUser, onUpdateProfile, notifications, onReadNotifications, onDeleteNotification, onOpenNotification, onGoToDashboard, onNotify, focusedConsultationId, focusedTemplateName, onOpenConsultationForm, onOpenAnalysis, onOpenDraft, analysisRuns, onStartAnalysis }) {
  // '상담 등록'은 상담원 고유 업무입니다. 다른 역할에서 실수로 activeView가 넘어와도
  // 접수 화면이 열리지 않도록 역할을 한 번 더 확인합니다. (네비게이션 메뉴 구성과 이중 방어)
  if (view === '상담 등록') return role === 'counselor' ? (
    <UploadWorkbench
      consultations={consultations}
      onCreateConsultation={onCreateConsultation}
      onUpdateConsultation={onUpdateConsultation}
      onGoToRealtimeAnalysis={(id) => onOpenAnalysis?.(id)}
    />
  ) : <ProfilePanel role={role} currentUser={currentUser} onUpdateProfile={onUpdateProfile} />;
  // 법령·판례 검색은 변호사 전용입니다. 메뉴에서 이미 뺐지만, 상담원 role로 이 화면에
  // 들어오는 경로가 남아있을 수 있어 한 번 더 막습니다. (상담 등록과 같은 이중 방어 규칙)
  if (view === '법률, 판례') return role === 'lawyer' ? (
    <SearchWorkbench
      consultations={consultations}
      onAnalysisSaved={onAnalysisSaved}
      onNotify={onNotify}
    />
  ) : <ProfilePanel role={role} currentUser={currentUser} onUpdateProfile={onUpdateProfile} />;
  // 담아둔 자료 확인도 법령·판례와 같은 변호사 업무라 같은 방식으로 막습니다.
  if (view === '담은 자료') return role === 'lawyer'
    ? <AdoptedReferencePanel consultations={consultations} onAnalysisSaved={onAnalysisSaved} />
    : <ProfilePanel role={role} currentUser={currentUser} onUpdateProfile={onUpdateProfile} />;
  if (view === '서식 생성') return (
    <DraftWorkbench
      consultations={consultations}
      currentUser={currentUser}
      role={role}
      onUpdateConsultation={onUpdateConsultation}
      onNotify={onNotify}
      focusedConsultationId={focusedConsultationId}
      focusedTemplateName={focusedTemplateName}
    />
  );
  if (view === '알림') return <NotificationPanel role={role} currentUser={currentUser} notifications={notifications} onReadNotifications={onReadNotifications} onDeleteNotification={onDeleteNotification} onOpenNotification={onOpenNotification} />;
  if (view === '기타' && role === 'lawyer') return <ProfilePanel role={role} currentUser={currentUser} onUpdateProfile={onUpdateProfile} />;
  if (view === '기타') return <AnalysisWorkbench consultations={consultations} onCreateConsultation={onCreateConsultation} onUpdateConsultation={onUpdateConsultation} onRequestLegalReview={onRequestLegalReview} onAnalysisSaved={onAnalysisSaved} onSaveTranscript={onSaveTranscript} currentUser={currentUser} onGoToDashboard={onGoToDashboard} onOpenDraft={onOpenDraft} onGoToUpload={onOpenConsultationForm} focusedConsultationId={focusedConsultationId} analysisRuns={analysisRuns} onStartAnalysis={onStartAnalysis} />;
  return <ProfilePanel role={role} currentUser={currentUser} onUpdateProfile={onUpdateProfile} />;
}

export {
  ReliefReviewSummary,
  ReliefReviewDetailTabs,
  DOCUMENT_STATUS_LABEL,
  documentStatusTone,
  GeneratedFileLink,
  DraftContentReviewLabel,
  SummaryBulletList,
  resolveConfirmedCaseType,
  runConsultationAnalysis,
  hydrateAnalysisForDisplay,
  pickClientName,
};
