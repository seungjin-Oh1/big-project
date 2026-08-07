import React, { useEffect, useRef, useState } from 'react';

// 화면 전환과 전역 상태를 관리하는 프론트엔드 최상위 컴포넌트입니다.
import { Header, Footer, DashboardHeader } from './components/layout.jsx';
import { initialConsultations, initialReviews, today } from './constants.jsx';
import { LoginPage, RegisterPage, PasswordFindPage } from './pages/auth.jsx';
import { CounselorDashboard, LawyerDashboard, AdminDashboard } from './pages/dashboards.jsx';
import { hydrateAnalysisForDisplay, runConsultationAnalysis } from './pages/workflows/index.jsx';
import { appendAuditLog, readStorage, readTextStorage, storageKeys, writeStorage, writeTextStorage } from './services/storage.js';
import { LoadingProvider } from './components/loading.jsx';
import { FeedbackProvider, useToast } from './components/feedback.jsx';
import {
  approveCoreUser,
  createCoreAnalysis,
  createCoreConsultation,
  consultationMemosFromRow,
  deleteCoreConsultation,
  fetchCoreAnalyses,
  fetchCoreConsultations,
  fetchCoreUsers,
  loginCoreUser,
  mapCoreAnalysisResponse,
  mapCoreAttachmentsToLocal,
  mapCoreUserToLocal,
  normalizeAuthResponse,
  registerCoreUser,
  rejectCoreUser,
  saveCoreConsultationTranscript,
  updateCoreAnalysis,
  updateCoreConsultation,
  updateCoreConsultationStatus,
} from './services/coreApiClientV2.js';
import { findOngoingCallDraft } from './services/realtimeSessionStore.js';

// 헤더의 '통화 중' 배지에 쓸 사건 라벨·경과 시간을 계산합니다. 배지가 알아야 하는 건 이 두 가지뿐이라
// realtimeSessionStore가 돌려주는 원시 draft를 화면 문구로 바꾸는 이 변환은 App.jsx 쪽 책임으로 둡니다.
function buildOngoingCallBadge(draft, consultations) {
  if (!draft) return null;
  const targetCase = consultations.find((item) => String(item.id) === String(draft.consultationId));
  return {
    consultationId: draft.consultationId,
    label: targetCase?.caseNo || targetCase?.title || '진행 중인 상담',
    elapsedSeconds: draft.callStartedAt ? Math.max(0, Math.floor((Date.now() - draft.callStartedAt) / 1000)) : 0,
  };
}

function stripSensitiveUserFields(user) {
  const { password: _password, confirmPassword: _confirmPassword, ...safeUser } = user;
  return safeUser;
}

function coreAnalysisIdOf(row = {}) {
  return row.analysis_id ?? row.analysisId ?? row.id ?? '';
}

function coreAnalysisUpdatedAt(row = {}) {
  return row.updated_at || row.updatedAt || row.created_at || row.createdAt || '';
}

