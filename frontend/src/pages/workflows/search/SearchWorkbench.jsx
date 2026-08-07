import React, { useEffect, useRef, useState } from 'react';
import { ClipboardList, CheckCircle2, Gavel, BookOpen } from 'lucide-react';
import { WorkPageHeader, InlineEmptyNotice, friendlyErrorMessage } from '../../../components/common.jsx';
import { searchReferenceCandidates } from '../../../services/legalAidApi.js';
import {
  recommendConsultations, recommendPrecedents, recommendStatutes,
  searchConsultations, searchPrecedents, searchStatutes,
} from '../../../services/aiApiClient.js';
import { caseOptions } from '../shared/caseHelpers.js';
import { referenceTypeLabel } from '../shared/referenceTypes.js';
import { CasePicker } from '../components/CasePicker.jsx';
import { FullTextModal } from '../components/FullTextModal.jsx';

// '직접 검색'은 색인이 주는 만큼 한 번에 다 받습니다. 상담원이 검색어를 넣어
// 찾을 때는 몇 건인지 미리 정해줄 이유가 없고, 20건씩 끊어 '더 보기'를 누르게
// 하면 찾는 것이 21위일 때 없다고 결론내기 쉽습니다.
//
// 판례는 색인 전체가 342건이라 이 값이면 걸리는 것은 다 옵니다. 조문은 색인이
// 2,289청크라 이론상 더 있을 수 있지만, 유사도가 78~90% 안에 뭉쳐 있어 뒤로 갈수록
// 사건과 무관한 것들입니다 — 그걸 다 그리면 화면만 무거워지고 고르기는 어려워집니다.
//
// 추천은 다릅니다 — AI가 상담에 맞는 것만 골라내는 것이라 상위 몇 건만 의미가
// 있고, 건수는 서버가 정합니다(RECOMMEND_TOP_K).
const RAG_SEARCH_LIMIT = 500;

// 법령 API의 시행일은 '20260317', 판례 API의 선고일도 같은 8자리 형태입니다.
// 그대로 두면 날짜로 안 읽힙니다.
function formatLegalDate(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 8) return value || '';
  return `${digits.slice(0, 4)}. ${Number(digits.slice(4, 6))}. ${Number(digits.slice(6, 8))}.`;
}

// 법령·판례 카드에는 길이와 상관없이 항상 '원문 보기'를 답니다.
//
// 처음에는 본문이 잘려 보일 때만(4줄/160자 초과) 버튼을 달았는데, 기준 자체가
// 틀렸습니다. 판례 카드에 실리는 것은 판시사항 — 대법원이 "이 판결의 요점은
// 이것"이라고 붙여놓은 한두 문장짜리 요약이지 판결문이 아닙니다. 짧아서 다
// 보이는 것과, 그게 원문의 전부인 것은 다릅니다.
//
// 실측: 2016므989는 판시사항이 150자쯤이라 버튼이 안 붙었지만 판결문은 따로 있고
// 훨씬 깁니다. 조문도 800자마다 잘려 색인에 들어가 있어(rag/chunking.py) 카드만
// 보고 전체인지 알 수 없습니다.
//
// 그래서 '잘렸나'를 재지 않습니다. 원문을 따로 가진 탭이면 항상 길을 열어 둡니다.

