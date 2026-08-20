import React, { useState, useEffect } from 'react';
import { ShieldCheck, CheckCircle2, XCircle, FileText, FolderOpen, Info, UploadCloud, Paperclip, Trash2 } from 'lucide-react';
import { useToast, useConfirm } from '../../../components/feedback.jsx';
import { friendlyErrorMessage, InlineEmptyNotice } from '../../../components/common.jsx';
import { createAttachmentMetadata } from '../../../services/legalAidApi.js';
import { deleteCoreAttachment, deleteUnregisteredCoreAttachment, registerCoreAttachment, updateCoreConsultation } from '../../../services/coreApiClientV2.js';
import { hasRealClientName } from '../shared/nameCorrection.js';
import { transcribeAudio } from '../../../services/sttApiClient.js';
import { uploadFileToS3, S3UploadUnavailableError } from '../../../services/s3UploadClient.js';
import { readStorage, writeStorage, storageKeys } from '../../../services/storage.js';
import { caseCategories } from '../../../data/domain.js';
import { CasePicker } from '../components/CasePicker.jsx';
import { ChoicePicker } from '../components/ChoicePicker.jsx';
import { FileDropzone } from '../components/FileDropzone.jsx';
import { CounselorFlowStage } from '../components/CounselorFlowStage.jsx';
import { ConsultationCaseMeta } from '../components/ConsultationCaseMeta.jsx';
import {
  legalAidApplicantTypes,
  getEligibilityBadgeText,
  getEligibilityHelperText,
  buildAutoUploadTitle,
  buildEligibilityDraftFromCase,
  uploadCategoryOptions,
  uploadStatusTone,
} from '../shared/attachmentHelpers.js';

