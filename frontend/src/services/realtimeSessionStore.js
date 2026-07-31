import { readStorage, storageKeys, writeStorage } from './storage.js';

// '실시간 상담' 화면(AnalysisWorkbench)은 사건 하나를 열어두고 통화 → 메모 → AI 분석 → 저장 →
// 검토 요청 순서로 진행됩니다. 그런데 상담원이 통화 중에 다른 메뉴(상담 현황, 알림 등)를 잠깐
// 눌렀다가 돌아오면 이 화면 컴포넌트가 통째로 다시 마운트되면서, 아직 '분석 저장'을 누르지 않은
// 통화 타이머·AI 분석 결과·검토 반영 항목이 전부 사라집니다. 상담원 업무 부담을 줄이자는 코치
// 피드백의 취지에 정면으로 어긋나는 문제라, 저장 전 진행 상태를 사건별로 잠깐 보관해 뒀다가
// 같은 사건으로 돌아오면 그대로 이어서 볼 수 있게 합니다.
//
// 여기서 다루는 것은 어디까지나 '저장 전 임시 진행 상태'입니다. '분석 저장'을 누른 뒤의 정식
// 데이터는 core-api/consultations(App.jsx state)가 갖고 있으므로, 그 이후에는 이 임시 상태를 지웁니다.

// 실제 통화 연동 없이 상담원이 직접 버튼을 눌러 관리하는 상태라, 브라우저를 오래 열어둔 채
// 방치된 '진행 중' 표시를 언제까지고 진짜처럼 보여주면 오히려 혼란을 줍니다. 이 시간이 지난
// ongoing 기록은 복원하지 않고 새로 시작한 것으로 취급합니다.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6시간

function readAllDrafts() {
  return readStorage(storageKeys.realtimeSessionDrafts, {});
}

function writeAllDrafts(drafts) {
  writeStorage(storageKeys.realtimeSessionDrafts, drafts);
}

function isStaleOngoingDraft(draft) {
  return draft.callStatus === 'ongoing' && Date.now() - (draft.callStartedAt || 0) > STALE_AFTER_MS;
}

// 사건 하나의 진행 중 상태를 읽습니다. 없거나, 오래 방치된 '통화 중' 기록이면 null을 돌려줘
// 화면이 새로 시작한 것처럼 안전하게 초기화되도록 합니다.
export function readRealtimeSessionDraft(consultationId) {
  if (consultationId == null) return null;
  const draft = readAllDrafts()[consultationId];
  if (!draft || isStaleOngoingDraft(draft)) return null;
  return draft;
}

// 통화 상태나 분석 내용이 바뀔 때마다 호출해 사건별로 최신 진행 상태를 남깁니다.
export function saveRealtimeSessionDraft(consultationId, draft) {
  if (consultationId == null) return;
  writeAllDrafts({ ...readAllDrafts(), [consultationId]: { ...draft, updatedAt: Date.now() } });
}

// 분석을 저장했거나(core-api로 정식 이관) 상담원이 처음부터 다시 시작할 때, 더 이상 필요 없는
// 임시 진행 상태를 지웁니다.
export function clearRealtimeSessionDraft(consultationId) {
  if (consultationId == null) return;
  const drafts = readAllDrafts();
  if (!(consultationId in drafts)) return;
  const nextDrafts = { ...drafts };
  delete nextDrafts[consultationId];
  writeAllDrafts(nextDrafts);
}

// 지금 통화 중인 사건이 있으면(다른 메뉴에 가 있어도) 화면 상단에서 바로 알 수 있도록,
// 사건을 가리지 않고 '통화 중' 상태인 기록을 하나 찾아줍니다. 동시에 두 통화를 받을 수는 없으므로
// 하나만 있으면 충분합니다.
export function findOngoingCallDraft() {
  const drafts = readAllDrafts();
  const ongoingEntry = Object.entries(drafts).find(([, draft]) => !isStaleOngoingDraft(draft) && draft.callStatus === 'ongoing');
  if (!ongoingEntry) return null;
  const [consultationId, draft] = ongoingEntry;
  return { consultationId, ...draft };
}