// 탭별로 다른 것은 '어느 API를 부르는가'와 화면 문구뿐입니다. 나머지 흐름
// (추천 자동 실행, 카드 그리기)은 같아서 한 벌로 씁니다.
const RAG_TABS = {
  statute: {
    label: '법령',
    search: ({ query, topK }) => searchStatutes({ query, topK }),
    recommend: (analysis, options) => recommendStatutes(analysis, options),
    dateLabel: '시행',
    bodyToggleLabel: '조문 원문 보기',
    countMessage: (n) => `조문 ${n}건 · 국가법령정보센터`,
    emptyRecommend: '이 상담에 바로 쓸 조문을 찾지 못했습니다 · 직접 검색으로 찾아보세요',
    emptySearch: '해당하는 조문을 찾지 못했습니다 · 검색어를 바꿔보세요',
    errorMessage: '법령을 불러오지 못했습니다',
  },
  precedent: {
    label: '판례',
    search: ({ query, topK }) => searchPrecedents({ query, topK }),
    recommend: (analysis, options) => recommendPrecedents(analysis, options),
    dateLabel: '선고',
    bodyToggleLabel: '판례 원문 보기',
    countMessage: (n) => `판례 ${n}건 · 국가법령정보센터`,
    emptyRecommend: '이 상담에 참고할 판례를 찾지 못했습니다 · 직접 검색으로 찾아보세요',
    emptySearch: '해당하는 판례를 찾지 못했습니다 · 검색어를 바꿔보세요',
    errorMessage: '판례를 불러오지 못했습니다',
  },
  // 세 번째 자료. 법령이 '조문', 판례가 '법원 판단'이라면 이건 '공단이 실제로
  // 답변한 기록'입니다 — 같은 질문에 이미 나간 답이 있으면 그게 가장 빠른 길입니다.
  // 카드 제목 자리에는 상담 질문이, 본문에는 답변이 들어옵니다.
  similar: {
    label: '유사 상담사례',
    search: ({ query, topK }) => searchConsultations({ query, topK }),
    recommend: (analysis, options) => recommendConsultations(analysis, options),
    // 법령의 시행일·판례의 선고일 자리에 오는 것은 자료 기준일입니다.
    dateLabel: '기준',
    bodyToggleLabel: '답변 전문 보기',
    countMessage: (n) => `상담사례 ${n}건 · 대한법률구조공단`,
    emptyRecommend: '이 상담과 비슷한 상담 기록을 찾지 못했습니다 · 직접 검색으로 찾아보세요',
    emptySearch: '해당하는 상담사례를 찾지 못했습니다 · 검색어를 바꿔보세요',
    errorMessage: '상담사례를 불러오지 못했습니다',
  },
};

// 결과가 오기 전까지 카드가 들어설 자리를 미리 잡아 둡니다. 빈 칸을 두거나 '없음'을
// 띄우면, 몇 초 뒤 목록이 불쑥 나타나 화면이 튀고 상담원이 "없다"로 오해합니다.
// 카드와 같은 모양·같은 높이라 결과가 들어와도 자리가 흔들리지 않습니다.
function ReferenceSkeleton({ count = 3 }) {
  return (
    <div className="referenceSkeletonList" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="referenceCard referenceSkeleton" key={index}>
          <span className="skeletonBar skeletonBarTitle" />
          <span className="skeletonBar" />
          <span className="skeletonBar skeletonBarShort" />
        </div>
      ))}
    </div>
  );
}

