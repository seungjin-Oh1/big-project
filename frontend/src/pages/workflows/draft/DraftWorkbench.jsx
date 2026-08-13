import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ClipboardList, FileText, ListChecks, Sparkles, CheckCircle2, Star, Send, Plus, Download } from 'lucide-react';
import { useToast } from '../../../components/feedback.jsx';
import { useAsyncAction } from '../../../components/loading.jsx';
import { friendlyErrorMessage, InlineEmptyNotice, WorkPageHeader } from '../../../components/common.jsx';
import { getFavoriteTemplates, toggleFavoriteTemplate, readStorage, writeStorage, storageKeys } from '../../../services/storage.js';
import { caseCategories, legalTemplateSeed } from '../../../data/domain.js';
import { recommendTemplates, generateDraftText } from '../../../services/legalAidApi.js';
import {
  createCoreConsultation,
  createCoreAnalysis,
  fetchCoreDocuments,
  approveCoreDocument,
  submitCoreDocumentForReview,
  generateCoreDraft,
  updateCoreConsultation,
} from '../../../services/coreApiClientV2.js';
import { hydrateDraftDocument, rememberDraftDocumentSnapshot } from '../../../services/draftDocumentStore.js';
import { readLawyerDraftEdit, saveLawyerDraftEdit } from '../../../services/documentReviewStore.js';
import { resolveHwpxTemplateName, isHwpxTemplateAlias } from '../../../services/formTemplateResolver.js';
import { caseOptions, resolveConfirmedCaseType } from '../shared/caseHelpers.js';
import { buildAnalysisResult } from '../shared/analysisHelpers.js';
import { normalizeGeneratedDocument, draftGenerationErrorMessage, documentStatusTone, DOCUMENT_STATUS_LABEL } from '../shared/documentHelpers.js';
import { GeneratedFileBox, GeneratedFileLink } from '../documents/GeneratedFileBox.jsx';
import { CasePicker } from '../components/CasePicker.jsx';
import { ChoicePicker } from '../components/ChoicePicker.jsx';
import { useFormRecommendations } from '../analysis/RecommendedFormsPanel.jsx';
import { DraftContactConsent } from './DraftContactConsent.jsx';

