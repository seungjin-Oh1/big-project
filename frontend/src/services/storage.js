// 서버 저장소가 붙기 전까지 브라우저 localStorage에 임시 데이터를 보관합니다.
// 팀 API가 준비되면 이 파일을 실제 API 호출 계층으로 점진 교체합니다.
const STORAGE_PREFIX = 'legalAidPrototype';

export const storageKeys = {
  users: `${STORAGE_PREFIX}:users`,
  rememberedEmail: 'rememberedEmail',
  registeredRole: 'registeredRole',
  authToken: 'authToken',
  consultations: `${STORAGE_PREFIX}:consultations`,
  reviews: `${STORAGE_PREFIX}:reviews`,
  accounts: `${STORAGE_PREFIX}:accounts`,
  auditLogs: `${STORAGE_PREFIX}:auditLogs`,
  notifications: `${STORAGE_PREFIX}:notifications`,
  generatedDocuments: `${STORAGE_PREFIX}:generatedDocuments`,
  documentDraftSnapshots: `${STORAGE_PREFIX}:documentDraftSnapshots`,
  documentReviewQueue: `${STORAGE_PREFIX}:documentReviewQueue`,
  dismissedDocumentReviews: `${STORAGE_PREFIX}:dismissedDocumentReviews`,
  favoriteTemplates: `${STORAGE_PREFIX}:favoriteTemplates`,
  uploadDraft: `${STORAGE_PREFIX}:uploadDraft`,
};

function canUseStorage() {
  return typeof window !== 'undefined' && Boolean(window.localStorage);
}

export function readStorage(key, fallback) {
  if (!canUseStorage()) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStorage(key, value) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function readTextStorage(key, fallback = '') {
  if (!canUseStorage()) return fallback;
  return window.localStorage.getItem(key) || fallback;
}

export function writeTextStorage(key, value) {
  if (!canUseStorage()) return;
  if (value) {
    window.localStorage.setItem(key, value);
  } else {
    window.localStorage.removeItem(key);
  }
}

function stableStringify(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// 관리자 화면의 감사 로그 확인을 위한 간단한 해시 체인 로그입니다.
export function appendAuditLog({ actor = '시스템', action, target = '-', metadata = {} }) {
  const logs = readStorage(storageKeys.auditLogs, []);
  const previousHash = logs[0]?.currentHash || 'GENESIS';
  const entry = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    actor,
    action,
    target,
    metadata,
    previousHash,
  };
  const currentHash = hashText(`${previousHash}:${stableStringify(entry)}`);
  const nextLogs = [{ ...entry, currentHash }, ...logs];
  writeStorage(storageKeys.auditLogs, nextLogs);
  return nextLogs;
}

export function getAuditLogs() {
  return readStorage(storageKeys.auditLogs, []);
}

// 서식 선택 화면의 즐겨찾기(자주 쓰는 서식) 상태를 관리합니다.
export function getFavoriteTemplates() {
  return readStorage(storageKeys.favoriteTemplates, []);
}

export function toggleFavoriteTemplate(templateName) {
  const favorites = getFavoriteTemplates();
  const nextFavorites = favorites.includes(templateName)
    ? favorites.filter((item) => item !== templateName)
    : [...favorites, templateName];
  writeStorage(storageKeys.favoriteTemplates, nextFavorites);
  return nextFavorites;
}