export function SearchWorkbench({ consultations, onAnalysisSaved, onNotify }) {
  const [caseId, setCaseId] = useState(caseOptions(consultations)[0].id);
  const [referenceType, setReferenceType] = useState('precedent');
  const [mode, setMode] = useState('추천');
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState([]);
  const [referenceMessage, setReferenceMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const label = referenceTypeLabel(referenceType);
  const selectedCase = consultations.find((item) => String(item.id) === String(caseId));

  // 세 탭 모두 실제 색인을 검색합니다. 유사 상담사례는 색인이 없어 예시 목록을
  // 쓰고 있었는데, 상담사례 RAG(가사 1,664건)가 붙어 이제 셋 다 실제 자료입니다.
  //
  // 아래 searchReferenceCandidates 폴백은 그래서 지금은 아무 탭도 타지 않습니다.
  // 그래도 남겨둡니다 — 탭이 늘 때 색인보다 화면이 먼저 나오는 일이 반복돼서,
  // RAG_TABS에 없는 탭이 생겨도 화면이 빈 채로 죽지 않게 하는 자리입니다.
  const [ragResults, setRagResults] = useState([]);
  const [ragLoading, setRagLoading] = useState(false);
  // '전문 보기'로 연 자료. 카드 안에서 펼치지 않고 창으로 띄웁니다 — 카드에 실린
  // 본문은 색인이 쪼갠 조각 하나여서, 펼쳐 봐야 여전히 잘린 글입니다.
  const [fullTextItem, setFullTextItem] = useState(null);
  const ragTab = RAG_TABS[referenceType] || null;
  const isRagTab = Boolean(ragTab);

  const results = isRagTab
    ? ragResults
    : (searched || mode === '추천'
      ? searchReferenceCandidates({ type: referenceType, query, caseType: selectedCase?.analysis?.caseType || selectedCase?.type })
      : []);
  // 제목이 아니라 id로 비교합니다. 판례는 사건명이 "양육비"처럼 청구 종류만
  // 적혀 있어 서로 다른 사건이 같은 제목을 갖는데, 제목으로 비교하면 하나를
  // 고를 때 같은 이름의 다른 판례까지 전부 '선택됨'으로 표시됩니다.
  const selectedIds = selected.map((item) => item.id);

  // 검색 결과 한 건을 화면 카드가 기대하는 모양({id, title, source})으로 맞춥니다.
  // 조문 본문과 유사도는 추가 필드로 얹어, 카드가 쓸 수 있으면 쓰도록 합니다.
  const toReferenceItem = (row) => ({
    id: row.id,
    title: row.title,
    source: row.source || '국가법령정보센터',
    caseType: '공통',
    content: row.content || '',
    similarityPercent: row.similarity_percent ?? null,
    reason: row.reason || '',
    effectiveDate: row.effective_date || '',
    // 판례 원문은 사건 단위로 받아야 합니다(카드가 판시사항 조각에서 걸렸을 수 있음).
    precedentId: row.precedent_id || '',
    // AI가 골라준 것인지(llm) 유사도 순으로 올라온 것인지(similarity). 담아서
    // 저장할 때 함께 남겨, 나중에 'AI 추천을 채택한 것'과 '직접 찾은 것'을
    // 구분할 수 있게 합니다.
    selectedBy: row.selected_by || '',
  });

  // isCurrent: 응답이 도착했을 때도 이 요청이 여전히 최신인지 묻습니다. 상담을
  // 빠르게 넘기면 앞선 요청이 뒤늦게 도착해 새 상담의 결과를 덮어씁니다.
  const runRagQuery = async (kind, isCurrent = () => true) => {
    if (!ragTab) return;
    setRagLoading(true);
    setSearched(true);
    // 무엇을 하는 중인지 먼저 알립니다. 예전에는 이 자리에 직전 결과나 '조건 일치
    // 없음'이 그대로 남아 있다가 몇 초 뒤 목록이 불쑥 나타나서, 상담원이 "없다"고
    // 읽고 다른 탭으로 넘어간 뒤에 결과가 뜨는 일이 있었습니다. 추천은 상담 내용을
    // 임베딩해 색인을 뒤지는 작업이라 몇 초가 걸립니다.
    setReferenceMessage(kind === '추천'
      ? `상담 내용으로 ${ragTab.label}을(를) 찾는 중입니다…`
      : `${ragTab.label}을(를) 검색하는 중입니다…`);
    setRagResults([]);
    try {
      const payload = kind === '추천'
        ? await ragTab.recommend({
          caseType: selectedCase?.analysis?.caseType || selectedCase?.type || '',
          caseSubtype: selectedCase?.analysis?.caseSubtype || '',
          summary: selectedCase?.analysis?.summary || '',
          extractedJson: selectedCase?.analysis?.extractedJson || {},
        })
        : await ragTab.search({ query, topK: RAG_SEARCH_LIMIT });
      if (!isCurrent()) return;
      const rows = (payload?.results || []).map(toReferenceItem);
      setRagResults(rows);
      // 저장해 둔 자료를 되살릴 때는 원문이 없을 수 있습니다(원문을 함께 저장하기
      // 전에 담아둔 것). 그 상태로 다시 저장하면 빈 원문이 그대로 다시 저장되므로,
      // 검색 결과에 같은 항목이 있으면 원문을 채워 넣습니다.
      setSelected((current) => current.map((item) => {
        if (item.content) return item;
        const found = rows.find((row) => row.id === item.id);
        return found?.content ? { ...item, content: found.content } : item;
      }));
      // 추천이 0건인 것은 검색어 문제가 아닙니다. AI가 후보 30건을 훑고도 이
      // 상담에 쓸 것이 없다고 판단한 것이라, 억지로 채우지 않은 결과입니다.
      // (상담 내용이 아직 안 적힌 상담에서 실제로 이렇게 나옵니다.)
      setReferenceMessage(rows.length
        ? ragTab.countMessage(rows.length)
        : kind === '추천' ? ragTab.emptyRecommend : ragTab.emptySearch);
    } catch (error) {
      if (!isCurrent()) return;
      setRagResults([]);
      setReferenceMessage(friendlyErrorMessage(error, ragTab.errorMessage));
    } finally {
      if (isCurrent()) setRagLoading(false);
    }
  };

  // 추천은 '지금 고른 상담'에 딸린 결과라, 상담을 바꾸면 곧바로 다시 받아와야
  // 합니다. 예전에는 탭 핸들러에서만 불러서, 상담을 바꿔도 앞 상담의 조문이
  // 그대로 남아 있다가 탭을 왔다 갔다 해야 갱신됐습니다 — 화면에는 새 상담이
  // 떠 있는데 목록은 남의 사건이라 알아채기도 어렵습니다.
  //
  // 호출 지점을 여기 하나로 모읍니다. 상담·자료종류·모드 중 무엇이 바뀌든 조건이
  // 맞으면 다시 부르고, 아니면 남은 결과를 지웁니다.
  const latestRequest = useRef(0);
  useEffect(() => {
    if (!isRagTab) {
      setRagResults([]);
      return;
    }
    // 직접 검색 모드에서는 상담원이 넣은 검색어가 기준이라 상담을 바꿔도
    // 결과를 건드리지 않습니다. 지우면 방금 찾아둔 조문이 사라집니다.
    if (mode !== '추천') return;
    if (!selectedCase?.analysis?.summary) {
      setRagResults([]);
      setReferenceMessage('이 상담은 아직 분석 전입니다 · 실시간 분석을 먼저 실행해 주세요');
      return;
    }
    // 상담을 빠르게 넘기면 앞선 요청이 뒤늦게 도착해 새 상담 화면에 옛 결과를
    // 덮어쓸 수 있습니다. 가장 마지막 요청만 반영합니다.
    const ticket = ++latestRequest.current;
    runRagQuery('추천', () => ticket === latestRequest.current);
    // runRagQuery는 매 렌더마다 새로 만들어지므로 의존성에 넣지 않습니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, referenceType, mode]);

  // 이 상담에 이미 저장해 둔 자료를 담은 목록에 되살립니다. 저장했는데 화면을
  // 다시 열면 비어 있으면, 상담원은 저장이 안 된 줄 알고 다시 고르게 됩니다.
  useEffect(() => {
    const adopted = selectedCase?.analysis?.recommendation?.adopted;
    setSelected(Array.isArray(adopted)
      ? adopted.map((item) => ({
        id: item.id,
        title: item.title,
        source: item.source || '',
        effectiveDate: item.date || '',
        reason: item.reason || '',
        content: item.content || '',
        referenceType: item.type || 'statute',
        referenceLabel: referenceTypeLabel(item.type),
        selectedBy: item.selected_by || 'manual',
      }))
      : []);
    // 상담이 바뀔 때만 되살립니다. selected를 의존성에 넣으면 고르는 즉시 되돌아갑니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  const runAiReferenceSearch = () => {
    if (isRagTab) {
      runRagQuery('추천');
      return;
    }
    setSearched(true);
    setReferenceMessage('추천 후보 표시 · 유사 상담사례는 아직 예시 목록입니다');
  };
  // 담은 자료에는 어느 탭에서 왔는지를 함께 남깁니다. 나중에 서식 작성 화면이
  // 법령과 판례를 구분해 쓸 수 있어야 하고, 저장된 뒤에는 화면 상태가 없어서
  // 항목만 보고는 구분할 방법이 없습니다.
  const adoptReference = (item) => {
    const tagged = { ...item, referenceType, referenceLabel: label };
    setSelected((current) => (current.some((value) => value.id === item.id)
      ? current.filter((value) => value.id !== item.id)   // 다시 누르면 뺍니다
      : [...current, tagged]));
  };

  // 담은 자료를 분석 행(recommendation_json)에 저장합니다. 여기 저장해야 화면을
  // 나가거나 다른 PC에서 열어도 남습니다 — 예전에는 이 화면 상태에만 있어서
  // 탭만 바꿔도 사라졌습니다.
  //
  // selected_by를 같이 남깁니다. AI가 골라준 것을 그대로 채택했는지, 상담원이
  // 직접 검색해 찾은 것인지가 HITL 근거로 남아야 하기 때문입니다.
  const saveSelected = async () => {
    if (!selectedCase) return;
    if (!onAnalysisSaved) {
      setReferenceMessage('저장 경로가 연결되지 않았습니다 · 관리자에게 알려주세요');
      return;
    }
    setSaving(true);
    try {
      const adopted = selected.map((item) => ({
        type: item.referenceType || 'statute',
        id: item.id,
        title: item.title,
        source: item.source || '',
        date: item.effectiveDate || '',
        reason: item.reason || '',
        // 본문도 같이 저장합니다. 제목과 근거만 남기면 나중에 '담은 자료'에서
        // 조문·판시사항을 다시 읽을 수 없고, 읽으려면 검색 화면으로 돌아가
        // 같은 것을 다시 찾아야 합니다. 상담 한 건에 담는 양이 많아야 열 건
        // 안팎이라 저장 크기는 문제되지 않습니다.
        content: item.content || '',
        selected_by: item.selectedBy || 'manual',
      }));
      const analysis = {
        ...selectedCase.analysis,
        recommendation: { ...(selectedCase.analysis?.recommendation || {}), adopted },
      };
      const result = await onAnalysisSaved(selectedCase, analysis);
      if (result?.ok) {
        setReferenceMessage(result.synced === false
          ? `${adopted.length}건 담음 · 이 브라우저에만 저장됐습니다`
          : `${adopted.length}건을 이 상담에 저장했습니다`);
        onNotify?.({ title: '검토 자료 저장', body: `${selectedCase.name || '상담'} · 법령·판례 ${adopted.length}건` });
      } else {
        setReferenceMessage(result?.message || '저장하지 못했습니다');
      }
    } catch (error) {
      setReferenceMessage(friendlyErrorMessage(error, '저장하지 못했습니다'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="workspacePage">
      <section className="workflowPanel searchPanel">
        {/* 세 번째 탭 '유사 상담사례'는 법령·판례가 아닌데도 제목·설명이 법령·판례만
            가리켜, 이 탭이 여기 왜 있는지 헷갈릴 수 있습니다(코치 피드백). 설명 문구에
            유사 사례도 포함되어 있음을 밝힙니다. */}
        <WorkPageHeader
          title="법령·판례"
          description="사건에 맞는 법령·판례와 유사 상담사례를 찾아 검토 자료에 반영하세요."
        />
        <div className="inlineControls">
          <CasePicker
            consultations={consultations}
            value={caseId}
            onChange={(nextCaseId) => {
              setCaseId(nextCaseId);
              // 상담이 바뀌면 담은 자료도 그 상담 것으로 갈아끼웁니다.
              // (아래 useEffect가 저장된 값을 다시 불러옵니다.)
              setSelected([]);
              setReferenceMessage('');
            }}
          />
        </div>
        {selectedCase ? (
          <div className="referenceCaseSummary">
            <span><small>사건 유형</small><strong>{selectedCase.analysis?.caseType || selectedCase.type || '미분류'}</strong></span>
            <span><small>긴급도</small><strong>{selectedCase.analysis?.urgency || '미확인'}</strong></span>
            <span><small>구조대상</small><strong>{selectedCase.analysis?.eligibility || '검토 필요'}</strong></span>
          </div>
        ) : null}
        {/* 시안: 자료 종류(판례/법령/유사 상담사례)는 왼쪽, 추천/직접 검색 전환은 같은 줄 오른쪽. */}
        <div className="referenceToolbar">
          <div className="segmented referenceTypeTabs">
            {[
              { key: 'precedent', label: '판례' },
              { key: 'statute', label: '법령' },
              { key: 'similar', label: '유사 상담사례' },
            ].map((item) => (
              <button
                className={referenceType === item.key ? 'active' : ''}
                type="button"
                key={item.key}
                onClick={() => {
                  setReferenceType(item.key);
                  // 담은 자료는 지우지 않습니다. 법령과 판례를 함께 골라
                  // 한 번에 저장해야 하는데, 탭을 옮길 때 비우면 그게 불가능합니다.
                  setSearched(mode === '추천');
                  setRagResults([]);
                  setReferenceMessage('');
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="segmented referenceModeTabs">
            {['추천', '직접 검색'].map((item) => <button className={mode === item ? 'active' : ''} type="button" key={item} onClick={() => { setMode(item); setSearched(item === '추천'); setRagResults([]); setReferenceMessage(''); }}>{item}</button>)}
          </div>
        </div>
        {mode === '직접 검색' ? (
          <div className="referenceSearchBox">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`${label} 검색어`} aria-label={`${label} 검색어`} />
            <button type="button" disabled={ragLoading}
              onClick={() => (isRagTab ? runRagQuery('직접 검색') : setSearched(true))}>
              {ragLoading ? '검색 중…' : '검색'}
            </button>
          </div>
        ) : null}
        <div className="referenceActionBar">
          <div>
            <strong>{mode === '추천' ? '상담 분석 기반 추천' : '직접 검색 결과 검토'}</strong>
            {/* 법령과 판례를 나눠 셉니다. 탭을 옮겨가며 담기 때문에, 지금 보고
                있지 않은 탭에서 몇 건을 담았는지가 합계로만 보이면 알 수 없습니다. */}
            <span>{selected.length
              ? Object.entries(selected.reduce((acc, item) => {
                const key = item.referenceLabel || '자료';
                return { ...acc, [key]: (acc[key] || 0) + 1 };
              }, {})).map(([key, n]) => `${key} ${n}건`).join(' · ')
              : '검토에 쓸 후보 선택'}</span>
          </div>
          <div className="referenceActionButtons">
            {/* '추천' 모드에서는 사건을 고르는 순간 results가 이미 자동으로 채워져 있어
                (위 results 계산 참고), 이 버튼을 눌러도 화면이 바뀌지 않는 빈 동작이었습니다
                (코치 피드백). 직접 검색 모드에서만 다시 불러오는 의미가 있으므로 그때만 보여줍니다. */}
            {mode === '직접 검색' ? (
              <button className="secondaryActionButton compactAction" type="button" onClick={runAiReferenceSearch}>AI 추천 실행</button>
            ) : null}
            <button
              className="primaryButton compactAction"
              type="button"
              onClick={saveSelected}
              disabled={!selected.length || saving}
            >
              {saving ? '저장 중…' : '이 상담에 저장'}
            </button>
          </div>
        </div>
        {referenceMessage ? <p className="apiPendingMessage" role="status">{referenceMessage}</p> : null}
        <div className="workflowColumns">
          <div>
            <h3><BookOpen size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> {label} 목록</h3>
            <div className="referenceList">
              {results.length ? results.map((item) => {
                const isSelected = selectedIds.includes(item.id);
                // 예전에는 카드 전체가 button이라 안에 '전문 보기'를 넣을 수 없었습니다
                // (button 안의 button은 유효하지 않은 마크업입니다). 조문은 항이 여러 개라
                // 접힌 상태로는 요건을 확인할 수 없으므로, 카드를 div로 바꾸고 '선택'과
                // '전문 보기'를 각각 버튼으로 둡니다.
                return (
                  <div className={isSelected ? 'referenceCard selected' : 'referenceCard'} key={item.id}>
                    <span className="referenceCardTitle"><Gavel size={13} strokeWidth={2.2} aria-hidden="true" /> {item.title}</span>
                    {/* 조문 본문을 함께 보여줍니다. 제목만으로는 이 조문이 사건에 맞는지
                        판단할 수 없어, 상담원이 결국 법령정보센터를 따로 열어야 합니다. */}
                    {item.content ? (
                      <span className="referenceCardBody">{item.content}</span>
                    ) : null}
                    {isRagTab ? (
                      <button className="referenceCardToggle" type="button"
                        onClick={() => setFullTextItem(item)}
                      >
                        {ragTab?.bodyToggleLabel || '원문 보기'}
                      </button>
                    ) : null}
                    <span className="referenceCardMeta">
                      {item.source}
                      {item.effectiveDate
                        ? ` · ${ragTab?.dateLabel || '시행'} ${formatLegalDate(item.effectiveDate)}`
                        : ''}
                      {/* 유사도 %는 일부러 감춥니다. 상담원은 90%를 '90% 확신'으로 읽는데,
                          실제로는 색인 2,258개가 78.7~90.6%의 12%p 안에 뭉쳐 있고 아무
                          상관 없는 조문도 78.7%를 받습니다. 순위를 정하는 것도 이제
                          유사도가 아니라 AI 선별이라, 숫자를 같이 띄우면 순서와 거꾸로
                          보이기까지 합니다. 응답에는 남겨두어 디버깅에는 씁니다. */}
                      {item.similarityPercent == null && item.caseType ? ` · ${item.caseType}` : ''}
                    </span>
                    {item.reason ? <span className="referenceCardReason">{item.reason}</span> : null}
                    <button className={`statusChip referenceCardPick ${isSelected ? 'tone-success' : 'tone-muted'}`}
                      type="button" onClick={() => adoptReference(item)}
                    >
                      {isSelected ? <CheckCircle2 size={12} strokeWidth={2.4} aria-hidden="true" /> : null} {isSelected ? '선택됨' : '선택'}
                    </button>
                  </div>
                );
              }) : ragLoading ? <ReferenceSkeleton /> : <InlineEmptyNotice>조건 일치 {label} 없음</InlineEmptyNotice>}
            </div>
          </div>
          <div>
            <h3><ClipboardList size={16} strokeWidth={2.2} className="sectionIcon" aria-hidden="true" /> 검토에 반영할 자료</h3>
            {/* 담은 자료는 '읽는 것'이 아니라 '무엇을 담았는지 확인하는 것'이라,
                검색 결과 카드와 같은 크기로 그리면 한 건만 담아도 칸이 꽉 차
                몇 건을 담았는지 한눈에 안 들어옵니다. 한 줄짜리로 쌓습니다. */}
            <div className="referenceSelectedPanel compactList">
              {selected.length ? selected.map((item) => (
                <button type="button" key={item.id}
                  title={`${item.title} · 누르면 뺍니다`}
                  onClick={() => setSelected(selected.filter((value) => value.id !== item.id))}
                >
                  <span>{item.referenceLabel ? `[${item.referenceLabel}] ` : ''}{item.title}</span>
                  <strong aria-label="빼기">×</strong>
                </button>
              )) : <InlineEmptyNotice>선택된 자료가 없습니다.</InlineEmptyNotice>}
            </div>
          </div>
        </div>
      </section>
      {fullTextItem ? (
        <FullTextModal
          item={fullTextItem}
          referenceType={referenceType}
          onClose={() => setFullTextItem(null)}
        />
      ) : null}
    </main>
  );
}
