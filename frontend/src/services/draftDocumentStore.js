import { readStorage, storageKeys, writeStorage } from './storage.js';

function snapshotKey(snapshot = {}) {
  if (snapshot.documentId) return `doc:${snapshot.documentId}`;
  if (snapshot.localKey) return `local:${snapshot.localKey}`;
  return `case:${snapshot.consultationId || ''}:${snapshot.caseNo || ''}:${snapshot.formName || ''}`;
}

function normalizeFormName(document = {}) {
  return document.requested_form_name
    || document.requestedFormName
    || document.form_name
    || document.formName
    || '';
}

function readSnapshots() {
  return readStorage(storageKeys.documentDraftSnapshots, []);
}

function writeSnapshots(items) {
  writeStorage(storageKeys.documentDraftSnapshots, items);
  return items;
}

export function rememberDraftDocumentSnapshot({ consultation, document, draftContent, draftFilePath, downloadFileName }) {
  const nextSnapshot = {
    key: snapshotKey({
      documentId: document?.documentId || document?.document_id || '',
      localKey: document?.localKey || document?.local_key || '',
      consultationId: document?.consultationId || document?.consultation_id || consultation?.coreId || consultation?.id || '',
      caseNo: consultation?.caseNo || '',
      formName: normalizeFormName(document),
    }),
    documentId: document?.documentId || document?.document_id || '',
    localKey: document?.localKey || document?.local_key || '',
    consultationId: document?.consultationId || document?.consultation_id || consultation?.coreId || consultation?.id || '',
    caseNo: consultation?.caseNo || '',
    formName: normalizeFormName(document),
    draftContent: draftContent || document?.draftContent || document?.draft_content || '',
    draftFilePath: draftFilePath || document?.draftFilePath || document?.draft_file_path || '',
    downloadFileName: downloadFileName || document?.downloadFileName || document?.download_file_name || '',
    updatedAt: new Date().toISOString(),
  };

  const snapshots = readSnapshots();
  return writeSnapshots([nextSnapshot, ...snapshots.filter((item) => item.key !== nextSnapshot.key)]);
}

// hydrateDraftDocument 내부에서만 쓰여 더 이상 export하지 않습니다(외부 import 없음).
function findDraftDocumentSnapshot(document = {}, context = {}) {
  const snapshots = readSnapshots();
  const directKey = snapshotKey({
    documentId: document.documentId || document.document_id || '',
    localKey: document.localKey || document.local_key || '',
    consultationId: document.consultationId || document.consultation_id || context.consultationId || '',
    caseNo: context.caseNo || '',
    formName: normalizeFormName(document),
  });
  const direct = snapshots.find((item) => item.key === directKey);
  if (direct) return direct;

  const consultationId = document.consultationId || document.consultation_id || context.consultationId || '';
  const caseNo = context.caseNo || '';
  const formName = normalizeFormName(document);
  return snapshots.find((item) => (
    String(item.consultationId || '') === String(consultationId || '')
    && String(item.caseNo || '') === String(caseNo || '')
    && String(item.formName || '') === String(formName || '')
  )) || null;
}

export function hydrateDraftDocument(document = {}, context = {}) {
  const snapshot = findDraftDocumentSnapshot(document, context);
  if (!snapshot) return document;

  return {
    ...document,
    draft_content: document.draft_content || snapshot.draftContent || '',
    draft_file_path: document.draft_file_path || snapshot.draftFilePath || '',
    download_file_name: document.download_file_name || snapshot.downloadFileName || '',
  };
}
