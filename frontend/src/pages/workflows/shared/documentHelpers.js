// 서식 초안 검토 상태(DocumentReviewStatus, backend/core-api)를 화면에 보여줄 라벨/톤으로 바꿉니다.
export const DOCUMENT_STATUS_LABEL = {
  DRAFTED: '초안 작성됨 (검토 요청 전)',
  SUBMITTED_FOR_REVIEW: '변호사 검토 요청됨',
  APPROVED: '변호사 승인 완료',
  REVISION_REQUESTED: '반려됨 (수정 필요)',
};
export function documentStatusTone(status) {
  if (status === 'APPROVED') return 'success';
  if (status === 'REVISION_REQUESTED') return 'danger';
  if (status === 'SUBMITTED_FOR_REVIEW') return 'info';
  return 'muted';
}
export function normalizeGeneratedDocument(response = {}) {
  return {
    documentId: response.document_id || response.documentId || response.local_key,
    consultationId: response.consultation_id || response.consultationId || '',
    status: response.status || 'DRAFTED',
    formName: response.form_name || response.formName || '',
    requestedFormName: response.requested_form_name || response.requestedFormName || '',
    draftFilePath: response.draft_file_path || response.draftFilePath || response.file || '',
    downloadFileName: response.download_file_name || response.downloadFileName || '',
    draftContent: response.draft_content || response.draftContent || '',
    source: response.source || 'core-api',
    localKey: response.local_key || '',
  };
}

// 같은 상담에서 동일한 서식이 여러 번 생성되면 API는 각각 다른 document_id를
// 가진 문서로 반환합니다. 화면에서는 가장 최근 버전만 기본 노출해 중복처럼 보이지
// 않게 하되, 실제 서버 문서 자체를 삭제하지는 않습니다.
export function dedupeDocumentsByForm(documents = []) {
  const latestByForm = new Map();
  documents.forEach((document, index) => {
    const formName = String(document.requested_form_name || document.form_name || document.formName || '').trim().toLowerCase();
    const key = formName || `document:${document.document_id || document.documentId || index}`;
    const current = latestByForm.get(key);
    const timestamp = Date.parse(document.updated_at || document.updatedAt || document.created_at || document.createdAt || document.submitted_at || '') || 0;
    const currentTimestamp = current ? (Date.parse(current.updated_at || current.updatedAt || current.created_at || current.createdAt || current.submitted_at || '') || 0) : -1;
    if (!current || timestamp > currentTimestamp || (timestamp === currentTimestamp && index < current.index)) {
      latestByForm.set(key, { document, index });
    }
  });
  return [...latestByForm.values()].sort((left, right) => left.index - right.index).map(({ document }) => document);
}

export function buildDocumentDiffSegments(originalContent = '', editedContent = '') {
  if (originalContent === editedContent) return [{ text: editedContent, changed: false }];
  const originalTokens = String(originalContent).match(/\s+|[^\s]+/g) || [];
  const editedTokens = String(editedContent).match(/\s+|[^\s]+/g) || [];
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
    } else if (table[originalIndex + 1][editedIndex] >= table[originalIndex][editedIndex + 1]) originalIndex += 1;
    else {
      rawSegments.push({ text: editedTokens[editedIndex], changed: true });
      editedIndex += 1;
    }
  }
  while (editedIndex < editedTokens.length) {
    rawSegments.push({ text: editedTokens[editedIndex], changed: true });
    editedIndex += 1;
  }
  return rawSegments.reduce((result, segment) => {
    const previous = result[result.length - 1];
    if (previous && previous.changed === segment.changed) previous.text += segment.text;
    else result.push({ ...segment });
    return result;
  }, []);
}

// 예전엔 서버가 돌려준 원문 예외 메시지(예: "I/O error on POST request for
// "http://localhost:8001/forms/draft": null")와 내부 서비스 이름('ai-api')을 그대로
// 보여줘서, 상담원이 읽어도 무엇을 해야 할지 알 수 없었습니다(코치 피드백: 개발자 용어를
// 유저 친화적으로). 원인을 알 수 있을 때만 짧게 덧붙이고, 항상 다음 행동을 안내합니다.
export function draftGenerationErrorMessage(error) {
  const isConnectionIssue = /I\/O error|Connection refused|ECONNREFUSED|timeout/i.test(error?.message || '');
  const reason = isConnectionIssue ? ' · 서식 생성 서버에 연결하지 못했습니다' : '';
  return `HWPX 생성에 실패했습니다${reason}. 잠시 후 다시 시도하거나 관리자에게 문의해 주세요.`;
}