// 법률구조 대상 확인 + 파일 업로드는 '새 상담 만들기'와 '기존 상담에 자료 추가' 두 경로에서
// 완전히 같은 모양으로 쓰이므로, 한 군데(SRP)에 모아 두 곳에서 재사용합니다.
export function EligibilityAndFilesSection({ legalAidType, eligibilityEvidenceSubmitted, onChangeLegalAidType, onChangeEvidenceSubmitted, files, onAddFiles, onRemoveFile }) {
  const [dropzoneCategory, setDropzoneCategory] = useState(uploadCategoryOptions[2]);
  const selectedApplicantType = legalAidApplicantTypes.find((item) => item.key === legalAidType) || legalAidApplicantTypes[0];
  const isLegalAidApplicant = legalAidType !== 'none';
  const eligibilityBadgeText = getEligibilityBadgeText(isLegalAidApplicant, eligibilityEvidenceSubmitted);
  const eligibilityHelperText = getEligibilityHelperText(isLegalAidApplicant, eligibilityEvidenceSubmitted);
  return (
    <>
      <div className="eligibilityUploadRow">
      <section className="eligibilityPanel">
        <div className="eligibilityHeader">
          <div>
            <h3><ShieldCheck size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 무료 법률구조 대상 확인</h3>
            <p>대상 유형과 증빙자료 제출 여부</p>
          </div>
          <span className={`statusChip ${isLegalAidApplicant ? (eligibilityEvidenceSubmitted ? 'tone-success' : 'tone-warn') : 'tone-muted'}`}>
            {isLegalAidApplicant ? (eligibilityEvidenceSubmitted ? <CheckCircle2 size={13} strokeWidth={2.4} aria-hidden="true" /> : <XCircle size={13} strokeWidth={2.4} aria-hidden="true" />) : null}
            {eligibilityBadgeText}
          </span>
        </div>
        <div className="formGrid">
          <label className="field">
            <span>대상자 유형</span>
            <ChoicePicker
              options={legalAidApplicantTypes.map((item) => ({ value: item.key, label: item.label, description: item.evidence }))}
              value={legalAidType}
              onChange={onChangeLegalAidType}
              placeholder="대상자 유형 선택"
            />
          </label>
          <div className="evidenceBox">
            <span>필요 증빙서류</span>
            <strong>{selectedApplicantType.evidence}</strong>
            {isLegalAidApplicant ? (
              <label className="evidenceCheck">
                <input
                  className="evidenceCheckInput"
                  type="checkbox"
                  checked={eligibilityEvidenceSubmitted}
                  onChange={(event) => onChangeEvidenceSubmitted(event.target.checked)}
                />
                증빙서류 제출 확인
                <em className={eligibilityEvidenceSubmitted ? 'evidenceStatus submitted' : 'evidenceStatus missing'}>
                  {eligibilityEvidenceSubmitted ? '제출 확인' : '미제출'}
                </em>
              </label>
            ) : null}
          </div>
        </div>
        <p className={isLegalAidApplicant && !eligibilityEvidenceSubmitted ? 'eligibilityWarning' : 'helperText'}>
          {eligibilityHelperText}
        </p>
      </section>
      <section className="eligibilityPanel uploadFilesPanel">
        <div className="uploadDropzoneColumn">
          <h3><UploadCloud size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 상담 자료 추가</h3>
          <p className="helperText">녹취 · 이미지 · 문서를 함께 분석합니다. 저장하면 업로드됩니다.</p>
          <FileDropzone category={dropzoneCategory} onCategoryChange={setDropzoneCategory} onAddFiles={onAddFiles} />
        </div>
        <div className="uploadListColumn">
          <h3><Paperclip size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 업로드 목록</h3>
          <div className="scrollBox">
            {files.length ? files.map((file, index) => (
              <button type="button" className="uploadItem" key={file.id || file.fileKey || `${file.name}-${index}`} onClick={() => onRemoveFile(index)}>
                {/* 서버에 이미 저장된 첨부는 core-api가 파일 크기를 내려주지 않아 file.size가 없습니다.
                    0KB로 표시하면 빈 파일처럼 보이므로, 크기를 알 때만 괄호를 붙입니다. */}
                <span className="uploadItemName" title={file.name}><FileText size={13} strokeWidth={2.2} aria-hidden="true" /> [{file.category}] {file.name}{file.size ? ` (${Math.ceil(file.size / 1024)}KB)` : ''}</span>
                <span className={`uploadItemStatus statusChip ${uploadStatusTone(file.status)}`}>{file.status || '대기'}</span>
                <span className="uploadItemRemove"><Trash2 size={12} strokeWidth={2.4} aria-hidden="true" /> 삭제</span>
              </button>
            )) : <p>아직 추가한 파일이 없습니다.</p>}
          </div>
        </div>
      </section>
      </div>
    </>
  );
}
// 코치 피드백: 상담자 이름·상담 제목 입력은 없애고, 상담을 '선택'해서 통화가 끝난 뒤
// 후처리로 자료를 올려 변호사가 검토하도록 재구성합니다. 아직 상담이 하나도 없을 때만
// (드문 경우) 최소 정보로 새 상담을 만드는 경로를 남겨둡니다.
export function UploadWorkbench({ consultations = [], onCreateConsultation, onUpdateConsultation, onGoToRealtimeAnalysis }) {
  const showToast = useToast();
  const confirm = useConfirm();
  const hasExistingCase = consultations.length > 0;
  const [creatingNew, setCreatingNew] = useState(!hasExistingCase);
  const [selectedId, setSelectedId] = useState(hasExistingCase ? consultations[0].id : null);
  const selectedCase = !creatingNew ? consultations.find((item) => String(item.id) === String(selectedId)) : null;
  const canUploadAfterAnalysis = Boolean(selectedCase?.analysis || selectedCase?.analysisSaved || selectedCase?.analysisStatus === 'COMPLETED');
  const [message, setMessage] = useState('');
  // "AI 분석 이동"은 방금 "자료 저장"한 내용을 실시간 상담에서 바로 확인하러 가는 버튼이라,
  // 저장 전에는 갈 곳(반영된 자료)이 없어 막아둡니다. 사건을 바꾸면 그 사건은 아직 이번
  // 화면에서 저장한 적이 없으므로 다시 잠급니다.
  const [existingSaveCompleted, setExistingSaveCompleted] = useState(false);

  const emptyNewForm = { category: caseCategories[0].key, type: caseCategories[0].subTypes[0], memo: '', legalAidType: 'none', eligibilityEvidenceSubmitted: false };
  const savedDraft = readStorage(storageKeys.uploadDraft, null);
  const [newForm, setNewForm] = useState(savedDraft?.form || emptyNewForm);
  const [newFiles, setNewFiles] = useState(savedDraft?.files || []);
  const newActiveCategory = caseCategories.find((category) => category.key === newForm.category) || caseCategories[0];

  // 기존 상담을 고르면 그 상담에 이미 저장된 법률구조 대상 정보·첨부자료를 바로 이어서 편집합니다.
  const [existingFiles, setExistingFiles] = useState(selectedCase?.attachments || []);
  const [existingEligibility, setExistingEligibility] = useState(() => buildEligibilityDraftFromCase(selectedCase));
  useEffect(() => {
    if (creatingNew) return;
    setExistingFiles(selectedCase?.attachments || []);
    setExistingEligibility(buildEligibilityDraftFromCase(selectedCase));
    setExistingSaveCompleted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, creatingNew]);

  // 파일을 고르면 일단 목록에만 추가합니다(즉시 S3 업로드 X). 실제 S3 업로드는 사용자가
  // "임시저장" 또는 "상담 만들고 자료 저장"/"자료 저장" 버튼을 눌렀을 때 uploadPendingFiles가
  // 한 번에 수행합니다. → 파일만 골라보고 저장 없이 화면을 벗어나면 애초에 업로드 자체가
  // 일어나지 않아, 버려지는 파일이 S3 버킷에 쌓이지 않습니다.
  const addFilesTo = (setFilesState, label, selectedFiles) => {
    const staged = Array.from(selectedFiles).map((file) => createAttachmentMetadata(file, label));
    if (!staged.length) return;
    setFilesState((items) => [...items, ...staged]);
    setMessage(`${label} ${staged.length}개 추가 · 저장 시 업로드됩니다`);
  };
  // "삭제"는 그 파일이 실제로 어디까지 저장돼 있는지에 따라 다르게 처리합니다.
  //  - DB(Attachment)에 이미 등록됨(attachmentId 있음) → 백엔드가 DB row + S3 오브젝트를 함께 지웁니다.
  //  - 아직 등록 전이지만 S3에는 이미 올라가 있음(fileKey만 있음 — 예: "새 상담 만들기"에서 상담을
  //    만들기 전에 지우는 경우) → 등록되지 않은 S3 오브젝트 전용 삭제 경로로 지웁니다.
  //  - 둘 다 없으면(로컬에서 방금 고르기만 함) 지울 서버 실체가 없으므로 목록에서만 뺍니다.
  // 실패하면 목록에서 빼지 않습니다 — "지웠는데 서버·S3엔 그대로 남아있는" 불일치를 막기 위함입니다.
  // draftKey를 주면(=아직 상담이 없는 새 상담 만들기 초안) 로컬스토리지 draft도 같이 갱신해서,
  // "임시저장"을 다시 누르지 않아도 지운 파일이 새로고침 후 되살아나지 않게 합니다.
  const removeFileAt = async (setFilesState, files, index, coreId, draftKey) => {
    const target = files[index];
    if (!target) return undefined;
    try {
      if (target.attachmentId && coreId) {
        await deleteCoreAttachment(coreId, target.attachmentId);
      } else if (target.fileKey) {
        await deleteUnregisteredCoreAttachment(target.fileKey);
      }
    } catch (error) {
      showToast(`삭제 실패: ${friendlyErrorMessage(error, '잠시 후 다시 시도해 주세요.')}`, 'warn');
      return undefined;
    }
    const nextFiles = files.filter((_, itemIndex) => itemIndex !== index);
    setFilesState(nextFiles);
    if (draftKey) {
      const savedDraft = readStorage(draftKey, null);
      if (savedDraft) writeStorage(draftKey, { ...savedDraft, files: nextFiles });
    }
    return nextFiles;
  };

  // 업로드는 됐지만(fileKey 있음) 아직 이 상담의 DB에 등록되지 않은 파일(attachmentId 없음)을
  // 등록합니다. coreId가 없으면(=아직 core-api에 없는 상담, 예: 새 상담 만들기 흐름) 등록할 곳이
  // 없어 건너뜁니다 — 그 흐름은 상담 생성 자체가 attachments를 함께 등록하므로 이 호출이 필요 없습니다.
  const registerNewAttachments = async (files, coreId) => {
    if (!coreId) return files;
    const unregistered = files.filter((item) => item.fileKey && !item.attachmentId);
    if (!unregistered.length) return files;
    let result = files;
    for (const item of unregistered) {
      try {
        const saved = await registerCoreAttachment(coreId, item);
        result = result.map((file) => file.id === item.id ? { ...file, attachmentId: saved.id, status: '서버 저장' } : file);
      } catch (error) {
        showToast(`${item.name} 등록 실패: ${friendlyErrorMessage(error, '잠시 후 다시 시도해 주세요.')}`, 'warn');
      }
    }
    return result;
  };

  // 저장 동작(임시저장·자료 저장)에서 호출해, 그때까지 S3에 올라가지 않은 파일(fileKey 없음 —
  // 신규 선택분뿐 아니라 이전 시도에서 실패했거나 백엔드 미지원으로 로컬 보관 중이던 파일도 포함)을
  // 한 번에 업로드합니다. 최신 상태가 반영된 파일 목록을 돌려주므로 호출부는 이 값을 그대로
  // draft 저장/첨부 payload 생성에 씁니다.
  const uploadPendingFiles = async (files, setFilesState) => {
    const pending = files.filter((item) => item.file && !item.fileKey);
    if (!pending.length) return files;
    const pendingIds = new Set(pending.map((item) => item.id));
    setFilesState((items) => items.map((item) => pendingIds.has(item.id) ? { ...item, status: '업로드 중' } : item));
    setMessage(`파일 ${pending.length}개 업로드 중…`);

    let result = files;
    let fellBackToLocal = false;
    let failedCount = 0;
    let sttFailedCount = 0;
    for (const meta of pending) {
      let sttResult = null;
      const isAudio = /\.(mp3|wav|m4a|webm)$/i.test(meta.name || '') || /audio\//i.test(meta.mimeType || '');
      if (isAudio) {
        try {
          setMessage(`${meta.name} 음성을 텍스트로 변환 중…`);
          sttResult = await transcribeAudio(meta.file);
        } catch (error) {
          sttFailedCount += 1;
          showToast(`${meta.name} 음성 텍스트 변환 실패: ${friendlyErrorMessage(error, '잠시 후 다시 시도해 주세요.')}`, 'warn');
        }
      }
      try {
        const { fileKey, fileUrl } = await uploadFileToS3(meta.file, meta.category);
        result = result.map((item) => item.id === meta.id ? {
          ...item,
          fileKey,
          uploadedUrl: fileUrl,
          ...(sttResult ? {
            extractedText: sttResult.originalText,
            sttOriginalText: sttResult.originalText,
            sttMaskedText: sttResult.anonymizedText,
            sttAnonymizationMap: sttResult.anonymizationMap,
          } : {}),
          status: sttResult ? '업로드·텍스트 변환 완료' : '업로드 완료',
        } : item);
      } catch (error) {
        if (error instanceof S3UploadUnavailableError) {
          fellBackToLocal = true;
          result = result.map((item) => item.id === meta.id ? { ...item, status: '로컬 보관 (업로드 대기)' } : item);
        } else {
          failedCount += 1;
          result = result.map((item) => item.id === meta.id ? { ...item, status: '업로드 실패' } : item);
          showToast(`${meta.name} 업로드 실패: ${friendlyErrorMessage(error, '잠시 후 다시 시도해 주세요.')}`, 'warn');
        }
      }
      setFilesState(result);
    }
    setMessage(fellBackToLocal
      ? `파일 업로드 완료. 일부는 업로드 대기${sttFailedCount ? ` · STT ${sttFailedCount}건 실패` : ''}` //업로드 대기=로컬 임시 보관
      : failedCount
        ? `파일 업로드 완료. ${failedCount}건 실패${sttFailedCount ? ` · STT ${sttFailedCount}건 실패` : ''}`
        : `파일 업로드 완료${sttFailedCount ? ` · STT ${sttFailedCount}건 실패` : ''}.`);
    return result;
  };

  const saveDraft = async () => {
    const uploadedFiles = await uploadPendingFiles(newFiles, setNewFiles);
    writeStorage(storageKeys.uploadDraft, { form: newForm, files: uploadedFiles, savedAt: new Date().toISOString() });
    setMessage('임시저장 완료');
  };
  // "비우기"도 "삭제"와 같은 이유로 정리가 필요합니다 — 임시저장 단계에서 이미 S3에 올라간 파일
  // (fileKey는 있지만 아직 어떤 상담에도 등록되지 않아 attachmentId가 없는 파일)을 먼저 지우지 않으면,
  // 로컬 목록·draft만 비워질 뿐 S3에는 그 파일이 그대로 남습니다.
  const clearDraft = async () => {
    const orphaned = newFiles.filter((item) => item.fileKey && !item.attachmentId);
    let failedCount = 0;
    for (const item of orphaned) {
      try {
        await deleteUnregisteredCoreAttachment(item.fileKey);
      } catch {
        failedCount += 1;
      }
    }
    writeStorage(storageKeys.uploadDraft, null);
    setNewForm(emptyNewForm);
    setNewFiles([]);
    if (failedCount) {
      showToast(`S3에 남은 파일 ${failedCount}건을 정리하지 못했습니다.`, 'warn');
      setMessage(`임시저장 비움 · S3 파일 ${failedCount}건 정리 실패`);
    } else {
      setMessage('임시저장 비움');
    }
  };

  const buildAttachmentPayload = (files) => files.map(({ attachmentId, category, name, size, mimeType, storageBucket, fileKey, uploadedUrl, extractedText, sttOriginalText, sttMaskedText, sttAnonymizationMap }) => (
    { attachmentId, category, name, size, mimeType, storageBucket, fileKey, uploadedUrl, extractedText, sttOriginalText, sttMaskedText, sttAnonymizationMap }
  ));
  const buildEligibilityPayload = ({ legalAidType, eligibilityEvidenceSubmitted }) => {
    const selectedApplicantType = legalAidApplicantTypes.find((item) => item.key === legalAidType) || legalAidApplicantTypes[0];
    const isLegalAidApplicant = legalAidType !== 'none';
    return {
      applicantType: selectedApplicantType.label,
      requiredEvidence: selectedApplicantType.evidence,
      isTargetCandidate: isLegalAidApplicant,
      evidenceSubmitted: isLegalAidApplicant ? eligibilityEvidenceSubmitted : false,
    };
  };

  const submitNewCase = async () => {
    const accepted = await confirm({
      title: '자료를 저장할 상담을 만들까요?',
      message: '최소 정보로 상담을 만듭니다.\n이름·제목은 실시간 상담에서 채워주세요.',
      confirmLabel: '만들기',
      cancelLabel: '다시 확인',
      tone: 'info',
    });
    if (!accepted) return;
    const uploadedFiles = await uploadPendingFiles(newFiles, setNewFiles);
    const result = await onCreateConsultation({
      name: '',
      title: buildAutoUploadTitle(),
      category: newForm.category,
      type: newForm.type,
      memo: newForm.memo,
      status: '진행 중',
      eligibilityCheck: buildEligibilityPayload(newForm),
      attachments: buildAttachmentPayload(uploadedFiles),
    }, { skipNavigation: true });
    if (result?.id == null) {
      showToast('상담을 만들지 못했습니다. 다시 시도해주세요.', 'warn');
      return;
    }
    writeStorage(storageKeys.uploadDraft, null);
    setNewForm(emptyNewForm);
    setNewFiles([]);
    setMessage('');
    setCreatingNew(false);
    setSelectedId(result.id);
    showToast(result?.message || '자료 저장 완료 · 실시간 상담에서 이어서 진행', result?.coreSynced === false ? 'warn' : 'success');
  };

  const submitExistingCase = async () => {
    if (!selectedCase) return;
    if (!canUploadAfterAnalysis) {
      setMessage('실시간 상담을 끝내고 분석을 완료한 상담만 자료를 올릴 수 있습니다.');
      return;
    }
    const accepted = await confirm({
      title: '자료를 저장할까요?',
      message: `${selectedCase.caseNo} 「${selectedCase.title}」\n첨부자료와 구조대상 확인 내용을 저장합니다.`,
      confirmLabel: '저장',
      cancelLabel: '다시 확인',
      tone: 'info',
    });
    if (!accepted) return;
    const uploadedFiles = await uploadPendingFiles(existingFiles, setExistingFiles);
    // S3까지는 올라갔어도 아직 이 상담의 Attachment DB row가 없는 파일(방금 새로 고른 파일)을
    // 여기서 등록합니다 — 이걸 하지 않으면 화면에는 보이지만 DB에는 없는 파일이 생깁니다.
    const registeredFiles = await registerNewAttachments(uploadedFiles, selectedCase.coreId);
    setExistingFiles(registeredFiles);
    onUpdateConsultation(selectedCase.id, {
      eligibilityCheck: buildEligibilityPayload(existingEligibility),
      attachments: buildAttachmentPayload(registeredFiles),
    });
    // 이 화면 위쪽 이름칸(ConsultationCaseMeta)에서 고친 이름도 함께 서버에 남깁니다.
    // 여태 이름은 화면 상태만 바뀌고 서버로는 안 갔습니다 — 실시간 상담의 '상담 저장'
    // 버튼에만 저장 경로가 있어서, 자료 올리기에서만 작업한 상담은 이름이 이 브라우저
    // 밖으로 나가지 못했습니다. 다른 계정·다른 PC로 열면 다시 빈 이름이 됩니다.
    //
    // 서식 초안의 청구인이 되는 값이라 조용히 넘기지 않고 실패를 알립니다.
    if (selectedCase.coreId && hasRealClientName(selectedCase.name)) {
      try {
        await updateCoreConsultation(selectedCase.coreId, { clientName: selectedCase.name.trim() });
      } catch (error) {
        showToast(friendlyErrorMessage(error, '이름을 서버에 저장하지 못했습니다. 다시 저장해주세요.'), 'warn');
        return;
      }
    }
    setMessage('');
    setExistingSaveCompleted(true);
    showToast('자료 저장 완료 · 검토 요청 시 함께 전달', 'success');
  };

  return (
    <main className="workspacePage">
      <div className="workflowIntro uploadWorkflowIntro">
        <h1><FileText size={22} strokeWidth={2.2} className="workflowIntroIcon" aria-hidden="true" /> 상담 자료 올리기</h1>
        <p>상담을 선택하고 자료를 추가한 뒤 변호사 검토로 전달하세요.</p>
        <CounselorFlowStage current="upload" onNavigate={onGoToRealtimeAnalysis ? () => onGoToRealtimeAnalysis() : undefined} />
      </div>
      <section className="workflowPanel uploadPanel">
        <section className="uploadWorkCard" aria-label="상담 자료 올리기 작업 영역">
        {hasExistingCase ? (
          <div className="categoryTabs uploadModeSwitch" role="tablist" aria-label="자료 업로드 방식">
            <button type="button" role="tab" aria-selected={!creatingNew} className={!creatingNew ? 'categoryTab active' : 'categoryTab'} onClick={() => { setCreatingNew(false); setMessage(''); }}>
              기존 상담에 자료 추가
            </button>
            <button type="button" role="tab" aria-selected={creatingNew} className={creatingNew ? 'categoryTab active' : 'categoryTab'} onClick={() => { setCreatingNew(true); setMessage(''); }}>
              새 상담 만들기
            </button>
          </div>
        ) : null}
        {!creatingNew && hasExistingCase ? (
          <label className="field uploadCaseSelector">
            <span><span className="fieldLabelWithIcon"><FolderOpen size={14} strokeWidth={2.4} aria-hidden="true" /> 상담 선택</span></span>
            <CasePicker consultations={consultations} value={selectedId} onChange={(id) => { setSelectedId(id); setMessage(''); }} />
          </label>
        ) : null}

        {creatingNew ? (
          <>
            <div className="newUploadGuide">
              <strong><Info size={14} strokeWidth={2.4} aria-hidden="true" /> 통화 전 자료를 먼저 등록합니다.</strong>
              <span>(이름과 제목은 실시간 상담에서 입력합니다.)</span>
            </div>
            <div className="formGrid">
              <label className="field">
                <span>사건 대분류</span>
                <ChoicePicker
                  value={newForm.category}
                  options={caseCategories.map((category) => ({ value: category.key, label: category.key }))}
                  onChange={(nextValue) => {
                    const nextCategory = caseCategories.find((category) => category.key === nextValue) || caseCategories[0];
                    setNewForm({ ...newForm, category: nextCategory.key, type: nextCategory.subTypes[0] });
                  }}
                  placeholder="사건 대분류 선택"
                />
              </label>
              <label className="field">
                <span>사건 소분류</span>
                <ChoicePicker
                  value={newForm.type}
                  options={newActiveCategory.subTypes.map((type) => ({ value: type, label: type }))}
                  onChange={(nextValue) => setNewForm({ ...newForm, type: nextValue })}
                  placeholder="사건 소분류 선택"
                />
              </label>
            </div>
            <label className="field">
              <span>상담 내용 입력 <em className="charCount">{newForm.memo.length}자</em></span>
              <textarea
                className="tallTextarea"
                value={newForm.memo}
                onChange={(e) => setNewForm({ ...newForm, memo: e.target.value })}
                placeholder="상담 내용을 입력하세요."
              />
            </label>
            <EligibilityAndFilesSection
              legalAidType={newForm.legalAidType}
              eligibilityEvidenceSubmitted={newForm.eligibilityEvidenceSubmitted}
              onChangeLegalAidType={(value) => setNewForm({ ...newForm, legalAidType: value, eligibilityEvidenceSubmitted: false })}
              onChangeEvidenceSubmitted={(checked) => setNewForm({ ...newForm, eligibilityEvidenceSubmitted: checked })}
              files={newFiles}
              onAddFiles={(label, files) => addFilesTo(setNewFiles, label, files)}
              onRemoveFile={(index) => removeFileAt(setNewFiles, newFiles, index, null, storageKeys.uploadDraft)}
            />
            <div className="uploadActionRow">
              <div className="uploadSecondaryActions">
                <button type="button" onClick={saveDraft}>임시저장</button>
                <button type="button" onClick={clearDraft}>임시저장 비우기</button>
              </div>
              <button className="primaryButton uploadSubmitButton" type="button" onClick={submitNewCase}>상담 만들고 자료 저장</button>
            </div>
          </>
        ) : selectedCase ? (
          <>
            <ConsultationCaseMeta selectedCase={selectedCase} onUpdateConsultation={onUpdateConsultation} />
            <div className="uploadCaseSummary uploadCaseSummaryStatusOnly">
              <div className={`uploadCaseSummaryStatus ${canUploadAfterAnalysis ? 'is-ready' : 'is-waiting'}`}>
                {canUploadAfterAnalysis ? <CheckCircle2 size={16} strokeWidth={2.4} aria-hidden="true" /> : <XCircle size={16} strokeWidth={2.4} aria-hidden="true" />}
                <span>
                  <strong>{canUploadAfterAnalysis ? '자료를 추가할 수 있어요' : '분석을 먼저 완료해주세요'}</strong>
                  <small>{canUploadAfterAnalysis ? '필요한 녹취·이미지·문서를 등록하세요.' : '실시간 상담에서 분석을 완료하면 자료를 저장할 수 있어요.'}</small>
                </span>
              </div>
            </div>
            <EligibilityAndFilesSection
              legalAidType={existingEligibility.legalAidType}
              eligibilityEvidenceSubmitted={existingEligibility.eligibilityEvidenceSubmitted}
              onChangeLegalAidType={(value) => setExistingEligibility({ legalAidType: value, eligibilityEvidenceSubmitted: false })}
              onChangeEvidenceSubmitted={(checked) => setExistingEligibility((current) => ({ ...current, eligibilityEvidenceSubmitted: checked }))}
              files={existingFiles}
              onAddFiles={(label, files) => addFilesTo(setExistingFiles, label, files)}
              onRemoveFile={async (index) => {
                const nextFiles = await removeFileAt(setExistingFiles, existingFiles, index, selectedCase?.coreId, null);
                if (nextFiles) onUpdateConsultation(selectedCase.id, { attachments: buildAttachmentPayload(nextFiles) });
              }}
            />
            <div className="uploadActionRow">
              <span className="uploadSaveHint">{canUploadAfterAnalysis ? '파일을 추가한 뒤 저장하면 변호사 검토에 함께 전달됩니다.' : '분석 완료 전에는 자료를 저장할 수 없습니다.'}</span>
              <div className="uploadActionButtons">
                <button className="secondaryActionButton" type="button" onClick={() => onGoToRealtimeAnalysis?.(selectedCase?.id)} disabled={!existingSaveCompleted}>AI 분석 이동</button>
                <button className="primaryButton uploadSubmitButton" type="button" onClick={submitExistingCase} disabled={!canUploadAfterAnalysis}>자료 저장</button>
              </div>
            </div>
          </>
        ) : (
          <InlineEmptyNotice>등록된 상담이 없습니다. 새 상담을 만들어 주세요.</InlineEmptyNotice>
        )}
        {message ? <p className="helperText">{message}</p> : null}
        </section>
      </section>
    </main>
  );
}
