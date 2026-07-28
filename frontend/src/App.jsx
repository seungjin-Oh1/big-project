import React, { useEffect, useState } from 'react';

// 화면 전환과 전역 상태를 관리하는 프론트엔드 최상위 컴포넌트입니다.
import { Header, Footer, DashboardHeader } from './components/layout.jsx';
import { initialConsultations, initialReviews, today } from './constants.jsx';
import { LoginPage, RegisterPage, PasswordFindPage } from './pages/auth.jsx';
import { CounselorDashboard, LawyerDashboard, AdminDashboard } from './pages/dashboards.jsx';
import { appendAuditLog, readStorage, readTextStorage, storageKeys, writeStorage, writeTextStorage } from './services/storage.js';
import { LoadingProvider } from './components/loading.jsx';
import { FeedbackProvider } from './components/feedback.jsx';
import {
  approveCoreUser,
  createCoreAnalysis,
  createCoreConsultation,
  deleteCoreConsultation,
  fetchCoreAnalyses,
  fetchCoreConsultations,
  loginCoreUser,
  mapCoreAnalysisResponse,
  normalizeAuthResponse,
  registerCoreUser,
  rejectCoreUser,
  updateCoreAnalysis,
  updateCoreConsultation,
  updateCoreConsultationStatus,
} from './services/coreApiClientV2.js';

function stripSensitiveUserFields(user) {
  const { password: _password, confirmPassword: _confirmPassword, ...safeUser } = user;
  return safeUser;
}