export function DraftWorkbench({ consultations, currentUser, role, onUpdateConsultation, onNotify, focusedConsultationId, focusedTemplateName }) {
  const showToast = useToast();
  const [step, setStep] = useState('select');
  // 분석 화면에서 '초안 만들기'로 넘어오면 focusedConsultationId가 그 사건을 가리킵니다.
  // 처음에 목록 첫 사건으로 시작한 뒤 아래 useEffect가 교정하는 방식이었는데, 그러면
  // 첫 렌더에서 엉뚱한 사건으로 추천 API를 한 번 부르고 나서 다시 부릅니다.
  // 넘어올 때마다 추천이 다시 도는 것처럼 보이던 게 이것 때문입니다.
  const [caseId, setCaseId] = useState(() => focusedConsultationId || caseOptions(consultations)[0].id);
  const [template, setTemplate] = useState(null);
  const [draft, setDraft] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [generatedFileMessage, setGeneratedFileMessage] = useState('');
  const [favorites, setFavorites] = useState(() => getFavoriteTemplates());
  const selectedCase = consultations.find((item) => String(item.id) === String(caseId));
  const runWithLoading = useAsyncAction();
  const canUseCoreApi = Boolean(selectedCase?.coreId && selectedCase?.coreAnalysisId);

  useEffect(() => {
    if (!focusedConsultationId) return;
    const focusedCase = consultations.find((item) => String(item.id) === String(focusedConsultationId));
    if (focusedCase) {
      setCaseId(focusedCase.id);
      setStep('select');
    }
  }, [focusedConsultationId, consultations]);

  // '추천 서식' 목록에서 특정 서식의 '저장하고 초안 만들기'를 눌러 들어오면, 어떤 서식을
  // 눌렀는지와 상관없이 항상 같은(초기) 서식으로 열려 있었습니다(코치 피드백: 3개 추천
  // 버튼이 다 똑같이 동작). 눌렀던 서식을 그대로 선택된 채로 열어 줍니다.
  const appliedFocusTemplateRef = useRef(null);
  useEffect(() => {
    if (!focusedTemplateName || appliedFocusTemplateRef.current === focusedTemplateName) return;
    appliedFocusTemplateRef.current = focusedTemplateName;
    setTemplate(focusedTemplateName);
  }, [focusedTemplateName]);

  // 아직 core-api에 상담/분석이 저장되지 않은 사건(로컬 프로토타입 진행 중)이면, 초안을 실제로
  // 생성하기 직전에 한 번 밀어 넣습니다. 이미 저장돼 있으면(canUseCoreApi) 그대로 씁니다.
  const syncCaseForDraftGeneration = async () => {
    if (!selectedCase) return null;
    const analysis = selectedCase.analysis || buildAnalysisResult(selectedCase);
    let coreId = selectedCase.coreId || '';
    let coreAnalysisId = selectedCase.coreAnalysisId || '';
    let coreSync = null;

    if (!coreId) {
      coreSync = await createCoreConsultation({ currentUser: { ...currentUser, role: currentUser?.role || role }, consultation: selectedCase });
      coreId = coreSync?.coreId || '';
    }

    if (!coreAnalysisId && coreId) {
      const savedAnalysis = await createCoreAnalysis({ consultation: { ...selectedCase, ...(coreSync || {}), coreId }, analysis });
      coreAnalysisId = savedAnalysis?.analysis_id || '';
    }

    if (coreId || coreAnalysisId) {
      onUpdateConsultation?.(selectedCase.id, {
        ...(coreSync || {}),
        coreId,
        coreAnalysisId,
        analysis,
      });
    }

    return coreId && coreAnalysisId ? { coreId, coreAnalysisId, analysis } : null;
  };

  // ── 서식 추천 실연동: coreId·분석id가 있는 사건은 core-api → ai-api 추천 결과를 받아옵니다.
  // 없으면(로컬 상담이거나 core-api 저장 실패) 기존 로컬 휴리스틱(recommendTemplates)으로 조용히 대체합니다.
  // 분석 화면과 같은 훅을 씁니다. 저장된 recommendation_json이 있으면 그걸 쓰고,
  // 없으면 이번 세션 캐시를, 그것도 없으면 API를 부릅니다.
  const { aiRecommendations, loading: recommendLoading } = useFormRecommendations(selectedCase);

  // ── 서식에 넣을 주소·전화번호와 그 동의.
  //
  // 화면 상태를 먼저 바꾸고 서버로 보냅니다. 타이핑할 때마다 서버를 부르면 글자마다
  // 요청이 나가므로, 저장은 입력이 멎은 뒤에 한 번만 합니다.
  //
  // 서버에 못 보내면 화면에만 남습니다 — 그대로 두면 상담원은 저장된 줄 알고 초안을
  // 만드는데 주소칸이 비어서 나옵니다. 그래서 실패를 토스트로 알립니다.
  const contactSaveTimer = useRef(null);
  const [contactSaveError, setContactSaveError] = useState('');
  const updateDraftContact = (changes) => {
    if (!selectedCase) return;
    onUpdateConsultation?.(selectedCase.id, changes);
    if (!selectedCase.coreId) return;

    const next = { ...selectedCase, ...changes };
    clearTimeout(contactSaveTimer.current);
    contactSaveTimer.current = setTimeout(() => {
      // 셋을 항상 함께 보냅니다. 서버는 privacyConsent가 올 때만 동의 상태를 바꾸는데,
      // 안 보내면 "동의를 뺐다"와 "이 항목을 안 보냈다"를 구분할 수 없습니다.
      updateCoreConsultation(selectedCase.coreId, {
        privacyConsent: Boolean(next.privacyConsent),
        privacyConsentSource: next.privacyConsentSource || '',
        clientAddress: next.clientAddress || '',
        clientPhone: next.clientPhone || '',
      })
        .then(() => setContactSaveError(''))
        .catch((error) => {
          const message = friendlyErrorMessage(error, '주소·전화번호를 서버에 저장하지 못했습니다.');
          setContactSaveError(message);
          showToast(message, 'warn');
        });
    }, 700);
  };
  useEffect(() => () => clearTimeout(contactSaveTimer.current), []);

  // ── 생성된 초안의 core-api 문서 상태(초안 생성 → 검토 요청 → 승인/반려)입니다.
  // 사건이나 서식을 바꾸면 이전 초안의 id가 지금 화면과 안 맞으니 초기화합니다.
  const [draftDocument, setDraftDocument] = useState(null);
  const [submitReviewPending, setSubmitReviewPending] = useState(false);
  useEffect(() => {
    setDraftDocument(null);
  }, [caseId, template]);

  // 사건에 제출된 서식 초안 목록입니다. 변호사는 이 목록으로 내부 검토를 하고, 상담원은
  // 같은 목록을 읽기 전용으로 보며 검토 상태·변호사 코멘트·수정본 여부를 확인합니다.
  const isLawyerReviewer = role === 'lawyer';
  const [caseDocuments, setCaseDocuments] = useState([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const reloadCaseDocuments = () => {
    if (!selectedCase?.coreId) {
      setCaseDocuments([]);
      return;
    }
    setDocumentsLoading(true);
    fetchCoreDocuments(selectedCase.coreId)
      .then((list) => setCaseDocuments((list || []).map((document) => hydrateDraftDocument(document, {
        consultationId: selectedCase.coreId,
        caseNo: selectedCase.caseNo,
      }))))
      .catch(() => setCaseDocuments([]))
      .finally(() => setDocumentsLoading(false));
  };
  useEffect(() => {
    reloadCaseDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCase?.coreId]);

  // 변호사 내부 검토 인라인 폼 상태. 한 번에 하나의 문서만 검토 폼을 열어둡니다.
  const [reviewingDocumentId, setReviewingDocumentId] = useState(null);
  const [reviewNoteText, setReviewNoteText] = useState('');
  const [reviewPending, setReviewPending] = useState(false);
  // 서식 초안 직접 편집. core-api 문서는 서버 원본을 다시 만들 API가 없어, 편집 결과는
  // 이 브라우저에 '변호사 수정본'으로 남겨 상담원 화면에도 함께 보여줍니다.
  const [reviewContentDraft, setReviewContentDraft] = useState('');
  const startDocumentReview = (doc) => {
    setReviewingDocumentId(doc.document_id);
    setReviewNoteText('');
    setReviewContentDraft(readLawyerDraftEdit(doc.document_id)?.content || doc.draft_content || '');
  };
  const cancelDocumentReview = () => {
    setReviewingDocumentId(null);
  };
  const confirmDocumentReview = async (doc) => {
    if (!selectedCase?.coreId || !reviewingDocumentId) return;
    setReviewPending(true);
    try {
      // 승인 요청이 실패해도(예: 권한 없음) 변호사가 고친 내용은 이 브라우저에 먼저 남겨
      // 작업이 사라지지 않게 합니다.
      if (reviewContentDraft.trim() !== (doc.draft_content || '').trim()) {
        saveLawyerDraftEdit(reviewingDocumentId, reviewContentDraft);
      }
      const token = currentUser?.token;
      await approveCoreDocument(selectedCase.coreId, reviewingDocumentId, reviewNoteText, token);
      showToast('서식 초안 내부 검토를 완료했습니다.', 'success');
      setReviewingDocumentId(null);
      reloadCaseDocuments();
    } catch (error) {
      showToast(`처리에 실패했습니다: ${friendlyErrorMessage(error, '잠시 후 다시 시도해 주세요.')}`, 'warn');
    } finally {
      setReviewPending(false);
    }
  };

  // 이 사건의 확정 사건 분류입니다. 서식 추천과 초안 본문이 같은 값을 쓰도록 한 곳에서만 정합니다.
  // (소분류 우선 → 대분류 → 등록 때 고른 유형 순서는 resolveConfirmedCaseType 참고)
  const draftCaseType = resolveConfirmedCaseType(selectedCase);

  // 서식이 291개로 많아졌기 때문에, 대분류 탭 → 소분류 드롭다운 → 서식명 검색 3단계로 좁혀서 보여줍니다.
  const [majorFilter, setMajorFilter] = useState('전체');
  const [minorFilter, setMinorFilter] = useState('전체');
  const [searchText, setSearchText] = useState('');
  // 선택한 사건의 확정 분류에 맞는 서식만 볼지 여부. 291개를 매번 손으로 좁히지 않아도 되게 합니다.
  // 코치 피드백(직접 화면 확인): 이 토글이 기본 꺼짐이라, 정작 처음 들어오면 291개를 필터 없이
  // 그대로 보여줬습니다. 사건 분류를 이미 아는 경우 기본으로 켜서, 화면을 열자마자 좁혀진
  // 목록부터 보이게 합니다(분류를 모르는 사건이면 scopeToCase가 자동으로 꺼진 것과 같게 동작).
  const [onlyForCase, setOnlyForCase] = useState(true);
  const activeMajor = caseCategories.find((category) => category.key === majorFilter);
  const minorOptions = ['전체', ...(activeMajor ? activeMajor.subTypes : [])];

  // 켜둔 채로 분류가 없는 사건으로 넘어가면 목록이 빈 채로 잠기므로, 실제 적용 여부는 분류 유무까지 함께 봅니다.
  const scopeToCase = onlyForCase && Boolean(draftCaseType);
  // 추천 목록을 켜면 그 결과를, 끄면 전체 서식을 바탕으로 아래 3단계 필터를 겁니다.
  const baseTemplates = scopeToCase ? recommendTemplates(draftCaseType) : legalTemplateSeed;

  // 서식이 최대 291개라 이 filter+sort를 매 렌더마다 다시 돌리면(메모 입력 같은 무관한 상태
  // 변경에도 재실행됩니다) 느린 기기에서 눈에 띄게 밀립니다. 실제로 결과가 바뀌는 값(대상
  // 서식 목록·필터·검색어·즐겨찾기·AI 추천)이 그대로면 이전 계산을 그대로 재사용합니다.
  const filteredTemplates = useMemo(() => baseTemplates.filter((item) => {
    const matchesMajor = majorFilter === '전체' || item.caseCategory === majorFilter;
    const matchesMinor = minorFilter === '전체' || item.caseType === minorFilter;
    const matchesSearch = !searchText.trim() || item.templateName.includes(searchText.trim());
    return matchesMajor && matchesMinor && matchesSearch;
  }), [baseTemplates, majorFilter, minorFilter, searchText]);
  // AI 추천(recommend-forms) 결과가 있으면 즐겨찾기보다도 먼저 보여줍니다 — 지금 이 사건에
  // 대해 실제로 추천된 서식이라 가장 눈에 잘 띄어야 합니다. rank가 있으면 그 순서를 따릅니다.
  const templates = useMemo(() => {
    const aiRecommendationRank = new Map(aiRecommendations.map((item, index) => [item.form_name, item.rank ?? index]));
    return [...filteredTemplates].sort((a, b) => {
      const aRank = aiRecommendationRank.has(a.templateName) ? aiRecommendationRank.get(a.templateName) : Infinity;
      const bRank = aiRecommendationRank.has(b.templateName) ? aiRecommendationRank.get(b.templateName) : Infinity;
      if (aRank !== bRank) return aRank - bRank;
      const aFav = favorites.includes(a.templateName) ? 0 : 1;
      const bFav = favorites.includes(b.templateName) ? 0 : 1;
      return aFav - bFav;
    });
  }, [filteredTemplates, aiRecommendations, favorites]);
  const selectedTemplate = templates.find((item) => item.templateName === template) || templates[0];

  // 상담/분석에서 추출된 값을 서식 필드에 자동 매핑하고, 값이 없는 항목은 '누락'으로 표시합니다.
  const extractedFieldMap = {
    '당사자 정보': selectedCase?.name ? `상담자: ${selectedCase.name}` : '',
    '청구 취지': draftCaseType ? `${draftCaseType} 관련 청구` : '',
    '관련 사실관계': selectedCase?.memo || selectedCase?.analysis?.summary || '',
    '첨부 증빙자료': selectedCase?.attachments?.length ? `${selectedCase.attachments.length}건 첨부` : '',
  };
  const draftFields = (selectedTemplate?.requiredFields || []).map((field) => ({
    field,
    value: extractedFieldMap[field] || '',
    filled: Boolean(extractedFieldMap[field]),
  }));

  const buildDraftContent = () => (
    draft || generateDraftText({
      templateName: selectedTemplate?.templateName,
      consultation: selectedCase,
      analysis: selectedCase?.analysis,
      caseType: draftCaseType,
    })
  );

  const syncDraftSnapshot = (document, draftContent) => {
    if (!document || !draftContent) return;
    rememberDraftDocumentSnapshot({
      consultation: selectedCase,
      document,
      draftContent,
    });
  };

  const handleToggleFavorite = (templateName, event) => {
    event.stopPropagation();
    setFavorites(toggleFavoriteTemplate(templateName));
  };

  // 실제 HWPX 초안은 core-api가 생성한 GeneratedDocument만 사용합니다.
  const generateDraftDocument = async (draftContent) => {
    const hwpxTemplateName = resolveHwpxTemplateName(selectedTemplate.templateName);
    const coreContext = canUseCoreApi
      ? { coreId: selectedCase.coreId, coreAnalysisId: selectedCase.coreAnalysisId }
      : await syncCaseForDraftGeneration();

    if (!coreContext) throw new Error('상담 또는 분석 결과를 Core API에 저장하지 못했습니다.');

    const created = await generateCoreDraft(coreContext.coreId, coreContext.coreAnalysisId, hwpxTemplateName);
    const document = normalizeGeneratedDocument(created);
    if (!document.documentId || !document.consultationId) {
      throw new Error('Core API 응답에 다운로드용 문서 ID가 없습니다.');
    }
    return { ...document, draftContent };
  };

  const goToPreview = async () => {
    if (!selectedTemplate) return;
    await runWithLoading(async () => {
      // 화면에 보여줄 편집 가능한 미리보기는 로컬에서 만듭니다(서버 응답은 편집 가능한
      // 텍스트가 아니라 파일 경로만 주기 때문). core-api 연동이 가능한 사건이면, 그와 별도로
      // 실제 초안 문서 레코드(documentId)를 만들어 검토 요청 흐름의 기준으로 삼습니다.
      const nextDraft = buildDraftContent();
      try {
        const document = await generateDraftDocument(nextDraft);
        setDraftDocument(document);
        syncDraftSnapshot(document, nextDraft);
        setGeneratedFileMessage(document.documentId
          ? isHwpxTemplateAlias(selectedTemplate.templateName)
            ? `HWPX 생성 완료 · 원본명 ${resolveHwpxTemplateName(selectedTemplate.templateName)}`
            : 'HWPX 생성 완료'
          : 'HWPX 생성 완료 · 파일 경로 없음');
      } catch (error) {
        setDraftDocument(null);
        const message = draftGenerationErrorMessage(error);
        setGeneratedFileMessage(message);
        showToast(message, 'warn');
      }
      setDraft(nextDraft);
      setSavedMessage('');
      setStep('draft');
    }, '서식 초안을 생성하고 있습니다');
  };

  const regenerateDraftDocument = async () => {
    if (!selectedTemplate) return;
    await runWithLoading(async () => {
      const nextDraft = buildDraftContent();
      try {
        const document = await generateDraftDocument(nextDraft);
        setDraftDocument(document);
        syncDraftSnapshot(document, nextDraft);
        setGeneratedFileMessage(document.documentId
          ? isHwpxTemplateAlias(selectedTemplate.templateName)
            ? `HWPX 재생성 완료 · 원본명 ${resolveHwpxTemplateName(selectedTemplate.templateName)}`
            : 'HWPX 재생성 완료'
          : 'HWPX 재생성 완료 · 파일 경로 없음');
        showToast('HWPX 재생성 완료', 'success');
      } catch (error) {
        setDraftDocument(null);
        const message = draftGenerationErrorMessage(error);
        setGeneratedFileMessage(message);
        showToast(message, 'warn');
      }
    }, 'HWPX 초안을 다시 생성하고 있습니다');
  };

  // 상담원: 변호사에게 검토 요청. documentId가 있어야(core-api에 실제 초안이 저장돼 있어야) 부를 수 있습니다.
  const requestDocumentReview = async () => {
    const consultationId = selectedCase?.coreId || draftDocument?.consultationId;
    if (!draftDocument?.documentId || !consultationId) return;
    if (submitReviewPending) return;
    setSubmitReviewPending(true);
    try {
      if (draftDocument.source !== 'core-api') {
        throw new Error('서버에 저장된 HWPX 초안만 검토 요청할 수 있습니다.');
      }
      const updated = await submitCoreDocumentForReview(consultationId, draftDocument.documentId);
      const normalized = normalizeGeneratedDocument(updated);
      setDraftDocument(normalized);
      syncDraftSnapshot(normalized, draft);
      onNotify?.({
        roles: 'lawyer',
        title: '서식 검토 요청',
        message: `${selectedCase.caseNo} · ${draftDocument.formName || selectedTemplate?.templateName || '서식 초안'}`,
        target: selectedCase.caseNo,
        view: '대시보드',
      });
      showToast('변호사 검토 요청 완료', 'success');
    } catch (error) {
      showToast(`검토 요청에 실패했습니다: ${friendlyErrorMessage(error, '잠시 후 다시 시도해 주세요.')}`, 'warn');
    } finally {
      setSubmitReviewPending(false);
    }
  };

  const canRequestDocumentReview = Boolean(draftDocument?.documentId) && draftDocument?.source === 'core-api' && role !== 'lawyer'
    && draftDocument.status !== 'SUBMITTED_FOR_REVIEW'
    && draftDocument.status !== 'APPROVED';
  const reviewRequestGuide = !draftDocument?.documentId
    ? 'HWPX 생성 후 요청 가능'
    : draftDocument.status === 'SUBMITTED_FOR_REVIEW'
      ? '이미 검토 요청됨'
      : draftDocument.status === 'APPROVED'
        ? '이미 승인됨'
        : '';

  // 저장 버튼이 메시지만 띄우고 실제로는 아무것도 남기지 않으면,
  // 사용자는 저장된 줄 알고 화면을 떠났다가 초안을 잃습니다. 브라우저 저장소에 실제로 남깁니다.
  const saveDraft = () => {
    if (!selectedTemplate) return;
    const entry = {
      id: `${selectedCase?.id || 'no-case'}::${selectedTemplate.templateName}`,
      caseNo: selectedCase?.caseNo || '',
      caseTitle: selectedCase?.title || '',
      templateName: selectedTemplate.templateName,
      draft,
      savedAt: new Date().toISOString(),
    };
    const saved = readStorage(storageKeys.generatedDocuments, []);
    writeStorage(storageKeys.generatedDocuments, [entry, ...saved.filter((item) => item.id !== entry.id)]);
    syncDraftSnapshot(draftDocument, draft);
    const message = `「${selectedTemplate.templateName}」 초안 저장 완료`;
    setSavedMessage(message);
    // 저장 버튼 아래 안내 문구는 스크롤 위치에 따라 안 보일 수 있습니다.
    // 눌렀다는 걸 바로 알 수 있도록 화면 우측 아래 토스트로도 같이 띄웁니다.
    showToast(message, 'success');
  };

  if (step === 'draft') {
    return (
      <main className="workspacePage">
        <section className="workflowPanel draftPanel">
          <h2><FileText size={18} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 서식 초안</h2>
          <div className="draftPreviewHeader">
            <div>
              <strong>{selectedTemplate?.templateName || '선택 서식'}</strong>
              <span>{selectedCase?.caseNo || '-'} · {selectedCase?.title || '상담 미선택'}</span>
            </div>
            {draftDocument?.status ? (
              <span className={`statusChip tone-${documentStatusTone(draftDocument.status)}`}>
                {DOCUMENT_STATUS_LABEL[draftDocument.status] || draftDocument.status}
              </span>
            ) : (
              <span className="statusChip tone-info">HWPX 생성 연동 준비</span>
            )}
          </div>
          {/* 네모칸 안의 글과 내려받는 HWPX는 서로 다른 내용입니다(generateDraftText 주석).
              첫 줄에도 적어 두었지만 상담원이 그 줄을 지우고 쓰기 시작하면 사라지므로,
              칸 밖에도 남겨 둡니다. */}
          <p className="helperText">
            확인용 요약입니다. 실제 서식 본문은 아래 HWPX 파일에 들어 있고, 이 칸에서 고친 내용은
            파일과 변호사 검토본에 반영되지 않습니다.
          </p>
          <div className="scrollBox">
            <textarea className="draftEditor" value={draft} onChange={(e) => setDraft(e.target.value)} />
          </div>
          <div className="draftFinalActions">
            <button className="ghostActionButton compactAction" type="button" onClick={() => setStep('select')}>서식 선택으로 돌아가기</button>
            <button className="primaryButton compactAction" type="button" onClick={saveDraft}>서식 내용 저장</button>
            <button
              className="secondaryActionButton compactAction"
              type="button"
              onClick={requestDocumentReview}
              disabled={submitReviewPending || !canRequestDocumentReview}
              title={reviewRequestGuide || undefined}
            >
              <Send size={13} strokeWidth={2.4} aria-hidden="true" /> {submitReviewPending ? '검토 요청하는 중…' : draftDocument?.status === 'SUBMITTED_FOR_REVIEW' ? '검토 요청됨' : '변호사 검토 요청'}
            </button>
            <button className="secondaryActionButton compactAction" type="button" onClick={regenerateDraftDocument}><Download size={13} strokeWidth={2.4} aria-hidden="true" /> HWPX 다시 생성</button>
          </div>
          {reviewRequestGuide ? <p className="helperText">{reviewRequestGuide}</p> : null}
          {savedMessage ? <p className="successBanner"><span className="successBannerBadge"><CheckCircle2 size={12} strokeWidth={2.4} aria-hidden="true" />저장 완료</span>{savedMessage}</p> : null}
          {generatedFileMessage ? <p className="apiPendingMessage" role="status">{generatedFileMessage}</p> : null}
          {/* consultationId는 selectedCase.coreId보다 draftDocument.consultationId(방금 생성 응답이 실제로
              알려준 값)를 우선 씁니다. 사건을 core-api에 처음 동기화하면서 같은 함수 실행 중 초안까지
              만든 경우, selectedCase는 이 렌더의 클로저에 잡힌 값이라 아직 갱신 전이라 비어 있을 수
              있는데, draftDocument는 방금 성공한 생성 응답 자체라 항상 최신값입니다. */}
          <GeneratedFileBox document={draftDocument} consultationId={draftDocument?.consultationId || selectedCase?.coreId} />
        </section>
      </main>
    );
  }

  return (
    <main className="workspacePage">
      <section className="workflowPanel draftPanel">
        <WorkPageHeader
          title={isLawyerReviewer ? '서식 초안 검토' : '서식 초안 생성'}
          description={isLawyerReviewer
            ? '제출된 초안을 확인하고 승인 또는 반려하세요.'
            : '사건과 서식을 선택한 뒤 초안을 생성하세요.'}
        />
        <div className="apiPendingBanner">
          <FileText className="apiPendingBannerIcon" size={18} strokeWidth={2.2} aria-hidden="true" />
          <span className="apiPendingBannerText">
            <strong>{isLawyerReviewer ? 'HWPX 서식 검토 연동' : 'HWPX 서식 생성 연동'}</strong>
            <small>
              {isLawyerReviewer
                ? '초안 검토 · 결과 저장'
                : 'HWPX 생성 · 검토 요청 · 승인 흐름'}
            </small>
          </span>
        </div>
        <div className="inlineControls">
          <CasePicker consultations={consultations} value={caseId} onChange={setCaseId} />
        </div>
        {selectedCase ? (
          <div className="draftCaseSummary">
            <span><small>사건 유형</small><strong>{draftCaseType || '분석 전'}</strong></span>
            <span><small>상담 제목</small><strong>{selectedCase.title}</strong></span>
            <span><small>첨부자료</small><strong>{selectedCase.attachments?.length || 0}건</strong></span>
          </div>
        ) : null}
        {/* 주소·전화번호는 초안을 만들 때만 필요하므로 여기서 받습니다. 상담만 받고
            끝나는 경우에는 묻지 않습니다(개인정보 보호법 제3조 제1항 — 필요한 최소한).
            변호사는 제출된 초안을 검토만 하므로 이 칸을 보지 않습니다. */}
        {selectedCase && !isLawyerReviewer ? (
          <>
            <DraftContactConsent
              consultation={selectedCase}
              onChange={updateDraftContact}
            />
            {contactSaveError
              ? <p className="apiPendingMessage" role="status">{contactSaveError}</p>
              : null}
          </>
        ) : null}
        {selectedCase ? (
          <section className="documentReviewPanel">
            <div className="panelTitleRow">
              <h3><ClipboardList size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> {isLawyerReviewer ? '제출된 서식 검토' : '제출한 서식 상태'}</h3>
              {documentsLoading ? <span className="helperText">불러오는 중…</span> : null}
            </div>
            {!selectedCase.coreId ? (
              <InlineEmptyNotice>로컬 상담 · 서식 검토 불러오기 불가</InlineEmptyNotice>
            ) : caseDocuments.length ? (
              <div className="documentReviewList">
                {caseDocuments.map((doc) => {
                  const lawyerEdit = readLawyerDraftEdit(doc.document_id);
                  const isReviewingThis = reviewingDocumentId === doc.document_id;
                  return (
                    <div className="documentReviewRow" key={doc.document_id}>
                      <div className="documentReviewInfo">
                        <strong><FileText size={14} strokeWidth={2.2} aria-hidden="true" /> {doc.form_name}</strong>
                        <span className={`statusChip tone-${documentStatusTone(doc.status)}`}>{DOCUMENT_STATUS_LABEL[doc.status] || doc.status}</span>
                        {lawyerEdit ? <span className="statusChip tone-warn">변호사 수정본</span> : null}
                        <GeneratedFileLink
                          path={doc.draft_file_path}
                          consultationId={selectedCase.coreId}
                          documentId={doc.document_id}
                          content={lawyerEdit?.content || doc.draft_content}
                          downloadFileName={doc.download_file_name}
                        />
                        {/* 서버에는 반영되지 않는 로컬 전용 수정본이라는 점을 항상 보이는 캡션으로
                            남겨, 상담원이 이걸 서버에 저장된 최종본으로 오해하지 않게 합니다. */}
                        {lawyerEdit ? <p className="localEditOnlyCaption">로컬 임시 저장 · 이 브라우저에서만 표시</p> : null}
                        {lawyerEdit && !isReviewingThis ? <pre className="documentLawyerEditPreview">{lawyerEdit.content}</pre> : null}
                        {doc.review_note ? <p className="reasonText">지난 검토 코멘트: {doc.review_note}</p> : null}
                        {doc.requested_materials?.length ? <p className="reasonText">요청 자료: {doc.requested_materials.join(', ')}</p> : null}
                      </div>
                      {isLawyerReviewer && doc.status === 'SUBMITTED_FOR_REVIEW' ? (
                        isReviewingThis ? (
                          <div className="documentReviewForm">
                            <div className="draftView">
                              <div className="draftViewPane">
                                <div className="draftViewPaneHeader"><strong>편집</strong></div>
                                <textarea
                                  className="documentReviewContentEditor"
                                  value={reviewContentDraft}
                                  onChange={(event) => setReviewContentDraft(event.target.value)}
                                  placeholder="서식 초안 내용을 입력하거나 고치세요."
                                  aria-label="서식 초안 내용 편집"
                                />
                              </div>
                              <div className="draftViewPane">
                                <div className="draftViewPaneHeader">
                                  <strong>미리보기</strong>
                                  <span className="statusChip tone-info">변호사 수정본</span>
                                </div>
                                {reviewContentDraft ? <pre>{reviewContentDraft}</pre> : <p className="helperText">입력 내용 없음</p>}
                              </div>
                            </div>
                            <textarea
                              value={reviewNoteText}
                              onChange={(event) => setReviewNoteText(event.target.value)}
                              placeholder="내부 검토 메모 (선택)"
                              aria-label="내부 검토 메모"
                            />
                            <div className="inlineControls">
                              <button type="button" onClick={cancelDocumentReview} disabled={reviewPending}>취소</button>
                              <button
                                className="primaryButton"
                                type="button"
                                onClick={() => confirmDocumentReview(doc)}
                                disabled={reviewPending}
                              >
                                {reviewPending ? '처리하는 중…' : '검토 완료'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          // 실제 승인 확정 버튼(3001-3008줄)과 같은 '검토 완료' 문구를 여기 편집 시작
                          // 버튼에도 쓰면 눌러도 아무 것도 끝나지 않아 헷갈립니다(코치 피드백).
                          <div className="inlineControls">
                            <button className="secondaryActionButton" type="button" onClick={() => startDocumentReview(doc)}>검토하기</button>
                          </div>
                        )
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              !documentsLoading ? <InlineEmptyNotice>제출된 서식 초안 없음</InlineEmptyNotice> : null
            )}
          </section>
        ) : null}
        {!isLawyerReviewer ? (
          /* 시안: '서식 선택'과 '추출 필드 자동 채움', 그리고 생성 버튼까지 흰 카드 하나에 담깁니다. */
          <div className="draftSelectCard">
            <div className="workflowColumns">
              <div>
                <h3><FileText size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 서식 선택</h3>
                {/* 0단계: 이 사건 분류에 맞는 서식만 보기.
                    291개에서 손으로 좁히지 않아도 되게, 확정된 소분류로 한 번에 걸러줍니다. */}
                <div className="templateScopeRow">
                  <button
                    className={scopeToCase ? 'templateScopeToggle active' : 'templateScopeToggle'}
                    type="button"
                    aria-pressed={scopeToCase}
                    disabled={!draftCaseType}
                    onClick={() => { setOnlyForCase((current) => !current); setMajorFilter('전체'); setMinorFilter('전체'); }}
                  >
                    {draftCaseType ? `'${draftCaseType}' 서식만 보기` : '사건을 먼저 선택하세요'}
                  </button>
                  {scopeToCase && !filteredTemplates.length ? (
                    <span className="templateScopeEmpty">연결 서식 없음 · 전체 검색</span>
                  ) : null}
                </div>
                {/* 1단계: 대분류 탭 (4개 + 전체) — 소분류 29개를 한꺼번에 늘어놓지 않고 단계적으로 좁힙니다. */}
                <div className="categoryTabs">
                  {['전체', ...caseCategories.map((category) => category.key)].map((category) => (
                    <button
                      className={majorFilter === category ? 'categoryTab active' : 'categoryTab'}
                      type="button"
                      key={category}
                      onClick={() => { setMajorFilter(category); setMinorFilter('전체'); }}
                    >
                      {category}
                    </button>
                  ))}
                </div>
                {/* 2단계: 소분류 드롭다운 + 서식명 검색 */}
                <div className="templateFilterRow">
                  <div className="templateFilterPicker">
                    <ChoicePicker
                      value={minorFilter}
                      options={minorOptions.map((option, index) => ({
                        value: option,
                        label: index === 0 ? '소분류 전체' : option,
                      }))}
                      onChange={setMinorFilter}
                      disabled={!activeMajor}
                      placeholder="소분류 선택"
                    />
                  </div>
                  <input
                    className="templateSearchInput"
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    placeholder="서식명 검색"
                    aria-label="서식명 검색"
                  />
                </div>
                <p className="templateCount">
                  검색 결과 {templates.length}건
                  {recommendLoading ? <span className="templateRecommendLoading"> · AI 추천 확인 중…</span> : null}
                </p>
                {/* 3단계: 서식 목록 */}
                <div className="templateList">
                  {templates.length ? templates.map((item) => {
                    const aiMatch = aiRecommendations.find((rec) => rec.form_name === item.templateName);
                    return (
                      <button
                        className={selectedTemplate?.templateName === item.templateName ? 'templateRow active' : 'templateRow'}
                        type="button"
                        key={item.templateName}
                        onClick={() => setTemplate(item.templateName)}
                      >
                        <span className="templateRowText">
                          <span className="templateRowName">
                            {item.templateName}
                            {aiMatch ? <em className="templateAiBadge" title={aiMatch.reason || 'AI 추천 서식'}><Sparkles size={10} strokeWidth={2.4} aria-hidden="true" />AI 추천</em> : null}
                          </span>
                          <span className="templateRowMeta">{item.caseCategory} · {item.caseType}</span>
                        </span>
                        <span
                          className={favorites.includes(item.templateName) ? 'favoriteToggle active' : 'favoriteToggle'}
                          role="button"
                          tabIndex={0}
                          aria-label={favorites.includes(item.templateName) ? '즐겨찾기 해제' : '즐겨찾기 추가'}
                          onClick={(event) => handleToggleFavorite(item.templateName, event)}
                        >
                          {favorites.includes(item.templateName)
                            ? <Star size={13} strokeWidth={2.2} fill="currentColor" aria-hidden="true" />
                            : <Plus size={13} strokeWidth={2.4} aria-hidden="true" />}
                        </span>
                      </button>
                    );
                  }) : <InlineEmptyNotice>조건에 맞는 서식이 없습니다.</InlineEmptyNotice>}
                </div>
              </div>
              <div>
                <h3><ListChecks size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 추출 필드 자동 채움</h3>
                <div className="draftApiPlan">
                  <strong>자동 채움에 쓰이는 정보</strong>
                  <span>서식명, 상담 번호, 분석 요약, 누락 필드, 첨부자료 정보</span>
                </div>
                <div className="scrollBox">
                  {selectedTemplate ? (
                    <div className="draftFieldList">
                      {draftFields.map((item) => {
                        // '당사자 정보'·'청구 취지'처럼 짧은 값은 라벨과 한 줄에 나란히 둬도 읽기 좋지만,
                        // '관련 사실관계'처럼 문장 전체가 들어가는 값은 같은 방식으로 좁게 우측 정렬하면
                        // 라벨·값이 둘 다 세로로 쪼개져 읽기 힘들어집니다. 값 길이에 따라 레이아웃을 바꿉니다.
                        const isLongValue = item.filled && item.value.length > 18;
                        return (
                          <div key={item.field} className={`draftFieldRow ${item.filled ? 'filled' : 'missing'}${isLongValue ? ' longValue' : ''}`}>
                            <span className="draftFieldName">{item.field}</span>
                            <span className="draftFieldValue">{item.filled ? item.value : '누락 - 확인 필요'}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : <p>서식을 선택하면 항목 표시</p>}
                </div>
              </div>
            </div>
            <div className="draftFinalActions">
              <button className="primaryButton compactAction" type="button" onClick={goToPreview} disabled={!selectedTemplate}>서식 초안 생성</button>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
