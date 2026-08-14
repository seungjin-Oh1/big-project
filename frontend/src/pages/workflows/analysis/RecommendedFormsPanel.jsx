import React, { useState, useEffect } from 'react';
import { Sparkles, FileText, Star, CheckCircle2, RotateCcw } from 'lucide-react';
import { useConfirm, useToast } from '../../../components/feedback.jsx';
import { cacheFormRecommendations, readCachedFormRecommendations } from '../../../services/draftDocumentStore.js';
import { recommendCoreForms } from '../../../services/coreApiClientV2.js';
import { recommendTemplates } from '../../../services/legalAidApi.js';
import { legalTemplateSeed } from '../../../data/domain.js';
import { resolveConfirmedCaseType } from '../shared/caseHelpers.js';
import { readStorage, writeStorage, storageKeys } from '../../../services/storage.js';

// 코치 피드백: "실시간 상담 때 서식을 추천 및 초안 작성을 해주고". 분석이 끝나면 곧바로
// 이 화면 안에서 추천 서식을 보여주고, 한 번의 클릭으로 사건이 선택된 채 서식 생성 화면으로
// 넘어가게 합니다(예전엔 메뉴를 옮겨 사건을 다시 골라야 했습니다).
// coreId·분석id가 있으면 실제 ai-api 추천(recommendCoreForms)을, 없으면 로컬 휴리스틱
// (recommendTemplates, DraftWorkbench와 같은 함수)을 그대로 재사용합니다.
// 서식 추천을 가져옵니다. 실시간 상담 분석 화면과 서식 생성 화면이 같이 씁니다.
//
// 예전엔 두 화면이 각자 recommendCoreForms를 불러서, 분석 화면에서 추천을 본 뒤
// 초안 만들기로 넘어가면 같은 상담·같은 분석인데도 처음부터 다시 돌렸습니다
// (ai-api 임베딩 검색 + GPT 재랭킹이라 몇 초 걸립니다).
//
// 순서대로 찾습니다.
//   1) 저장된 분석의 recommendation_json — 새로고침해도 남아 있는 유일한 자리
//   2) 이번 세션 메모리 캐시 — 아직 저장 전이라도 화면 사이를 오갈 때 재사용
//   3) 없으면 API 호출 후 두 곳에 모두 남김
export function useFormRecommendations(selectedCase) {
  const coreId = selectedCase?.coreId;
  const analysisId = selectedCase?.coreAnalysisId;
  const canUseCoreApi = Boolean(coreId && analysisId);
  // 저장된 분석에 이미 추천이 들어 있으면 그걸 그대로 씁니다.
  const savedRecommendations = selectedCase?.analysis?.recommendation?.recommendations;
  const draftCaseType = resolveConfirmedCaseType(selectedCase);

  // AI가 비등록 서식을 섞어 보내더라도, 실제 생성 가능한 기존 서식만 씁니다. 유효한 AI
  // 추천이 3개보다 적으면 같은 사건 유형의 기존 서식으로 다음 후보를 보충합니다. 그래서
  // "AI가 준 3개 중 1개를 버려 2개만 보이는" 대신 항상 3개의 실행 가능한 선택지를 줍니다.
  const ensureThreeCatalogRecommendations = (items) => {
    const catalogNames = new Set(legalTemplateSeed.map((template) => template.templateName));
    const seen = new Set();
    const validAiRecommendations = (Array.isArray(items) ? items : [])
      .filter((item) => {
        if (!catalogNames.has(item?.form_name) || seen.has(item.form_name)) return false;
        seen.add(item.form_name);
        return true;
      })
      .map((item) => ({ ...item, source: 'ai' }));
    const relatedTemplates = recommendTemplates(draftCaseType);
    const fallbackTemplates = [...relatedTemplates, ...legalTemplateSeed]
      .filter((template) => !seen.has(template.templateName));
    const supplements = fallbackTemplates.slice(0, Math.max(0, 3 - validAiRecommendations.length))
      .map((template) => ({
        form_name: template.templateName,
        reason: 'AI 추천에서 제외된 비등록 서식 대신, 현재 사건 유형에 맞는 등록 서식으로 보충했습니다.',
        source: 'catalog_fallback',
      }));
    return [...validAiRecommendations, ...supplements].slice(0, 3);
  };

  const initial = ensureThreeCatalogRecommendations((Array.isArray(savedRecommendations) && savedRecommendations.length)
    ? savedRecommendations
    : (readCachedFormRecommendations(coreId, analysisId) || []));

  const [aiRecommendations, setAiRecommendations] = useState(initial);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!canUseCoreApi) { setAiRecommendations([]); return undefined; }

    if (Array.isArray(savedRecommendations) && savedRecommendations.length) {
      const catalogRecommendations = ensureThreeCatalogRecommendations(savedRecommendations);
      cacheFormRecommendations(coreId, analysisId, catalogRecommendations);
      setAiRecommendations(catalogRecommendations);
      return undefined;
    }
    const cached = readCachedFormRecommendations(coreId, analysisId);
    if (cached) { setAiRecommendations(ensureThreeCatalogRecommendations(cached)); return undefined; }

    let cancelled = false;
    setAiRecommendations([]);
    setLoading(true);
    recommendCoreForms(coreId, analysisId)
      .then((response) => {
        const list = ensureThreeCatalogRecommendations(response?.recommendations);
        cacheFormRecommendations(coreId, analysisId, list);
        if (!cancelled) setAiRecommendations(list);
      })
      .catch(() => { if (!cancelled) setAiRecommendations([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseCoreApi, coreId, analysisId, savedRecommendations, draftCaseType]);

  return { aiRecommendations, loading };
}

export function RecommendedFormsPanel({ selectedCase, onSaveBeforeOpen, saving }) {
  const confirm = useConfirm();
  const showToast = useToast();
  const draftCaseType = resolveConfirmedCaseType(selectedCase);
  const { aiRecommendations, loading } = useFormRecommendations(selectedCase);

  // 실제 ai-api 추천이 있으면 'AI 추천' 배지를, 없어 로컬 휴리스틱으로 대체한 경우는
  // '추천' 배지로 구분해 어떤 근거로 골랐는지 헷갈리지 않게 합니다.
  const usingAiRecommendations = Boolean(aiRecommendations.length);
  const localTemplateNames = draftCaseType ? recommendTemplates(draftCaseType).map((item) => item.templateName) : [];
  const templateEntries = usingAiRecommendations
    ? aiRecommendations.map((item) => ({ name: item.form_name, source: item.source || 'ai' })).filter((item) => item.name)
    : localTemplateNames.map((name) => ({ name, source: 'local' }));
  // 초안을 실제로 생성한 서식은 사건·서식 조합으로 저장해 둡니다. 추천 목록에서도 그 기록을
  // 읽어, 이미 만든 초안을 다시 만들 필요가 없다는 사실을 바로 알 수 있게 합니다.
  const [createdDrafts, setCreatedDrafts] = useState([]);
  useEffect(() => {
    const refreshCreatedDrafts = () => {
      setCreatedDrafts(readStorage(storageKeys.generatedDocuments, [])
        .filter((item) => String(item.caseId || item.id?.split('::')[0] || '') === String(selectedCase?.id || '')));
    };
    const handleStorageUpdate = (event) => {
      const changedKey = event.detail?.key || event.key;
      if (changedKey === storageKeys.generatedDocuments) refreshCreatedDrafts();
    };
    refreshCreatedDrafts();
    window.addEventListener('legalAidStorageUpdated', handleStorageUpdate);
    window.addEventListener('storage', handleStorageUpdate);
    return () => {
      window.removeEventListener('legalAidStorageUpdated', handleStorageUpdate);
      window.removeEventListener('storage', handleStorageUpdate);
    };
  }, [selectedCase?.id]);

  const resetCreatedDrafts = async () => {
    if (!selectedCase?.id || !createdDrafts.length) return;
    const accepted = await confirm({
      title: '이 사건의 초안 기록을 초기화할까요?',
      message: '이 브라우저에 저장된 초안 표시와 편집 스냅샷만 지워집니다. 이미 생성된 서버 문서는 삭제되지 않으며, 다시 분석·초안 생성을 시연할 수 있습니다.',
      confirmLabel: '초안 기록 초기화',
      tone: 'danger',
    });
    if (!accepted) return;
    const caseId = String(selectedCase.id);
    const caseNo = String(selectedCase.caseNo || '');
    writeStorage(storageKeys.generatedDocuments, readStorage(storageKeys.generatedDocuments, [])
      .filter((item) => String(item.caseId || item.id?.split('::')[0] || '') !== caseId));
    writeStorage(storageKeys.documentDraftSnapshots, readStorage(storageKeys.documentDraftSnapshots, [])
      .filter((item) => {
        const matchesConsultation = Boolean(selectedCase.coreId)
          && String(item.consultationId || '') === String(selectedCase.coreId);
        const matchesCaseNo = Boolean(caseNo) && String(item.caseNo || '') === caseNo;
        return !matchesConsultation && !matchesCaseNo;
      }));
    setCreatedDrafts([]);
    showToast('이 사건의 초안 기록을 초기화했습니다. 다시 초안을 만들 수 있습니다.', 'success');
  };

  return (
    <section className="recommendedFormsPanel">
      <div className="recommendedFormsHeader">
        <div>
          <h3><Sparkles size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 추천 서식</h3>
          <p>{draftCaseType ? `${draftCaseType} 기준 추천` : '사건 유형 확정 후 추천'}</p>
        </div>
        {createdDrafts.length ? (
          <button type="button" className="smallButton light recommendedFormsResetButton" onClick={resetCreatedDrafts} disabled={saving}>
            <RotateCcw size={14} strokeWidth={2.3} aria-hidden="true" /> 초안 기록 초기화
          </button>
        ) : null}
      </div>
      {loading ? <p className="helperText">추천 서식을 불러오는 중…</p> : null}
      {templateEntries.length ? (
        <div className="recommendedFormsList" tabIndex="0" aria-label="추천 서식 목록. 처음 세 항목이 표시되며, 더 많은 서식은 스크롤하여 확인할 수 있습니다.">
          {templateEntries.map(({ name, source }) => {
            const createdDraft = createdDrafts.find((item) => item.templateName === name);
            const isAiRecommendation = source === 'ai';
            return (
            <div className={createdDraft ? 'tmplRow hasCreatedDraft' : 'tmplRow'} key={name}>
              <span className="tmplRowName">
                <FileText size={14} strokeWidth={2.2} aria-hidden="true" /> {name}
                <em className={`tmplRowBadge statusChip ${isAiRecommendation ? 'tone-info' : 'tone-muted'}`}>
                  {isAiRecommendation ? <Star size={11} strokeWidth={2.4} aria-hidden="true" /> : null} {isAiRecommendation ? 'AI 추천' : source === 'catalog_fallback' ? '추천 보충' : '추천'}
                </em>
                {createdDraft ? <em className="tmplRowBadge statusChip tone-success" title={`초안 생성: ${new Date(createdDraft.createdAt || createdDraft.savedAt).toLocaleString('ko-KR')}`}><CheckCircle2 size={11} strokeWidth={2.4} aria-hidden="true" /> 내가 만든 초안</em> : null}
              </span>
              {/* 이 버튼은 분석을 저장하고 선택한 서식의 작성 화면을 엽니다. 실제 HWPX 초안은
                  다음 화면의 '서식 초안 생성'을 눌렀을 때 만들어지며, 그 순간 이 목록의
                  '내가 만든 초안' 표시가 자동으로 갱신됩니다. */}
              {/* 예전엔 추천 서식 3개 중 무엇을 눌러도 항상 caseId만 넘겨서, 서식 생성
                  화면은 어느 걸 눌렀는지 모르고 매번 같은(초기) 서식으로 열렸습니다
                  (코치 피드백). 어떤 서식을 눌렀는지도 함께 넘깁니다. */}
              <button
                type="button"
                className="secondaryActionButton compactAction"
                onClick={() => onSaveBeforeOpen?.(selectedCase.id, name)}
                disabled={!onSaveBeforeOpen || saving}
              >
                {saving ? '저장하는 중...' : createdDraft ? '내 초안 열기' : '저장하고 초안 화면 열기'}
              </button>
            </div>
            );
          })}
        </div>
      ) : <p className="helperText">분석 저장 후 추천 가능</p>}
    </section>
  );
}
