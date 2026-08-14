import React, { useState } from 'react';
import { FileText, CheckCircle2, XCircle, Download } from 'lucide-react';
import { coreAuthHeader, buildCoreDocumentDownloadUrl } from '../../../services/coreApiClientV2.js';
import { createClientHwpxDraft } from '../../../services/clientHwpxGenerator.js';
import { generatedFileName } from '../shared/formatters.js';

function ensureHwpxFileName(fileName, fallback = '서식초안') {
  const normalized = String(fileName || fallback).trim().replace(/[\\/:*?"<>|]/g, '_');
  const baseName = normalized || fallback;
  return /\.hwpx$/i.test(baseName) ? baseName : `${baseName}.hwpx`;
}

// label을 넘기면 그 문구를 표시 이름으로 쓰고(예: '조정신청서 초안 파일'), 안 넘기면 예전처럼
// 실제 저장 파일명을 그대로 보여줍니다. 서버가 생성하는 파일명은 사람이 알아보기 어려운 무작위
// 식별자라, 변호사 검토 화면처럼 이미 서식명을 알고 있는 곳에서는 label로 바꿔 보여주는 게 낫습니다.
// consultationId+documentId를 넘기면(=core-api에 실제 저장된 문서) 새로 생긴 다운로드 API로
// 진짜 파일을 받는 링크를 만듭니다. 없으면(로컬 전용 문서) 예전처럼 draft_file_path 자체를
// 링크로 쓸 수 있는지만 확인합니다(blob: URL 등).
// core-api가 인증을 요구하게 되면서 <a href>로는 더 이상 받을 수 없습니다. 브라우저가 주소만
// 열고 Authorization 헤더를 실어주지 않아 401이 나기 때문입니다.
// fetch로 받아 blob으로 만든 뒤, 그 blob을 가리키는 임시 링크를 클릭시켜 저장합니다.
// 사용자가 보는 동작(눌러서 내려받기)은 그대로입니다.
function ServerDocumentDownloadButton({ url, fileName, className = '' }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  if (!url) return null;

  const handleDownload = async () => {
    setDownloading(true);
    setError('');
    try {
      const response = await fetch(url, { headers: coreAuthHeader() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(new Blob([blob], { type: 'application/vnd.hancom.hwpx' }));
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = ensureHwpxFileName(fileName, '첨부파일');
      document.body.appendChild(link);
      link.click();
      link.remove();
      // 브라우저가 저장을 시작할 시간을 준 뒤 해제합니다. 바로 지우면 받다 말고 끊깁니다.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    } catch (downloadError) {
      setError(`다운로드 실패 (${downloadError.message})`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <span className="serverDocumentDownload">
      <button type="button" className={className || undefined} onClick={handleDownload} disabled={downloading}>
        {downloading ? '내려받는 중…' : '다운로드'}
      </button>
      {error ? <span className="formError">{error}</span> : null}
    </span>
  );
}

// 서버에 저장된 파일이 없는 로컬 전용 초안(ai-api-local/text-local/client-hwpx 등)의 본문(draftText)으로
// 그 자리에서 새 HWPX 파일을 만들어 내려받게 합니다. createClientHwpxDraft는 클릭 시점에 매번 새
// blob: URL을 만들기 때문에(미리 만들어 저장해두지 않음), 세션이 바뀌어도 죽은 링크가 되지 않습니다.
function ClientHwpxDownloadButton({ templateName, draftText }) {
  const handleClick = () => {
    const { fileName, url } = createClientHwpxDraft({ templateName, draftText });
    const link = window.document.createElement('a');
    link.href = url;
    link.download = fileName;
    // 다운로드는 클릭 이벤트 이후 브라우저가 비동기로 처리합니다. click() 직후 바로
    // revokeObjectURL을 부르면 일부 브라우저(특히 Firefox)에서는 브라우저가 blob을 읽기도
    // 전에 URL이 무효화되어 다운로드가 실패합니다. 링크를 문서에 잠깐 붙였다 떼고,
    // revoke는 다음 tick으로 미뤄 다운로드가 실제로 시작된 뒤에 처리되게 합니다.
    window.document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <span className="serverDocumentDownload">
      <button type="button" onClick={handleClick}>다운로드</button>
    </span>
  );
}

export function GeneratedFileLink({ path, label, consultationId, documentId, content, downloadFileName }) {
  if (!path && !content) return null;

  const downloadUrl = consultationId && documentId
    ? buildCoreDocumentDownloadUrl(consultationId, documentId)
    : '';
  const rawDisplayName = label || downloadFileName || generatedFileName(path) || '\uC0DD\uC131 \uD30C\uC77C';
  const safeDisplayName = rawDisplayName.includes('?') ? '\uC0DD\uC131 \uD30C\uC77C' : rawDisplayName;
  const downloadName = ensureHwpxFileName(downloadFileName || generatedFileName(path) || safeDisplayName);

  if (downloadUrl) {
    return (
      <div className="generatedFileInline">
        <span>{safeDisplayName}</span>
        <ServerDocumentDownloadButton url={downloadUrl} fileName={downloadName} />
      </div>
    );
  }

  if (content) {
    return (
      <div className="generatedFileInline">
        <span>{safeDisplayName}</span>
        <ClientHwpxDownloadButton templateName={downloadName} draftText={content} />
      </div>
    );
  }

  return (
    <div className="generatedFileInline">
      <span>{safeDisplayName}</span>
      <code>{path}</code>
    </div>
  );
}

export function DraftContentReviewLabel({ content }) {
  if (!content) return null;
  return <span className="generatedFileInline">{'\uBCF8\uBB38 \uCD08\uC548 \uAC80\uD1A0'}</span>;
}
// consultationId를 넘기고 document가 core-api에 실제 저장된 것(source: 'core-api')이면 실제
// 다운로드 API(.../documents/{id}/download, GeneratedDocumentController)로 진짜 파일을 받는
// 버튼을 보여줍니다. 이 경우는 항상 다운로드로 응답하도록 백엔드가 고정돼 있어
// (Content-Disposition: attachment) '미리보기'는 의미가 없으므로 다운로드 버튼만 둡니다.
//
// 경우가 있는데, blob: URL은 그 blob을 만든 "이 페이지 세션"에서만 유효하고 새로고침하거나 나중에
// 다시 열면(변호사 검토 요청 후 다른 시점에 다시 여는 경우 등) 이미 죽어 있어 다운로드가
// "사이트에서 사용할 수 없는 파일" 오류로 항상 실패합니다. 그래서 draftContent(초안 본문 텍스트,
// localStorage에 같이 저장돼 세션이 바뀌어도 남아있음)가 있으면 옛 blob을 재사용하지 않고 매번
// draftContent조차 없을 때만(구버전에 저장된 문서 등) 예전 filePath를 그대로 시도합니다.
export function GeneratedFileBox({ document, consultationId }) {
  const filePath = document?.draftFilePath || '';
  const downloadUrl = document?.source === 'core-api' && consultationId && document?.documentId
    ? buildCoreDocumentDownloadUrl(consultationId, document.documentId)
    : '';
  const fileName = ensureHwpxFileName(document?.downloadFileName || generatedFileName(filePath) || document?.formName || '서식초안');

  return (
    <div className="generatedFileBox">
      <div className="generatedFileHeader">
        <div className="generatedFileIdentity">
          <strong><FileText size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 생성 파일</strong>
          <span className={`statusChip ${downloadUrl ? 'tone-success' : document?.draftContent ? 'tone-warn' : 'tone-muted'}`}>
            {downloadUrl ? <CheckCircle2 size={13} strokeWidth={2.4} aria-hidden="true" /> : <XCircle size={13} strokeWidth={2.4} aria-hidden="true" />}
            {downloadUrl ? '서버 저장됨' : document?.draftContent ? '본문 기반 임시 파일' : '초안 없음'}
          </span>
        </div>
        {downloadUrl ? (
          <div className="generatedFileActions">
            <ServerDocumentDownloadButton
              className="primaryButton compactAction"
              url={downloadUrl}
              fileName={fileName || 'document.hwpx'}
            />
          </div>
        ) : null}
      </div>
      {downloadUrl ? (
        <>
          <span><Download size={13} strokeWidth={2.2} aria-hidden="true" /> {fileName}을 서버에서 다운로드할 수 있습니다.</span>
          {filePath ? <code className="generatedFilePath">{filePath}</code> : null}
        </>
      ) : (
        <>
          <span>서버 HWPX 초안 없음</span>
          <button type="button" disabled>서버 파일 없음</button>
        </>
      )}
    </div>
  );
}