function coreAnalysisTime(row = {}) {
  const time = new Date(coreAnalysisUpdatedAt(row)).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function pickLatestCoreAnalysis(rows = []) {
  return [...rows]
    .filter((row) => coreAnalysisIdOf(row))
    .sort((left, right) => coreAnalysisTime(right) - coreAnalysisTime(left))[0] || null;
}

// 저장된 분석을 화면이 쓸 수 있는 모양으로 되살립니다.
//
// mapCoreAnalysisResponse는 계약(AI_ANALYSIS) 필드만 줍니다. 그런데 상담 분석 화면은
// modalities(입력자료 구성)·extractionDetail(첨부 읽기 결과)·sttPreview·verification처럼
// 계약에 없는 값도 그립니다. 그 넷은 로컬 목업(buildAnalysisResult)이 만들어 주던 것들입니다.
//
// 분석을 방금 돌린 직후에는 mergeContractAnalysisResponse가 둘을 합쳐 줘서 문제가 없는데,
// 새로고침 후 복원할 때는 그 병합이 없어 modalities가 undefined인 채로 화면에 들어가고
// `analysis.modalities.map(...)`에서 터져 흰 화면이 됐습니다.
// 복원할 때도 같은 병합을 거치게 해서 두 경로의 결과 모양을 맞춥니다.
function buildHydratedAnalysis(row, consultation) {
  if (!row) return null;
  return {
    coreAnalysisId: coreAnalysisIdOf(row),
    analysis: hydrateAnalysisForDisplay(row, consultation),
  };
}

// 로그인한 역할에 따라 상담원/변호사/관리자 대시보드를 분기합니다.
function DashboardPage({ role, currentUser, onUpdateProfile, onLogout, users, onUpdateUserStatus }) {
  // 상담원은 로그인하면 통화를 받을 준비부터 해야 하므로, 목록 화면(상담 현황)이 아니라
  // 실시간 상담 분석 화면으로 곧장 들어가게 합니다. 변호사·관리자는 검토 대기·운영 현황을
  // 먼저 훑어야 하는 업무라 기존대로 대시보드가 첫 화면입니다.
  const defaultView = role === 'counselor' ? '기타' : '대시보드';
  const [activeView, setActiveView] = useState(defaultView);
  const [focusedConsultationId, setFocusedConsultationId] = useState(null);
  // 추천 서식 카드에서 특정 서식의 '저장하고 초안 만들기'를 눌렀을 때, 서식 생성 화면이
  // 어떤 서식을 열어야 하는지 함께 전달합니다(코치 피드백: 추천 3개가 모두 같은 동작이었음).
  const [focusedTemplateName, setFocusedTemplateName] = useState(null);
  const [focusedReviewCaseNo, setFocusedReviewCaseNo] = useState(null);
  const [focusedAdminView, setFocusedAdminView] = useState(null);

  // ── 브라우저 뒤로가기 ──
  //
  // 이 앱은 라우터가 없어 화면 전환이 전부 state로만 일어납니다. 그래서 주소가 한 번도
  // 바뀌지 않고, 서식 생성 화면에서 뒤로가기를 누르면 앱 안에서 뒤로 가는 게 아니라
  // 이 페이지에 오기 전 방문지(새 탭이면 빈 페이지)로 나가버립니다.
  //
  // 주소를 화면마다 붙이는 것(#/서식생성 같은 것)은 activeView를 쓰는 모든 곳을 손봐야 해서
  // 범위가 큽니다. 여기서는 화면을 옮길 때 히스토리 항목만 하나 쌓아, 뒤로가기가 앱 안에서
  // 이전 화면으로 돌아가게 합니다. 첫 화면(대시보드)에서 한 번 더 누르면 그때는 밖으로 나갑니다
  // — 나갈 수 없게 가두지는 않습니다.
  useEffect(() => {
    const onPopState = (event) => {
      const view = event.state?.appView;
      // 우리가 쌓은 항목이면 그 화면으로 돌아가고, 아니면(앱 진입 이전 기록) 그대로 나갑니다.
      if (!view) return;
      setFocusedConsultationId(null);
      setFocusedReviewCaseNo(null);
      setActiveView(view);
    };
    window.addEventListener('popstate', onPopState);
    // 앱에 들어온 첫 상태를 기록해둬야, 두 번째 화면에서 뒤로가기했을 때 돌아올 자리가 있습니다.
    if (!window.history.state?.appView) {
      window.history.replaceState({ appView: defaultView }, '');
    }
    return () => window.removeEventListener('popstate', onPopState);
  }, [defaultView]);

  // 화면이 바뀌면 히스토리에 한 칸 쌓습니다. 뒤로가기가 되돌아갈 자리를 만드는 것이 목적이라
  // 주소(URL)는 건드리지 않습니다.
  const pushViewHistory = (nextView) => {
    if (window.history.state?.appView === nextView) return;
    window.history.pushState({ appView: nextView }, '');
  };

  const [consultations, setConsultations] = useState(() => readStorage(storageKeys.consultations, initialConsultations));
  const [reviews, setReviews] = useState(() => readStorage(storageKeys.reviews, initialReviews));
  const [notifications, setNotifications] = useState(() => readStorage(storageKeys.notifications, []));
  const showToast = useToast();

  // 상담원이 통화 중에 다른 메뉴를 보고 있어도 헤더에서 바로 알 수 있도록, 진행 중인 통화가
  // 있는지 1초마다 확인합니다(상담원이 아니면 확인할 필요가 없습니다).
  const [ongoingCallDraft, setOngoingCallDraft] = useState(null);
  useEffect(() => {
    if (role !== 'counselor') return undefined;
    const checkOngoingCall = () => setOngoingCallDraft(findOngoingCallDraft());
    checkOngoingCall();
    const timer = setInterval(checkOngoingCall, 1000);
    return () => clearInterval(timer);
  }, [role]);

  useEffect(() => {
    writeStorage(storageKeys.consultations, consultations);
  }, [consultations]);

  useEffect(() => {
    writeStorage(storageKeys.reviews, reviews);
  }, [reviews]);

  useEffect(() => {
    writeStorage(storageKeys.notifications, notifications);
  }, [notifications]);

  // consultations/reviews/notifications는 이 탭이 마운트될 때 딱 한 번만 localStorage에서 읽고,
  // 그 뒤로는 이 탭 안에서의 변경만 반영합니다. 그래서 상담원 탭에서 '변호사 검토 요청'을 보내도,
  // 이미 열려 있던 변호사 탭은 새로고침 전까지 그 사실을 전혀 모릅니다 — 검토 요청 알림(토스트)은
  // 뜨는데 정작 '법률구조 검토 요청' 목록 표는 비어 보이는 증상이 바로 이겁니다(그 표는 reviews를
  // 그대로 렌더링하지만, 알림을 눌러 여는 검토 모달은 consultations를 다시 훑어 사건을 찾아내는
  // 별도 경로라 우연히 동작함). 브라우저의 storage 이벤트는 "다른 탭"이 localStorage를 바꿨을 때만
  // 발생하므로, 그걸 받아 이 탭의 상태를 다시 읽어오면 새로고침 없이도 최신 데이터로 맞춰집니다.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.storageArea !== window.localStorage) return;
      if (event.key === storageKeys.consultations) {
        setConsultations(readStorage(storageKeys.consultations, initialConsultations));
      } else if (event.key === storageKeys.reviews) {
        setReviews(readStorage(storageKeys.reviews, initialReviews));
      } else if (event.key === storageKeys.notifications) {
        setNotifications(readStorage(storageKeys.notifications, []));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // 대시보드에 들어올 때 core-api에 저장된 상담 목록을 한 번 확인해, 이 브라우저 로컬 저장소에는
  // 없지만 서버에는 있는 상담(다른 기기에서 등록됐거나, 예전에 등록만 되고 이 브라우저 캐시가
  // 지워진 경우)을 찾아 추가합니다. 이미 로컬에 있는 상담(coreId로 식별)의 필드는 절대 덮어쓰지
  // 않습니다 — core-api Consultation에는 분석·첨부·법률구조 대상 여부 같은 로컬 전용 필드가 없어서,
  // 통째로 덮어쓰면 상담원이 화면에서 입력해둔 내용이 사라집니다.
  //
  // 로그인 계정이 바뀌면 이전 계정의 목록은 통째로 버립니다. core-api는 상담원에게 본인
  // 상담만 돌려주지만, 이 병합은 "서버에 있는데 로컬에 없는 것"만 더하는 방식이라 이전
  // 계정의 상담을 지워주지 않습니다. 그대로 두면 계정을 바꿔 로그인해도 앞사람의 상담이
  // 계속 보입니다 — 민원인 이름·연락처·사건 내용이 담긴 목록이라 그러면 안 됩니다.
  useEffect(() => {
    let cancelled = false;
    const ownerEmail = currentUser?.email || '';
    const previousOwner = readTextStorage(storageKeys.consultationsOwner, '');
    // 소유자 기록이 아직 없으면(이 기능이 들어오기 전부터 쓰던 브라우저) 목록을 건드리지 않고
    // 소유자만 적어둡니다. 여기서 비우면 서버에 없고 브라우저에만 있던 상담까지 날아갑니다.
    // 계정을 실제로 바꿔 로그인하는 때부터 정리가 동작합니다.
    const accountChanged = Boolean(ownerEmail) && Boolean(previousOwner) && previousOwner !== ownerEmail;
    if (ownerEmail && previousOwner !== ownerEmail) {
      writeTextStorage(storageKeys.consultationsOwner, ownerEmail);
    }
    fetchCoreConsultations()
      .then((serverRows) => {
        if (cancelled || !Array.isArray(serverRows)) return;
        setConsultations((currentItems) => {
          const items = accountChanged ? [] : currentItems;
          const serverByCoreId = new Map(serverRows.map((row) => [row.id, row]));
          // 첨부파일은 다른 필드(메모·법률구조 대상 등)와 달리 로컬 전용 값이 없습니다 — 추가/삭제가
          // 항상 core-api(Attachment 테이블)를 거쳐 확정되므로, 서버 응답이 항상 진실입니다.
          // 그래서 다른 필드는 로컬 값을 지키되(덮어쓰지 않음), attachments만은 서버 목록으로 완전히
          // 맞춰씁니다 — 그래야 이미 삭제된 파일이 새로고침 후 되살아나 보이는 문제가 재발하지 않습니다.
          const mergedItems = items.map((item) => {
            if (!item.coreId) return item;
            const serverRow = serverByCoreId.get(item.coreId);
            if (!serverRow) return item;
            return { ...item, attachments: mapCoreAttachmentsToLocal(serverRow) };
          });
          const knownCoreIds = new Set(items.map((item) => item.coreId).filter(Boolean));
          const missingRows = serverRows.filter((row) => !knownCoreIds.has(row.id));
          if (!missingRows.length) return mergedItems;
          let nextLocalId = mergedItems.length ? Math.max(...mergedItems.map((item) => item.id)) : 0;
          const additions = missingRows.map((row) => {
            nextLocalId += 1;
            return {
              id: nextLocalId,
              caseNo: `C-CORE-${row.id}`,
              coreId: row.id,
              name: row.clientName || '이름 미입력',
              title: row.title || '제목 미입력',
              // 전화/대면 메모와 각 개인정보 가림본까지 되살립니다. 예전에는 memo에 inputText
              // (두 채널 합본)만 넣어서, 다른 PC나 변호사 계정으로 열면 대면 녹음 결과와
              // 가림본이 통째로 비어 보였습니다 — "개인정보가 가려진 상담 내용" 카드가 정작
              // 검토자 화면에서 항상 비어 있던 원인입니다.
              ...consultationMemosFromRow(row),
              opponentName: row.opponentName || '',
              status: '진행 중',
              date: (row.createdAt || '').slice(0, 10) || today,
              registeredTime: '',
              workflowStatus: '상담 접수',
              counselor: null,
              logs: [],
              analysis: null,
              attachments: mapCoreAttachmentsToLocal(row),
            };
          });
          return [...additions, ...mergedItems];
        });
      })
      .catch(() => {
        // Core API가 꺼져 있어도 로컬 저장소 데이터로 화면은 그대로 동작해야 하므로 조용히 넘어갑니다.
        // 다만 계정이 바뀐 상황에서는 앞사람 목록을 남겨두면 안 되므로 비웁니다.
        if (!cancelled && accountChanged) setConsultations([]);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.email]);

  const hydrateConsultationsWithCoreAnalyses = (analysisResults, candidateCases) => {
    const analysisByCoreId = new Map();
    analysisResults.forEach((result, index) => {
      if (result.status !== 'fulfilled' || !Array.isArray(result.value)) return;
      const latest = pickLatestCoreAnalysis(result.value);
      // 상담을 함께 넘겨야 첨부·메모 기반 값(입력자료 구성, 첨부 읽기 결과)이 채워집니다.
      const hydrated = buildHydratedAnalysis(latest, candidateCases[index]);
      if (hydrated) analysisByCoreId.set(candidateCases[index].coreId, hydrated);
    });
    if (!analysisByCoreId.size) return;

    setConsultations((items) => items.map((item) => {
      const hydrated = analysisByCoreId.get(item.coreId);
      if (!hydrated) return item;
      // 방금 돌린 분석이 아직 저장 전이면 서버 값으로 덮지 않습니다.
      //
      // 이 함수는 "서버에 있는데 브라우저에 없는" 분석을 되살리려고 있습니다. 그런데
      // 상담원이 재분석을 막 돌린 상태에서 이게 돌면, 화면에 뜬 새 결과가 예전에 저장한
      // 분석으로 되돌아갑니다 — 재분석을 해도 구조대상·체크리스트·누락자료가 그대로였던
      // 것이 이것입니다(실측: eligibility 대상 -> 판단보류, 누락자료 3건 -> 1건).
      //
      // 저장하면 이 표시가 지워지므로(notifyAnalysisSaved) 그 뒤로는 정상 동기화됩니다.
      //
      // 다만 '지킬 내용이 있을 때'만 막습니다. 이 표시는 분석을 시작하는 순간 붙는데
      // (analysisHelpers), 그 분석이 실패하거나 저장 없이 끝나면 요약이 빈 채로 표시만
      // 남습니다. 그러면 서버에 멀쩡한 분석이 있어도 영영 복원되지 않습니다 — 법령·판례
      // 화면이 계속 "이 상담은 아직 분석 전입니다"를 띄우고 추천을 아예 호출하지 않는
      // 상태가 됩니다(실측: 상담 55, DB에는 요약 265자가 저장돼 있었다).
      if (item.analysis?.pendingServerSave && item.analysis?.summary) return item;
      const sameAnalysis = item.coreAnalysisId && String(item.coreAnalysisId) === String(hydrated.coreAnalysisId);
      if (sameAnalysis && item.analysis?.summary === hydrated.analysis.summary) return item;
      return {
        ...item,
        analysis: {
          ...(item.analysis || {}),
          ...hydrated.analysis,
        },
        coreAnalysisId: hydrated.coreAnalysisId,
        workflowStatus: item.workflowStatus || '상담 분석',
      };
    }));
  };

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
        hydrateConsultationsWithCoreAnalyses(results, candidateCases);
        setReviews((currentReviews) => {
          // 한 상담에 SUBMITTED_FOR_REVIEW 분석이 여러 건 올라온 경우 같은 건을 두 번
          // 처리하지 않기 위한 것입니다. 예전에는 여기에 '이미 reviews에 있는 건'까지
          // 미리 담아 두고 건너뛰었는데, 그러면 검토 요청 뒤에 저장된 내용이 변호사
          // 화면에 영영 반영되지 않았습니다 — 상담원이 법령·판례를 담아 저장해도
          // '담아둔 법령·판례 없음'으로 남았습니다(DB에는 들어가 있는데도).
          // 이미 있는 건은 건너뛰는 대신, 아래 merge에서 분석 내용만 갱신합니다.
          const known = new Set();
          // requestLegalReview는 상담(target.id) 하나당 review 행 하나만 유지합니다(재요청 시
          // 새로 추가하지 않고 기존 행을 덮어씀). 여기서도 같은 규칙을 지켜야 합니다 — 그렇지 않으면
          // 반려/수정 요청 후 상담원이 새 분석을 다시 제출했을 때, 이전 분석의 review 행을 그대로 둔 채
          // id가 똑같은 새 행을 하나 더 추가하게 됩니다. reviews.find/map은 모두 id로 찾기 때문에,
          // 이렇게 id가 중복되면 변호사가 새 검토를 승인/반려해도 옛 행까지 같이 바뀌거나
          // (map이 id로 필터링), 옛 행이 먼저 잡혀 엉뚱한 coreAnalysisId로 승인 API가 불립니다.
          const upsertsByConsultationId = new Map();
          results.forEach((result, index) => {
            if (result.status !== 'fulfilled' || !Array.isArray(result.value)) return;
            const target = candidateCases[index];
            result.value
              .filter((row) => row.status === 'SUBMITTED_FOR_REVIEW')
              .forEach((row) => {
                const coreAnalysisId = coreAnalysisIdOf(row);
                const key = `${target.coreId}:${coreAnalysisId}`;
                if (known.has(key)) return;
                known.add(key);
                const mapped = mapCoreAnalysisResponse(row);
                upsertsByConsultationId.set(target.id, {
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
          if (!upsertsByConsultationId.size) return currentReviews;
          const existingIds = new Set(currentReviews.map((item) => item.id));
          const merged = currentReviews.map((item) => {
            const next = upsertsByConsultationId.get(item.id);
            if (!next) return item;
            // 같은 분석 건이 이미 화면에 있으면 진행 상태(승인/반려, 담당 변호사,
            // 요청일)는 이 브라우저 것이 최신이므로 그대로 두고, 서버에 저장된
            // 분석 내용만 최신으로 바꿔 끼웁니다. 통째로 덮으면 변호사가 방금 내린
            // 결정이 '검토 대기'로 되돌아갑니다.
            if (String(item.coreAnalysisId) === String(next.coreAnalysisId)) {
              return {
                ...item,
                type: next.type,
                summary: next.summary,
                urgency: next.urgency,
                eligibility: next.eligibility,
                analysis: next.analysis,
              };
            }
            return next;
          });
          const brandNew = Array.from(upsertsByConsultationId.entries())
            .filter(([id]) => !existingIds.has(id))
            .map(([, review]) => review);
          return [...brandNew, ...merged];
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

  // AI 분석 실행을 화면이 아니라 여기서 맡습니다.
  //
  // 분석은 40~70초 걸리는데, 그동안 상담원이 다른 상담을 보거나 새 전화를 받을 수 있어야
  // 합니다. 분석 화면 안에서 기다리면 화면을 옮기는 순간 컴포넌트와 함께 사라져서, 서버는
  // 계속 돌지만 결과를 받을 곳이 없어 그대로 버려집니다. App은 화면이 바뀌어도 살아있으므로
  // 여기서 돌리면 끝까지 진행되고, 끝났을 때 알림으로 알려줄 수 있습니다.
  //
  // 진행 중인 작업은 상담별로 들고 있습니다(여러 상담을 동시에 분석할 수 있음).
  const [analysisRuns, setAnalysisRuns] = useState({});
  // 중복 실행 검사에 state를 쓰면 직전 렌더의 값을 보게 되어(연타 시) 같은 분석이 두 번
  // 시작될 수 있습니다. 검사는 항상 최신인 ref로 합니다.
  const analysisRunIdsRef = useRef(new Set());

  const startConsultationAnalysis = async (consultation) => {
    const id = consultation?.id;
    if (!id || analysisRunIdsRef.current.has(id)) return { ok: false, alreadyRunning: true };

    analysisRunIdsRef.current.add(id);
    setAnalysisRuns((runs) => ({ ...runs, [id]: { elapsedSec: 0 } }));
    try {
      const { analysis, patch } = await runConsultationAnalysis(consultation, {
        onProgress: ({ elapsedMs }) => setAnalysisRuns((runs) => (
          runs[id] ? { ...runs, [id]: { elapsedSec: Math.floor(elapsedMs / 1000) } } : runs
        )),
      });
      setConsultations((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
      addNotification({
        roles: 'counselor',
        title: 'AI 분석 완료',
        message: `${consultation.caseNo || ''} ${consultation.title || ''}`.trim() || '상담 분석이 끝났습니다.',
        target: consultation.caseNo || '',
        view: '기타',
      });
      return { ok: true, analysis };
    } catch (error) {
      // 실패도 알림으로 남깁니다 — 다른 화면에 가 있으면 화면 안 메시지를 볼 수 없습니다.
      addNotification({
        roles: 'counselor',
        title: 'AI 분석 실패',
        message: `${consultation.caseNo || ''} ${error.message || '분석에 실패했습니다.'}`.trim(),
        target: consultation.caseNo || '',
        view: '기타',
      });
      return { ok: false, error };
    } finally {
      analysisRunIdsRef.current.delete(id);
      setAnalysisRuns((runs) => {
        const next = { ...runs };
        delete next[id];
        return next;
      });
    }
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
    if (role === 'admin') {
      // '바로 처리'를 눌러도 관리자 화면은 통계 요약(운영 현황)만 보여주고, 정작 승인 목록은
      // AdminDashboard 내부의 activeAdminView 상태(요약 카드 클릭으로만 바뀜)라서 한 번 더 클릭해야
      // 했습니다. 알림이 어떤 목록을 보여줘야 하는지 알려주면(notification.view) 그 목록으로 바로 열어줍니다.
      setFocusedAdminView(notification.view || null);
      setActiveView('대시보드');
      return;
    }
    setActiveView('대시보드');
  };
  const changeActiveView = (nextView) => {
    pushViewHistory(nextView);
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
      workflowStatus: '상담 접수',
      counselor: {
        name: currentUser?.name || '상담원',
        email: currentUser?.email || '',
        organization: currentUser?.organization || '',
      },
      logs: [{ status: '상담 접수', createdAt: today }],
      analysis: null,
      ...form,
      // form.attachments는 아직 서버가 확정하지 않은 클라이언트 쪽 echo(첨부파일 DB row id가 없음)라
      // "삭제" 버튼이 지울 대상을 특정할 수 없습니다. 방금 생성 응답(coreSync.attachments)에 서버가
      // 실제로 저장을 확정한 목록(attachmentId 포함)이 있으면 그걸 우선합니다.
      attachments: coreSync?.attachments?.length ? coreSync.attachments : (form.attachments || []),
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
        ? '상담이 등록되고 저장되었습니다.'
        : '상담이 등록되었습니다. 저장은 나중에 다시 시도할 수 있습니다.',
    };
  };

  // "분석 내용 저장"은 ai_analysis 테이블만 건드립니다 — Consultation(상담 원문)은 여기서
  // 다루지 않습니다(사용자 확인, 2026-08-04). 상담 원문 저장은 별도의 "상담 저장" 버튼
  // (saveConsultationTranscript, 아래)이 전담합니다.
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
      // 서식 추천/초안 생성 API(recommend-forms, generate-draft)는 상담 id뿐 아니라 이 분석 id도
      // 함께 있어야 호출할 수 있습니다. 응답은 AiAnalysisResponse라 snake_case(analysis_id)로 옵니다.
      const analysisId = savedAnalysis?.analysis_id || existingAnalysisId;
      // 저장한 내용을 화면이 들고 있는 상담에도 반영합니다. 예전에는 analysisId가
      // 새로 생겼을 때만 갱신해서, 서버에는 저장됐는데 다른 화면은 저장 전 값을
      // 계속 보여줬습니다 — 변호사가 담은 법령·판례를 저장해도 '담은 자료'
      // 화면이 비어 있던 것이 이 때문입니다(저장은 됐다고 뜨는데 안 보임).
      setConsultations((items) => items.map((item) => (item.id === consultation.id
        ? {
          ...item,
          // 서버에 들어갔으니 '저장 전' 표시를 지웁니다. 안 지우면 그 뒤로 서버
          // 동기화가 이 상담을 영원히 건너뜁니다(hydrateConsultationsWithCoreAnalyses).
          analysis: { ...(item.analysis || {}), ...analysis, pendingServerSave: false },
          coreAnalysisId: analysisId || item.coreAnalysisId,
        }
        : item)));
      // 이미 검토 요청이 올라간 상담이면 변호사 화면이 들고 있는 사본도 같이 고칩니다.
      // 그 사본은 검토 요청을 누른 그 순간의 스냅샷이라, 뒤에 담은 법령·판례는 서버에만
      // 들어가고 변호사 화면에는 안 보였습니다. 서버에서 다시 읽어오는 경로는 상담 목록이
      // 바뀔 때만 도는데, 같은 브라우저에서 역할만 바꾸면 그 경로가 돌지 않습니다.
      setReviews((items) => items.map((item) => (item.id === consultation.id
        ? { ...item, analysis: { ...(item.analysis || {}), ...analysis } }
        : item)));
      return { ok: true, synced: true, message: '분석 결과가 저장되었습니다.' };
    } catch (error) {
      return {
        ok: false,
        synced: false,
        message: `서버 저장 실패 — 이 브라우저에만 남았습니다. 다시 저장해주세요. (${error?.message || '원인 불명'})`,
      };
    }
  };

  // "상담 저장" 버튼 전용. 전화(memo)/대면(inpersonMemo) 채널의 현재 메모를 Consultation에
  // 반영합니다 — input_text 갱신 + call_input_texts/inperson_input_texts(_masked) 이력 append까지
  // 서버(ConsultationService.saveTranscript)가 한 번에 처리합니다. AI 분석(ai_analysis)은
  // 전혀 건드리지 않습니다 — notifyAnalysisSaved와 정반대로 역할이 나뉩니다.
  const saveConsultationTranscript = async (consultation) => {
    if (!consultation) return { ok: false, message: '상담 정보를 찾을 수 없습니다.' };
    if (!consultation.coreId) return { ok: true, synced: false, message: '로컬 저장 완료' };
    try {
      await saveCoreConsultationTranscript(consultation.coreId, {
        callInputText: consultation.memo || '',
        callInputTextMasked: consultation.memoMasked || '',
        inpersonInputText: consultation.inpersonMemo || '',
        inpersonInputTextMasked: consultation.inpersonMemoMasked || '',
      });
      // 상담받은 사람 이름도 여기서 함께 저장합니다.
      //
      // 이 이름은 서식 초안의 청구인이 되는 값입니다 — core-api가 초안을 만들 때
      // consultation.clientName을 그대로 ai-api로 넘깁니다. 그런데 이름칸은 여태
      // 화면 상태만 바꾸고 서버에는 아무것도 안 보냈습니다. 상담을 등록할 때 한 번
      // 보낸 값이 DB에 그대로 남아서, 화면에는 고친 이름이 보이는데 초안에는 옛
      // 이름(또는 빈칸)이 찍혔습니다.
      //
      // transcript API는 메모 전용이라(TranscriptSaveRequest에 이름 자리가 없음)
      // 이름은 상담 수정 API로 따로 보냅니다. 실패하면 아래 catch로 내려가
      // "저장 실패"가 화면에 뜹니다 — 조용히 넘어가면 상담원은 저장된 줄 압니다.
      if (consultation.name?.trim()) {
        await updateCoreConsultation(consultation.coreId, {
          clientName: consultation.name.trim(),
        });
      }
      return { ok: true, synced: true, message: '상담 내용이 저장되었습니다.' };
    } catch (error) {
      return {
        ok: false,
        synced: false,
        message: `상담 저장 실패 — 다시 시도해주세요. (${error?.message || '원인 불명'})`,
      };
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

  const applyReviewDecision = ({ id, status, reason, reviewer, recipientEmail, lawyerComment = '', editedSummary = '' }) => {
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
        // 변호사 코멘트는 결정 종류(승인 포함)와 무관하게 남길 수 있고, 편집한 요약이 있으면
        // 상담원이 보는 분석 요약 자체를 변호사가 다듬은 문장으로 바꿔둡니다.
        lawyerComment: lawyerComment || '',
        analysis: editedSummary && item.analysis ? { ...item.analysis, summary: editedSummary } : item.analysis,
        reviewAction: needsCounselorWork ? { status, reason: reason || '', reviewer: reviewer || null, recipientEmail: recipientEmail || item.counselor?.email || '', requestedAt: today, resolved: false, lawyerComment: lawyerComment || '' } : null,
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

  // 상담 삭제 시 연결된 검토 요청도 함께 정리합니다.
  // core-api에 등록된 상담(coreId 있음)은 반드시 서버 삭제가 성공한 뒤에만 화면에서 지웁니다.
  // 예전엔 화면에서 먼저 지우고 서버 삭제는 실패해도 무시했는데, 그러면 DB/S3에는 데이터가 그대로
  // 남은 채 화면만 지워진 것처럼 보이다가 다음 방문 때 위 동기화 useEffect가 서버에 남아있는 그
  // row를 "새로 생긴 상담"으로 착각해 되살려버렸습니다.
  const deleteConsultation = async (id) => {
    const target = consultations.find((item) => item.id === id);
    if (!target) return;

    if (target.coreId) {
      try {
        await deleteCoreConsultation(target.coreId);
      } catch (error) {
        // 서버에 이미 없는(404) 상담이면 삭제할 게 없다는 뜻이니 실패로 취급하지 않고
        // 화면에서도 마저 지웁니다 — 아니면 다른 탭/이전 요청으로 이미 지워진 상담이
        // 이 브라우저에서는 영영 안 지워지는 것처럼 보입니다.
        if (error.status !== 404) {
          showToast(`상담 삭제에 실패했습니다: ${error.message || '서버 오류'}`, 'warn');
          return;
        }
      }
    }

    setConsultations((items) => items.filter((item) => item.id !== id));
    setReviews((items) => items.filter((item) => item.id !== id));
    appendAuditLog({ actor: currentUser?.email || '상담원', action: '상담 삭제', target: target.caseNo || String(id) });
  };

  return (
    <div className="dashboardScreen">
      <DashboardHeader
        role={role}
        activeView={activeView}
        onViewChange={changeActiveView}
        onLogout={onLogout}
        currentUser={currentUser}
        unreadCount={unreadCount}
        // 지금 보고 있는 화면이 이미 실시간 상담(기타)이면 안에 같은 정보가 보이니 배지는 숨깁니다.
        ongoingCall={activeView === '기타' ? null : buildOngoingCallBadge(ongoingCallDraft, consultations)}
        onOpenOngoingCall={() => {
          if (!ongoingCallDraft) return;
          setFocusedConsultationId(ongoingCallDraft.consultationId);
          pushViewHistory('기타');
          setActiveView('기타');
        }}
      />
      {role === 'counselor' ? <CounselorDashboard consultations={consultations} setConsultations={setConsultations} onCreateConsultation={createConsultation} onRequestLegalReview={requestLegalReview} onAnalysisSaved={notifyAnalysisSaved} onSaveTranscript={saveConsultationTranscript} onDeleteConsultation={deleteConsultation} onOpenConsultationForm={() => changeActiveView('상담 등록')} onOpenAnalysis={(id) => { setFocusedConsultationId(id); pushViewHistory('기타'); setActiveView('기타'); }} onOpenDraft={(id, templateName) => { setFocusedConsultationId(id); setFocusedTemplateName(templateName || null); pushViewHistory('서식 생성'); setActiveView('서식 생성'); }} onGoToDashboard={() => changeActiveView('대시보드')} activeView={activeView} currentUser={currentUser} onUpdateProfile={onUpdateProfile} notifications={notifications} onReadNotifications={markNotificationsRead} onDeleteNotification={deleteNotification} onOpenNotification={openNotification} onNotify={addNotification} focusedConsultationId={focusedConsultationId} focusedTemplateName={focusedTemplateName} analysisRuns={analysisRuns} onStartAnalysis={startConsultationAnalysis} /> : null}
      {role === 'lawyer' ? <LawyerDashboard reviews={reviews} setReviews={setReviews} consultations={consultations} onReviewDecision={applyReviewDecision} onGoToDashboard={() => changeActiveView('대시보드')} activeView={activeView} currentUser={currentUser} onUpdateProfile={onUpdateProfile} notifications={notifications} onReadNotifications={markNotificationsRead} onDeleteNotification={deleteNotification} onOpenNotification={openNotification} onNotify={addNotification} onAnalysisSaved={notifyAnalysisSaved} focusedReviewCaseNo={focusedReviewCaseNo} /> : null}
      {role === 'admin' ? <AdminDashboard users={users} onUpdateUserStatus={onUpdateUserStatus} consultations={consultations} reviews={reviews} activeView={activeView} currentUser={currentUser} onUpdateProfile={onUpdateProfile} notifications={notifications} onReadNotifications={markNotificationsRead} onDeleteNotification={deleteNotification} onOpenNotification={openNotification} focusedAdminView={focusedAdminView} /> : null}
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
  // 관리자 화면(활성 사용자/승인 대기)이 이 브라우저에서 한 번도 로그인·회원가입하지 않은
  // 실제 가입자도 보여줄 수 있도록, core-api에 저장된 사용자 목록을 앱 시작 시 한 번 확인해
  // 이메일로 식별되는 새 계정만 추가합니다. 이미 로컬에 있는 계정(퀵 로그인 데모 계정 포함)은
  // 절대 덮어쓰지 않습니다 — 안 그러면 데모 계정이 실제 서버 승인 상태로 바뀌어 "테스트용 빠른
  // 로그인"이 매번 승인 대기로 막히게 됩니다.
  useEffect(() => {
    if (!authToken) return undefined;
    let cancelled = false;
    fetchCoreUsers()
      .then((serverRows) => {
        if (cancelled || !Array.isArray(serverRows)) return;
        const knownEmails = new Set(users.map((item) => item.email).filter(Boolean));
        const missing = serverRows.filter((row) => row.email && !knownEmails.has(row.email));
        if (!missing.length) return;
        persistUsers([...missing.map(mapCoreUserToLocal), ...users]);
      })
      .catch(() => {
        // core-api가 꺼져 있어도 로컬 계정으로 화면은 그대로 동작해야 하므로 조용히 넘어갑니다.
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);
  // 다른 탭에서 계정을 승인/거절하거나 새로 가입하면(localStorage 변경), 이 탭도 새로고침 없이
  // 반영합니다. storage 이벤트는 "다른 탭"이 바꿨을 때만 발생하므로 이 탭 자신의 변경과는 겹치지
  // 않습니다.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.storageArea !== window.localStorage) return;
      if (event.key !== storageKeys.users) return;
      setUsers(readStorage(storageKeys.users, []).map(stripSensitiveUserFields));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // 실제 백엔드(core-api)가 이메일/비밀번호 대조, 승인 대기·거절 차단을 전부 처리합니다.
  // 여기서 로컬로 다시 검사하지 않고, 성공/실패 모두 백엔드 응답을 그대로 따릅니다.
  // handleLogin(로그인 폼 제출)과 handleQuickLogin(마스터 계정 자동 로그인)이 이 로직을 함께 씁니다.
  const performLogin = async (email, password) => {
    if (loginPending) return;
    setLoginPending(true);
    try {
      const auth = normalizeAuthResponse(await loginCoreUser({ email, password }));
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

  const handleLogin = (event) => {
    event.preventDefault();
    return performLogin(loginForm.email, loginForm.password);
  };

  // 회원가입 절차 없이도 역할별(상담원/변호사/관리자) 마스터 계정으로 실제 로그인 플로우를 그대로
  // 태워볼 수 있도록, 자격 증명을 로그인 폼에 채우고 performLogin(=handleLogin과 동일한 제출 로직)을
  // 그대로 호출합니다. 계정 자체는 core-api의 MasterAccountInitializer가 기동 시 생성합니다.
  const masterAccountCredentials = {
    counselor: { email: 'test_talker@test.test', password: 'test1234' },
    lawyer: { email: 'test_lawyer@test.test', password: 'test1234' },
    admin: { email: 'test_admin@test.test', password: 'test1234' },
  };

  const handleQuickLogin = (role) => {
    const credentials = masterAccountCredentials[role];
    if (!credentials) return;
    setLoginForm({ email: credentials.email, password: credentials.password });
    return performLogin(credentials.email, credentials.password);
  };

  const currentUser = users.find((user) => user.email === currentUserEmail) || null;
  // 대시보드 하위 화면(변호사 검토 승인, 관리자 통계·감사 로그 등)은 currentUser.token으로 ADMIN/LAWYER
  // 전용 core-api를 호출합니다. authToken은 users 배열에 저장하지 않는 별도 상태라, 화면에 내려줄 때만
  // currentUser에 합쳐줍니다 — users 배열(및 그걸 그대로 쓰는 updateProfile)에는 절대 섞이면 안 됩니다.
  const currentUserForDisplay = currentUser ? { ...currentUser, token: authToken } : null;
  // 비밀번호는 여기서 다루지 않습니다 — ProfilePanel이 core-api(/api/auth/password)로 직접
  // 보내고, 여기에는 그 결과(passwordChanged)만 감사 로그용으로 전달됩니다.
  // 예전에는 password를 받고도 저장하지 않으면서 로그에는 '변경'으로 남겨, 어떤 값을 넣어도
  // 바뀌지 않는데 화면에는 저장됐다고 뜨는 상태였습니다.
  const updateProfile = ({ email, organization, phone, passwordChanged = false }) => {
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
        passwordChanged,
      },
    });
  };

  // 관리자가 상담원/변호사 가입 신청을 승인·거절합니다. 승인 전에는 handleLogin에서 로그인이 막힙니다.
  // 대상 계정이 실제 회원가입 API로 만들어져 backendId가 있으면 core-api의 승인/거절 엔드포인트도 함께 호출합니다.
  // (SecurityConfig가 ADMIN 토큰만 허용하므로 지금 로그인한 관리자의 authToken을 그대로 씁니다)
  // backendId가 있는 계정은 반드시 core-api 승인/거절이 성공한 뒤에만 화면에 반영합니다. 예전엔
  // core-api 호출이 실패해도(퀵 로그인 관리자는 authToken이 없어 항상 403) 화면은 무조건 "승인됨"
  // 으로 바꿔버렸는데, 그러면 실제 계정은 core-api에 여전히 PENDING으로 남아 그 계정으로 실제
  // 로그인을 시도하면 "관리자 승인 대기 중인 계정입니다"로 계속 막히면서도, 관리자 화면에는
  // 이미 승인된 것처럼 보이는 불일치가 생겼습니다.
  const updateUserStatus = async (email, status, backendIdFromRow) => {
    const target = users.find((user) => user.email === email);
    const backendId = backendIdFromRow || target?.backendId;
    if (!target && !backendId) return { ok: false, message: '대상 계정을 찾을 수 없습니다.' };

    if (backendId) {
      try {
        if (status === '승인') await approveCoreUser(backendId, authToken);
        if (status === '거절') await rejectCoreUser(backendId, authToken);
      } catch (error) {
        return {
          ok: false,
          message: `계정 ${status} 처리에 실패했습니다: ${error.message || '서버 오류'}`
            + (authToken ? '' : ' (테스트용 빠른 로그인은 실제 인증 토큰을 발급하지 않아 관리자 전용 API를 호출할 수 없습니다. 실제 관리자 계정으로 로그인해주세요.)'),
        };
      }
    }

    if (target) {
      persistUsers(users.map((user) => user.email === email ? { ...user, status } : user));
    }
    appendAuditLog({ actor: currentUser?.email || '관리자', action: `계정 ${status}`, target: email });
    return { ok: true };
  };

  // 회원가입 신청을 실제 API(POST /api/auth/register)로 보냅니다. 이메일 중복(409),
  // 서버 연결 실패 등은 registerError로 화면에 보여주고, 성공하면 이전과 같은 흐름(로그인 화면으로 복귀)을 유지합니다.
  const handleRegisterComplete = async (user) => {
    if (registerPending) return;
    setRegisterPending(true);
    try {
      const raw = await registerCoreUser({
        name: user.name, role: user.role, email: user.email, password: user.password,
        privacyAgreed: user.privacyAgreed,
      });
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
      view: 'pendingUsers',
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
      {page === 'dashboard' ? <DashboardPage role={registeredRole} currentUser={currentUserForDisplay} onUpdateProfile={updateProfile} onLogout={() => { appendAuditLog({ actor: currentUser?.email || '사용자', action: '로그아웃', target: registeredRole }); persistAuthToken(''); setCurrentUserEmail(''); setPage('login'); }} users={users} onUpdateUserStatus={updateUserStatus} /> : null}
      {page === 'dashboard' ? null : <Footer />}
    </div>
    </FeedbackProvider>
    </LoadingProvider>
  );
}

export default App;