// 로그인한 역할에 따라 상담원/변호사/관리자 대시보드를 분기합니다.
function DashboardPage({ role, currentUser, onUpdateProfile, onLogout, users, onUpdateUserStatus }) {
  const defaultView = '대시보드';
  const [activeView, setActiveView] = useState(defaultView);
  const [focusedConsultationId, setFocusedConsultationId] = useState(null);
  const [focusedReviewCaseNo, setFocusedReviewCaseNo] = useState(null);
  const [consultations, setConsultations] = useState(() => readStorage(storageKeys.consultations, initialConsultations));
  const [reviews, setReviews] = useState(() => readStorage(storageKeys.reviews, initialReviews));
  const [notifications, setNotifications] = useState(() => readStorage(storageKeys.notifications, []));

  useEffect(() => {
    writeStorage(storageKeys.consultations, consultations);
  }, [consultations]);

  useEffect(() => {
    writeStorage(storageKeys.reviews, reviews);
  }, [reviews]);

  useEffect(() => {
    writeStorage(storageKeys.notifications, notifications);
  }, [notifications]);

  // 대시보드에 들어올 때 core-api에 저장된 상담 목록을 한 번 확인해, 이 브라우저 로컬 저장소에는
  // 없지만 서버에는 있는 상담(다른 기기에서 등록됐거나, 예전에 등록만 되고 이 브라우저 캐시가
  // 지워진 경우)을 찾아 추가합니다. 이미 로컬에 있는 상담(coreId로 식별)의 필드는 절대 덮어쓰지
  // 않습니다 — core-api Consultation에는 분석·첨부·법률구조 대상 여부 같은 로컬 전용 필드가 없어서,
  // 통째로 덮어쓰면 상담원이 화면에서 입력해둔 내용이 사라집니다.
  useEffect(() => {
    let cancelled = false;
    fetchCoreConsultations()
      .then((serverRows) => {
        if (cancelled || !Array.isArray(serverRows)) return;
        setConsultations((items) => {
          const knownCoreIds = new Set(items.map((item) => item.coreId).filter(Boolean));
          const missingRows = serverRows.filter((row) => !knownCoreIds.has(row.id));
          if (!missingRows.length) return items;
          let nextLocalId = items.length ? Math.max(...items.map((item) => item.id)) : 0;
          const additions = missingRows.map((row) => {
            nextLocalId += 1;
            return {
              id: nextLocalId,
              caseNo: `C-CORE-${row.id}`,
              coreId: row.id,
              title: row.title || '제목 미입력',
              memo: row.inputText || '',
              opponentName: row.opponentName || '',
              status: '진행 중',
              date: (row.createdAt || '').slice(0, 10) || today,
              registeredTime: '',
              workflowStatus: '상담 완료',
              counselor: null,
              logs: [],
              analysis: null,
              attachments: [],
            };
          });
          return [...additions, ...items];
        });
      })
      .catch(() => {
        // Core API가 꺼져 있어도 로컬 저장소 데이터로 화면은 그대로 동작해야 하므로 조용히 넘어갑니다.
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // '법률구조 검토 요청'(reviews)은 상담원이 검토를 요청한 그 브라우저에만 즉시 반영되고,
  // 지금까지는 core-api에 실제로 남아있는 검토 요청을 다시 읽어오는 곳이 전혀 없었습니다.
  // 그래서 변호사가 다른 기기/브라우저로 접속하면(원래 서버-클라이언트 구조라면 당연히 그래야 하는
  // 상황) reviews가 이 브라우저의 로컬 저장소(초기 목업 seed)만 갖고 있어서, 상담원이 실제로
  // 요청한 검토 건이 전혀 보이지 않았습니다. 서식 초안 검토 대기 패널이 이미 하는 방식(사건마다
  // 분석/문서 목록을 core-api에서 가져와 상태로 거르기)과 같은 방식으로, coreId가 있는 상담마다
  // 분석 목록을 가져와 SUBMITTED_FOR_REVIEW 상태인 것만 reviews에 채워 넣습니다.
  const coreConsultationIdsKey = consultations.map((item) => item.coreId).filter(Boolean).join(',');
  useEffect(() => {
    const candidateCases = consultations.filter((item) => item.coreId);
    if (!candidateCases.length) return undefined;
    let cancelled = false;
    Promise.allSettled(candidateCases.map((item) => fetchCoreAnalyses(item.coreId)))
      .then((results) => {
        if (cancelled) return;
        setReviews((currentReviews) => {
          const known = new Set(
            currentReviews
              .filter((item) => item.coreId && item.coreAnalysisId)
              .map((item) => `${item.coreId}:${item.coreAnalysisId}`),
          );
          const additions = [];
          results.forEach((result, index) => {
            if (result.status !== 'fulfilled' || !Array.isArray(result.value)) return;
            const target = candidateCases[index];
            result.value
              .filter((row) => row.status === 'SUBMITTED_FOR_REVIEW')
              .forEach((row) => {
                const coreAnalysisId = row.analysis_id ?? row.analysisId;
                const key = `${target.coreId}:${coreAnalysisId}`;
                if (known.has(key)) return;
                known.add(key);
                const mapped = mapCoreAnalysisResponse(row);
                additions.push({
                  id: target.id,
                  caseNo: target.caseNo,
                  type: mapped.caseType || target.type,
                  title: target.title,
                  status: '검토 대기',
                  requestedAt: (row.created_at || '').slice(0, 10) || today,
                  summary: mapped.summary || '',
                  urgency: mapped.urgency || '',
                  eligibility: mapped.eligibility || '',
                  analysis: mapped,
                  counselor: target.counselor || null,
                  lawyer: null,
                  name: target.name,
                  date: target.date,
                  registeredTime: target.registeredTime,
                  attachments: target.attachments || [],
                  coreId: target.coreId,
                  coreAnalysisId,
                });
              });
          });
          if (!additions.length) return currentReviews;
          return [...additions, ...currentReviews];
        });
      })
      .catch(() => {
        // Core API가 꺼져 있어도 로컬 저장소 데이터로 화면은 그대로 동작해야 하므로 조용히 넘어갑니다.
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coreConsultationIdsKey]);

  const notificationUserKey = (targetRole = role, targetEmail = currentUser?.email) => `${targetRole}:${targetEmail || 'all'}`;
  const isNotificationVisible = (item, targetRole = role, targetEmail = currentUser?.email) => {
    if (!item.roles?.includes(targetRole)) return false;
    if (item.recipientEmail && item.recipientEmail !== targetEmail) return false;
    const personalKey = notificationUserKey(targetRole, targetEmail);
    return !item.deletedBy?.includes(targetRole) && !item.deletedBy?.includes(personalKey);
  };
  const isNotificationUnread = (item, targetRole = role, targetEmail = currentUser?.email) => {
    const personalKey = notificationUserKey(targetRole, targetEmail);
    return !item.readBy?.includes(targetRole) && !item.readBy?.includes(personalKey);
  };

  const addNotification = ({ roles, title, message, target, recipientEmail, view }) => {
    const roleList = Array.isArray(roles) ? roles : [roles];
    setNotifications((items) => [{
      id: Date.now() + Math.random(),
      roles: roleList,
      title,
      message,
      target: target || '',
      recipientEmail: recipientEmail || '',
      view: view || '',
      createdAt: new Date().toISOString(),
      readBy: [],
    }, ...items]);
  };

  const markNotificationsRead = (targetRole, targetEmail) => {
    const personalKey = notificationUserKey(targetRole, targetEmail);
    setNotifications((items) => items.map((item) => isNotificationVisible(item, targetRole, targetEmail) ? {
      ...item,
      readBy: item.readBy?.includes(personalKey) ? item.readBy : [...(item.readBy || []), personalKey],
    } : item));
  };

  const markNotificationRead = (notificationId, targetRole, targetEmail) => {
    const personalKey = notificationUserKey(targetRole, targetEmail);
    setNotifications((items) => items.map((item) => item.id === notificationId && item.roles.includes(targetRole) ? {
      ...item,
      readBy: item.readBy?.includes(personalKey) ? item.readBy : [...(item.readBy || []), personalKey],
    } : item));
  };

  const deleteNotification = (notificationId, targetRole, targetEmail) => {
    const personalKey = notificationUserKey(targetRole, targetEmail);
    setNotifications((items) => items.map((item) => item.id === notificationId && item.roles.includes(targetRole) ? {
      ...item,
      deletedBy: item.deletedBy?.includes(personalKey) ? item.deletedBy : [...(item.deletedBy || []), personalKey],
    } : item));
  };

  const openNotification = (notification) => {
    markNotificationRead(notification.id, role, currentUser?.email);
    if (role === 'counselor') {
      const target = consultations.find((item) => item.caseNo === notification.target);
      if (target) {
        setFocusedConsultationId(target.id);
        setActiveView(notification.view || (notification.title?.includes('서식') ? '서식 생성' : '기타'));
        return;
      }
    }
    if (role === 'lawyer') {
      setFocusedReviewCaseNo(notification.target || null);
      setActiveView('대시보드');
      return;
    }
    setActiveView('대시보드');
  };
  const changeActiveView = (nextView) => {
    setFocusedConsultationId(null);
    setFocusedReviewCaseNo(null);
    setActiveView(nextView);
  };

  const unreadCount = notifications.filter((item) => isNotificationVisible(item) && isNotificationUnread(item)).length;

  // 백엔드 상담 등록 API가 연결되기 전까지 로컬 상태에 상담을 생성합니다.
  // 변호사 검토 요청은 상담 분석 저장 이후 상담원이 명시적으로 요청할 때 생성합니다.
  // options.skipNavigation: 실시간 분석 화면에서 '바로 시작'할 때는 상담 등록 화면과 달리
  // 대시보드로 튕기지 않고 그 자리(실시간 분석 화면)에 머물러야 하므로, 호출부가 선택적으로 끕니다.
  const createConsultation = async (form, options = {}) => {
    const id = consultations.length ? Math.max(...consultations.map((item) => item.id)) + 1 : 1;
    const caseNo = `C-2026-${String(id).padStart(3, '0')}`;
    const now = new Date();
    const registeredTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    let coreSync = null;
    let coreSyncError = '';
    try {
      coreSync = await createCoreConsultation({ currentUser: { ...currentUser, role }, consultation: form });
    } catch (error) {
      coreSyncError = error.message;
    }

    const nextConsultation = {
      id,
      caseNo,
      ...(coreSync || {}),
      date: today,
      registeredTime,
      workflowStatus: '상담 완료',
      counselor: {
        name: currentUser?.name || '상담원',
        email: currentUser?.email || '',
        organization: currentUser?.organization || '',
      },
      logs: [{ status: '상담 접수', createdAt: today }],
      analysis: null,
      ...form,
    };
    setConsultations((items) => [nextConsultation, ...items]);
    appendAuditLog({
      actor: currentUser?.email || '상담원',
      action: '상담 등록',
      target: caseNo,
      metadata: {
        title: form.title,
        type: form.type,
        counselor: currentUser?.name || '상담원',
        client: form.name,
        legalAidType: form.eligibilityCheck?.applicantType || '',
        coreId: coreSync?.coreId || '',
        coreSyncError,
      },
    });
    if (!options.skipNavigation) setActiveView('대시보드');
    return {
      ok: true,
      id,
      caseNo,
      coreSynced: Boolean(coreSync),
      // 첨부파일 업로드(POST /api/consultations/{id}/attachments)는 상담이 실제로 있어야 부를 수
      // 있어서, 호출부(UploadWorkbench)가 이 coreId를 받아 등록 직후에 파일을 마저 올립니다.
      coreId: coreSync?.coreId || '',
      message: coreSync
        ? '상담이 등록되었고 Core API에도 저장되었습니다.'
        : '상담이 등록되었습니다. Core API는 나중에 다시 동기화할 수 있습니다.',
    };
  };

  const notifyAnalysisSaved = async (consultation, analysis) => {
    if (!consultation) return { ok: false, message: '상담 정보를 찾을 수 없습니다.' };
    if (!consultation.coreId) return { ok: true, synced: false, message: '로컬 저장 완료' };
    try {
      // 이미 이 상담에 대해 저장된 분석이 있으면(coreAnalysisId 존재) 같은 행을 PUT으로 덮어씁니다.
      // 예전에는 매번 create만 호출해서 상담원이 분석을 고쳐 다시 저장할 때마다 analyses 테이블에
      // 같은 상담 건의 새 행이 계속 쌓였습니다.
      const existingAnalysisId = consultation.coreAnalysisId;
      const savedAnalysis = existingAnalysisId
        ? await updateCoreAnalysis({ consultation, analysisId: existingAnalysisId, analysis })
        : await createCoreAnalysis({ consultation, analysis });
      await updateCoreConsultation(consultation.coreId, {
        status: 'ANALYZING',
        title: consultation.title,
        inputText: consultation.memo || consultation.title || '',
        opponentName: consultation.opponentName || consultation.name || '',
      });
      // 서식 추천/초안 생성 API(recommend-forms, generate-draft)는 상담 id뿐 아니라 이 분석 id도
      // 함께 있어야 호출할 수 있습니다. 응답은 AiAnalysisResponse라 snake_case(analysis_id)로 옵니다.
      const analysisId = savedAnalysis?.analysis_id || existingAnalysisId;
      if (analysisId && analysisId !== existingAnalysisId) {
        setConsultations((items) => items.map((item) => item.id === consultation.id ? { ...item, coreAnalysisId: analysisId } : item));
      }
      return { ok: true, synced: true, message: 'Core API 분석 저장까지 완료되었습니다.' };
    } catch {
      return { ok: true, synced: false, message: '로컬 저장 완료' };
    }
  };

  const requestLegalReview = (consultationId, analysis) => {
    const target = consultations.find((item) => item.id === consultationId);
    if (!target) return { ok: false, message: '검토 요청할 상담을 찾을 수 없습니다.' };

    const nextReview = {
      id: target.id,
      caseNo: target.caseNo,
      type: analysis?.caseType || target.type,
      title: target.title,
      status: '검토 대기',
      requestedAt: today,
      summary: analysis?.summary || '',
      urgency: analysis?.urgency || '',
      eligibility: analysis?.eligibility || '',
      analysis,
      counselor: target.counselor || null,
      lawyer: null,
      // 상담원 화면에 나오던 상담자 이름·등록일시·첨부자료는 검토 요청 시점에 함께 넘겨야
      // 변호사 쪽 화면(법률·판례 찾기, 서식 생성)에서도 '상담자 미지정'처럼 정보가 비어 보이지 않습니다.
      name: target.name,
      date: target.date,
      registeredTime: target.registeredTime,
      attachments: target.attachments || [],
      // 서식 초안 생성/검토 API(recommend-forms, generate-draft, documents)는 core-api의
      // 상담 id·분석 id로 사건을 찾으므로, 변호사 화면(서식 생성)에서도 그대로 이어받아야 합니다.
      coreId: target.coreId || '',
      coreAnalysisId: target.coreAnalysisId || '',
    };

    setReviews((items) => {
      const exists = items.some((item) => item.id === target.id);
      if (exists) return items.map((item) => item.id === target.id ? { ...item, ...nextReview } : item);
      return [nextReview, ...items];
    });
    setConsultations((items) => items.map((item) => item.id === target.id ? {
      ...item,
      workflowStatus: '법률 검토',
      reviewAction: null,
      logs: [...(item.logs || []), { status: '변호사 검토 요청', createdAt: today }],
    } : item));
    appendAuditLog({ actor: currentUser?.email || '상담원', action: '변호사 검토 요청', target: target.caseNo, metadata: { title: target.title, type: nextReview.type, counselor: target.counselor?.name || currentUser?.name || '상담원', caseType: nextReview.type, eligibility: nextReview.eligibility } });
    addNotification({ roles: 'lawyer', title: '새 검토 요청', message: `${target.caseNo} ${target.title}`, target: target.caseNo, view: '대시보드' });
    return { ok: true, message: '변호사 검토 요청이 등록되었습니다.' };
  };

  const applyReviewDecision = ({ id, status, reason, reviewer, recipientEmail }) => {
    const needsCounselorWork = ['수정 요청', '추가자료 요청', '반려', '보류'].includes(status);
    const nextLocalStatus = status === '승인' ? '완료' : status === '반려' || status === '보류' ? '보류' : '진행 중';
    setFocusedReviewCaseNo(null);
    setConsultations((items) => items.map((item) => {
      if (item.id !== id) return item;
      return {
        ...item,
        status: nextLocalStatus,
        workflowStatus: needsCounselorWork ? status : '승인 완료',
        lawyer: reviewer || null,
        reviewAction: needsCounselorWork ? { status, reason: reason || '', reviewer: reviewer || null, recipientEmail: recipientEmail || item.counselor?.email || '', requestedAt: today, resolved: false } : null,
        logs: [...(item.logs || []), { status: `변호사 검토 결과: ${status}`, reason: reason || '', createdAt: today }],
      };
    }));
    // core-api의 Consultation.status(RECEIVED/ANALYZING/COMPLETED/HOLD)도 화면 상태(완료/보류/진행 중)에
    // 맞춰 갱신합니다. 예전엔 분석 저장 시(ANALYZING) 딱 한 번만 갱신하고 그 뒤로는 손대지 않아서,
    // 화면에서 "완료"/"보류"로 표시된 상담도 서버 status는 영원히 ANALYZING에 머물러 있었습니다.
    // 실패해도(백엔드가 꺼져 있는 등) 화면은 이미 위에서 로컬 상태로 갱신됐으니 조용히 넘어갑니다.
    const target = consultations.find((item) => item.id === id);
    if (target?.coreId) {
      const backendStatus = nextLocalStatus === '완료' ? 'COMPLETED' : nextLocalStatus === '보류' ? 'HOLD' : 'ANALYZING';
      updateCoreConsultationStatus(target.coreId, backendStatus).catch(() => {});
    }
  };

  const applyDocumentReviewDecision = ({ caseNo, action, reason, reviewer, recipientEmail, formName, requestedMaterials = [] }) => {
    const needsCounselorWork = action === 'revision';
    setConsultations((items) => items.map((item) => {
      if (item.caseNo !== caseNo) return item;
      return {
        ...item,
        status: needsCounselorWork ? '진행 중' : item.status,
        workflowStatus: needsCounselorWork ? '서식 보완 요청' : '서식 승인 완료',
        lawyer: reviewer || item.lawyer || null,
        reviewAction: needsCounselorWork ? {
          status: '서식 반려',
          reason: reason || '반려 사유가 입력되지 않았습니다.',
          reviewer: reviewer || null,
          recipientEmail: recipientEmail || item.counselor?.email || '',
          requestedAt: today,
          resolved: false,
          workbench: '서식 생성',
          formName: formName || '',
          requestedMaterials,
        } : null,
        logs: [...(item.logs || []), {
          status: needsCounselorWork ? '서식 초안 반려' : '서식 초안 승인',
          reason: reason || '',
          createdAt: today,
        }],
      };
    }));
    // 서식이 반려돼 상담원이 다시 작업해야 하는 상태(진행 중)로 돌아갈 때도 core-api 상태를 맞춥니다.
    if (needsCounselorWork) {
      const target = consultations.find((item) => item.caseNo === caseNo);
      if (target?.coreId) {
        updateCoreConsultationStatus(target.coreId, 'ANALYZING').catch(() => {});
      }
    }
  };

  // 상담 삭제 시 연결된 검토 요청도 함께 정리합니다.
  const deleteConsultation = (id) => {
    const target = consultations.find((item) => item.id === id);
    setConsultations((items) => items.filter((item) => item.id !== id));
    setReviews((items) => items.filter((item) => item.id !== id));
    appendAuditLog({ actor: currentUser?.email || '상담원', action: '상담 삭제', target: target?.caseNo || String(id) });
    // core-api에 저장된 상담이면 거기서도 지워야 목록 재조회(위 useEffect) 때 되살아나지 않습니다.
    // 실패해도(서버가 꺼져 있는 등) 화면은 이미 지워진 대로 진행합니다 — 다음에 서버가 살아났을 때
    // 다시 지우면 됩니다.
    if (target?.coreId) {
      deleteCoreConsultation(target.coreId).catch(() => {});
    }
  };

  return (
    <div className="dashboardScreen">
      <DashboardHeader role={role} activeView={activeView} onViewChange={changeActiveView} onLogout={onLogout} currentUser={currentUser} unreadCount={unreadCount} />
      {role === 'counselor' ? <CounselorDashboard consultations={consultations} setConsultations={setConsultations} onCreateConsultation={createConsultation} onRequestLegalReview={requestLegalReview} onAnalysisSaved={notifyAnalysisSaved} onDeleteConsultation={deleteConsultation} onOpenConsultationForm={() => changeActiveView('상담 등록')} onOpenAnalysis={(id) => { setFocusedConsultationId(id); setActiveView('기타'); }} onOpenDraft={(id) => { setFocusedConsultationId(id); setActiveView('서식 생성'); }} onGoToDashboard={() => changeActiveView('대시보드')} activeView={activeView} currentUser={currentUser} onUpdateProfile={onUpdateProfile} notifications={notifications} onReadNotifications={markNotificationsRead} onDeleteNotification={deleteNotification} onOpenNotification={openNotification} onNotify={addNotification} focusedConsultationId={focusedConsultationId} /> : null}
      {role === 'lawyer' ? <LawyerDashboard reviews={reviews} setReviews={setReviews} consultations={consultations} onReviewDecision={applyReviewDecision} onDocumentReviewDecision={applyDocumentReviewDecision} onGoToDashboard={() => changeActiveView('대시보드')} activeView={activeView} currentUser={currentUser} onUpdateProfile={onUpdateProfile} notifications={notifications} onReadNotifications={markNotificationsRead} onDeleteNotification={deleteNotification} onOpenNotification={openNotification} onNotify={addNotification} focusedReviewCaseNo={focusedReviewCaseNo} /> : null}
      {role === 'admin' ? <AdminDashboard users={users} onUpdateUserStatus={onUpdateUserStatus} consultations={consultations} reviews={reviews} activeView={activeView} currentUser={currentUser} onUpdateProfile={onUpdateProfile} notifications={notifications} onReadNotifications={markNotificationsRead} onDeleteNotification={deleteNotification} onOpenNotification={openNotification} /> : null}
    </div>
  );
}
function App() {
  const [page, setPage] = useState('login');
  const [rememberId, setRememberId] = useState(() => Boolean(window.localStorage.getItem('rememberedEmail')));
  const [loginForm, setLoginForm] = useState(() => ({
    email: window.localStorage.getItem('rememberedEmail') || '',
    password: '',
  }));
  const [loginError, setLoginError] = useState('');
  // 회원가입 직후 로그인 화면으로 돌아왔을 때 "관리자 승인 대기중입니다" 같은 안내를 보여줍니다.
  // loginError(빨강, 실패)와는 성격이 달라 별도 상태로 관리하고, 사용자가 입력을 다시 시작하면 지웁니다.
  const [loginNotice, setLoginNotice] = useState('');
  const [loginPending, setLoginPending] = useState(false);
  const [registerError, setRegisterError] = useState('');
  const [registerPending, setRegisterPending] = useState(false);
  const [registeredRole, setRegisteredRole] = useState(() => {
    const savedRole = window.localStorage.getItem('registeredRole');
    return ['counselor', 'lawyer', 'admin'].includes(savedRole) ? savedRole : 'counselor';
  });
  const [users, setUsers] = useState(() => readStorage(storageKeys.users, JSON.parse(window.localStorage.getItem('registeredUsers') || '[]')).map(stripSensitiveUserFields));
  const [currentUserEmail, setCurrentUserEmail] = useState('');
  useEffect(() => {
    writeStorage(storageKeys.users, users);
    window.localStorage.setItem('registeredUsers', JSON.stringify(users));
    // 앱 시작 시 한 번, 예전 버전에서 남긴 평문 비밀번호 필드를 제거합니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 로그인한 계정의 JWT입니다. 지금은 관리자 승인/거절 API만 이 토큰을 요구하지만,
  // 앞으로 보호되는 엔드포인트가 늘어나도 여기 하나만 갱신하면 되도록 모아둡니다.
  const [authToken, setAuthToken] = useState(() => readTextStorage(storageKeys.authToken, ''));
  const persistAuthToken = (token) => {
    setAuthToken(token || '');
    writeTextStorage(storageKeys.authToken, token || '');
  };
  const persistUsers = (nextUsers) => {
    const safeUsers = nextUsers.map(stripSensitiveUserFields);
    setUsers(safeUsers);
    writeStorage(storageKeys.users, safeUsers);
    window.localStorage.setItem('registeredUsers', JSON.stringify(safeUsers));
  };
  const handleLogin = async (event) => {
    event.preventDefault();
    if (loginPending) return;
    setLoginPending(true);
    try {
      // 실제 백엔드(core-api)가 이메일/비밀번호 대조, 승인 대기·거절 차단을 전부 처리합니다.
      // 여기서 로컬로 다시 검사하지 않고, 성공/실패 모두 백엔드 응답을 그대로 따릅니다.
      const auth = normalizeAuthResponse(await loginCoreUser({ email: loginForm.email, password: loginForm.password }));
      // 소속기관·연락처처럼 아직 백엔드에 없는 프로필 항목은, 이 브라우저에 저장된 값이 있으면
      // 그대로 이어받아 화면이 비어 보이지 않게 합니다. (다른 기기 최초 로그인 시엔 빈 값으로 시작)
      const existingLocal = users.find((user) => user.email === auth.email);
      const mergedUser = { ...(existingLocal || {}), ...auth, status: '승인' };
      persistUsers([mergedUser, ...users.filter((user) => user.email !== auth.email)]);
      persistAuthToken(auth.token);
      setLoginError('');
      setRegisteredRole(auth.role);
      setCurrentUserEmail(auth.email);
      appendAuditLog({ actor: auth.email, action: '로그인', target: auth.role });
      if (rememberId) {
        window.localStorage.setItem('rememberedEmail', auth.email);
      } else {
        window.localStorage.removeItem('rememberedEmail');
      }
      window.localStorage.setItem('registeredRole', auth.role);
      setPage('dashboard');
    } catch (error) {
      // "이메일 또는 비밀번호가 올바르지 않습니다" / "관리자 승인 대기 중인 계정입니다" /
      // "가입이 거절된 계정입니다" — 전부 백엔드(AuthService)가 내려주는 문구를 그대로 보여줍니다.
      setLoginError(error.message || '로그인에 실패했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setLoginPending(false);
    }
  };

  const handleQuickLogin = (role) => {
    // 가입 신청일이 없는 데모 계정도 실제 가입자와 동일하게 오늘 날짜로 채워, 관리자 화면에서 '-'로 비어 보이지 않게 합니다.
    const demoAccounts = {
      counselor: { name: '테스트', organization: '서울중앙지부 / 법률구조1부', branch: '서울중앙지부', department: '법률구조1부', phone: '010-1234-5601', email: 'demo.counselor@test.local', role: 'counselor', status: '승인', requestedAt: today },
      lawyer: { name: '테스트', organization: '서울중앙지부 / 송무부', branch: '서울중앙지부', department: '송무부', phone: '010-1234-5602', email: 'demo.lawyer@test.local', role: 'lawyer', status: '승인', requestedAt: today },
      admin: { name: '테스트', organization: '대한법률구조공단 / 운영팀', phone: '010-1234-5603', email: 'demo.admin@test.local', role: 'admin', status: '승인', requestedAt: today },
    };
    const demoUser = demoAccounts[role];
    if (!demoUser) return;
    persistUsers([demoUser, ...users.filter((user) => user.email !== demoUser.email)]);
    setLoginError('');
    setRegisteredRole(demoUser.role);
    setCurrentUserEmail(demoUser.email);
    appendAuditLog({ actor: demoUser.email, action: '테스트 빠른 로그인', target: demoUser.role });
    window.localStorage.setItem('registeredRole', demoUser.role);
    setPage('dashboard');
  };

  const currentUser = users.find((user) => user.email === currentUserEmail) || null;
  const updateProfile = ({ email, password, organization, phone }) => {
    if (!currentUser) return;
    const updatedUser = { ...currentUser, email, organization: organization ?? currentUser.organization, phone: phone ?? currentUser.phone };
    persistUsers(users.map((user) => user.email === currentUser.email ? updatedUser : user));
    setCurrentUserEmail(email);
    setLoginForm({ email, password: '' });
    if (rememberId) window.localStorage.setItem('rememberedEmail', email);
    appendAuditLog({
      actor: email,
      action: '프로필 수정',
      target: currentUser.role,
      metadata: {
        emailChanged: currentUser.email !== email,
        emailBefore: currentUser.email,
        emailAfter: email,
        organizationChanged: currentUser.organization !== organization,
        organizationBefore: currentUser.organization || '',
        organizationAfter: organization || '',
        phoneChanged: (currentUser.phone || '') !== (phone || ''),
        phoneBefore: currentUser.phone || '',
        phoneAfter: phone || '',
        passwordChanged: Boolean(password),
      },
    });
  };

  // 관리자가 상담원/변호사 가입 신청을 승인·거절합니다. 승인 전에는 handleLogin에서 로그인이 막힙니다.
  // 대상 계정이 실제 회원가입 API로 만들어져 backendId가 있으면 core-api의 승인/거절 엔드포인트도 함께 호출합니다.
  // (SecurityConfig가 ADMIN 토큰만 허용하므로 지금 로그인한 관리자의 authToken을 그대로 씁니다)
  const updateUserStatus = async (email, status) => {
    const target = users.find((user) => user.email === email);
    let coreSyncError = '';
    if (target?.backendId) {
      try {
        if (status === '승인') await approveCoreUser(target.backendId, authToken);
        if (status === '거절') await rejectCoreUser(target.backendId, authToken);
      } catch (error) {
        // core-api 호출이 실패해도(예: 서버가 꺼져 있음) 화면 진행은 막지 않고 로컬 상태는 반영합니다.
        // 대신 감사 로그에 실패 사실을 남겨, 나중에 실제 서버 데이터와 어긋난 계정을 추적할 수 있게 합니다.
        coreSyncError = error.message;
      }
    }
    persistUsers(users.map((user) => user.email === email ? { ...user, status } : user));
    appendAuditLog({ actor: currentUser?.email || '관리자', action: `계정 ${status}`, target: email, metadata: coreSyncError ? { coreSyncError } : {} });
  };

  // 회원가입 신청을 실제 API(POST /api/auth/register)로 보냅니다. 이메일 중복(409),
  // 서버 연결 실패 등은 registerError로 화면에 보여주고, 성공하면 이전과 같은 흐름(로그인 화면으로 복귀)을 유지합니다.
  const handleRegisterComplete = async (user) => {
    if (registerPending) return;
    setRegisterPending(true);
    try {
      const raw = await registerCoreUser({ name: user.name, role: user.role, email: user.email, password: user.password });
      // 상담원/변호사는 '대기' 상태로 가입되어 관리자 승인 전까지 로그인할 수 없고,
      // 관리자는 승인 절차 없이 즉시 사용 가능하도록(초기 관리자 부트스트랩 문제 방지) '승인'으로 등록합니다.
      // (백엔드도 AuthService.register에서 같은 규칙으로 approvalStatus를 정합니다)
      const registeredUser = { ...user, status: user.role === 'admin' ? '승인' : '대기', requestedAt: today, backendId: raw?.userId };
      persistUsers([registeredUser, ...users.filter((item) => item.email !== user.email)]);
      setRegisteredRole(user.role);
      setLoginForm({ email: user.email, password: '' });
      setLoginError('');
      setRegisterError('');
      // 상담원/변호사는 관리자 승인 전까지 로그인이 막힙니다(백엔드가 로그인 시 같은 문구로 다시 막아줍니다).
      // 가입 직후 로그인 화면에서 바로 이 사실을 알려줘야 "가입했는데 왜 로그인이 안 되지" 혼란이 없습니다.
      setLoginNotice(user.role === 'admin'
        ? '회원가입이 완료되었습니다. 바로 로그인해주세요.'
        : '회원가입 신청이 완료되었습니다. 관리자 승인 후 로그인하실 수 있습니다.');
      window.localStorage.setItem('registeredRole', user.role);
      appendAuditLog({ actor: user.email, action: '회원가입 신청', target: user.role, metadata: { name: user.name, email: user.email, organization: user.organization, role: user.role } });
      notifyAdminRegistrationRequest(registeredUser);
      setPage('login');
    } catch (error) {
      // "이미 가입된 이메일입니다: ..." 같은 백엔드 문구(409 Conflict)를 그대로 보여줍니다.
      setRegisterError(error.message || '회원가입에 실패했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setRegisterPending(false);
    }
  };

  const notifyAdminRegistrationRequest = (user) => {
    if (user.role === 'admin') return;
    const currentNotifications = readStorage(storageKeys.notifications, []);
    writeStorage(storageKeys.notifications, [{
      id: Date.now() + Math.random(),
      roles: ['admin'],
      title: '회원가입 승인 요청',
      message: `${user.name} · ${user.role === 'lawyer' ? '변호사' : '상담원'} · ${user.email}`,
      target: user.email,
      createdAt: new Date().toISOString(),
      readBy: [],
    }, ...currentNotifications]);
  };

  return (
    <LoadingProvider>
    <FeedbackProvider>
    <div className="app">
      {page === 'dashboard' ? null : <Header onLogin={() => setPage('login')} onRegister={() => setPage('register')} onHome={() => setPage('login')} hideLogin={page === 'login'} />}
      {page === 'login' ? (
        <form id="login-form" onSubmit={handleLogin}>
          <LoginPage
            loginForm={loginForm}
            loginError={loginError}
            loginNotice={loginNotice}
            loginPending={loginPending}
            rememberId={rememberId}
            onRememberChange={setRememberId}
            onLoginChange={(key, value) => {
              setLoginForm((current) => ({ ...current, [key]: value }));
              setLoginError('');
              setLoginNotice('');
            }}
            onRegister={() => setPage('register')}
            onForgotPassword={() => setPage('password')}
            onQuickLogin={handleQuickLogin}
            consultations={readStorage(storageKeys.consultations, initialConsultations)}
          />
        </form>
      ) : null}
      {page === 'register' ? (
        <RegisterPage
          onBack={() => setPage('login')}
          onComplete={handleRegisterComplete}
          registerError={registerError}
          registerPending={registerPending}
        />
      ) : null}
      {page === 'password' ? <PasswordFindPage users={users} onBack={() => setPage('login')} /> : null}
      {page === 'dashboard' ? <DashboardPage role={registeredRole} currentUser={currentUser} onUpdateProfile={updateProfile} onLogout={() => { appendAuditLog({ actor: currentUser?.email || '사용자', action: '로그아웃', target: registeredRole }); persistAuthToken(''); setCurrentUserEmail(''); setPage('login'); }} users={users} onUpdateUserStatus={updateUserStatus} /> : null}
      {page === 'dashboard' ? null : <Footer />}
    </div>
    </FeedbackProvider>
    </LoadingProvider>
  );
}

export default App;
