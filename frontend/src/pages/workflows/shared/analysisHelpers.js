import { today } from '../../../constants.jsx';
import { triggerCoreAnalysis, isCoreConnectionError, mapCoreAnalysisResponse } from '../../../services/coreApiClientV2.js';
import { computeCaseEmergency, resolveEligibilityFromCase, emergencyReason, levelFromRatio } from './caseHelpers.js';
import { summarizeAttachmentModalities, buildAttachmentLinkMetadata, attachmentLinkValues, buildExtractionDetail } from './attachmentHelpers.js';

// core-api 연결 자체가 안 되면(서버 꺼짐 등) 로컬 목업 결과로 자연스럽게 대체해,
// 데모/개발 도중에도 화면이 끊기지 않도록 합니다.
//
// 다만 "분석이 실패했다"는 목업으로 덮지 않고 그대로 올립니다. 예전에는 모든 실패를
// 목업으로 바꿔서, AI 분석이 실패해도 화면에는 그럴듯한 결과가 떴습니다. 상담원은 그걸
// 실제 분석 결과로 믿고 저장하게 됩니다.
async function fetchAnalysisWithFallback(selectedCase, options = {}) {
  const localFallback = buildAnalysisResult(selectedCase);
  try {
    const coreResult = await triggerCoreAnalysis(selectedCase, options);
    // 백엔드가 아직 채워주지 않는 항목(모달리티 요약, 파일별 추출 상태, STT 마스킹 미리보기 등)은
    // 로컬 목업 값을 그대로 이어서 쓰고, 실제 응답이 담긴 핵심 분석 필드만 덮어씁니다.
    return mergeContractAnalysisResponse(localFallback, coreResult);
  } catch (error) {
    if (isCoreConnectionError(error)) return localFallback;
    throw error;
  }
}

// 화면에서 가려 보여줄 내용이 아직 없을 때의 문구.
//
// 상수로 빼 둔 이유: 이 문구가 곧 "브라우저 안에는 가림본이 없다"는 신호이기 때문입니다.
// 전화·수기 상담은 자동 STT가 없어 memoMasked가 늘 비고, 대면도 새로고침하면 비웁니다
// (가림본을 DB에 저장하지 않기로 해서 되살릴 곳이 없습니다). 그때 분석 화면이 서버에
// 다시 물어보도록(AnalysisWorkbench) 이 값과 비교해서 판단합니다.
export const MASKED_STT_EMPTY_TEXT = '가릴 개인정보가 확인된 상담 내용이 아직 없습니다.';

// 분석 실행을 화면 밖(App)에서 돌릴 수 있게 떼어낸 입구입니다.
//
// 분석은 40~70초 걸립니다. 이걸 AnalysisWorkbench 안에서 await하면 상담원이 다른 메뉴로
// 옮기는 순간 컴포넌트가 언마운트되면서 기다리던 것도 같이 사라집니다. 서버(analysis_job)는
// 계속 돌지만 결과를 받을 주체가 없어 그대로 버려집니다.
//
// App이 이 함수를 호출하면 화면을 옮겨 다녀도 끝까지 진행되고, 끝났을 때 알림을 띄울 수
// 있습니다. 화면에 그릴 analysis와 상담에 반영할 patch를 함께 돌려줍니다.
export async function runConsultationAnalysis(consultation, options = {}) {
  const analysis = await fetchAnalysisWithFallback(consultation, options);

  // 분석 결과 자체를 상담에 실어 보관합니다 — 화면 상태에만 두면 페이지를 옮길 때 사라집니다.
  // 서버 저장과는 무관합니다: ai_analysis 행은 상담원이 "분석 내용 저장"을 눌러야 생깁니다.
  //
  // pendingServerSave는 '화면에는 있지만 아직 서버에 저장 안 된 분석'이라는 표시입니다.
  // 이게 없으면 App의 서버 동기화(hydrateConsultationsWithCoreAnalyses)가 예전에 저장해 둔
  // 분석을 이 상담에 다시 실어주고, 그 순간 방금 받은 결과가 옛 값으로 되돌아갑니다 —
  // 재분석을 눌러도 구조대상·체크리스트·누락자료가 그대로였던 것이 이것입니다.
  const patch = { analysis: { ...analysis, pendingServerSave: true } };
  if (analysis.analysisId && analysis.analysisId !== consultation.coreAnalysisId) {
    patch.coreAnalysisId = analysis.analysisId;
  }

  // 통화에서 확인된 상담자 이름을 AI가 채웁니다. 전화를 받자마자 상담이 만들어지므로
  // 시작 시점에는 이름을 모르고, 분석이 끝나야 알 수 있습니다.
  //
  // 상담원이 직접 입력·수정한 이름은 덮어쓰지 않습니다. Whisper가 '이도영'을 '이도형'으로
  // 듣는 일이 있는데, 사람이 확인해 고쳐둔 값을 기계가 되돌리면 안 됩니다.
  const aiName = pickClientName(analysis);
  if (aiName && !consultation.name && consultation.nameSource !== 'counselor') {
    patch.name = aiName;
    patch.nameSource = 'ai';
  }
  return { analysis, patch };
}

// 저장된 분석(core-api 응답)을 화면이 쓸 수 있는 모양으로 되살립니다.
//
// 분석을 방금 돌린 경로(fetchAnalysisWithFallback)와 같은 병합을 거치게 해서, 새로고침 후
// 복원한 분석도 같은 모양이 되게 합니다. 이 병합을 건너뛰면 화면이 그리는 값 중 계약에 없는
// 것들(modalities, extractionDetail, sttPreview, verification)이 undefined로 남아
// `analysis.modalities.map(...)`에서 터집니다.
//
// buildAnalysisResult는 이 파일 내부 구현이라 밖으로 내보내지 않고, 복원용 입구만 엽니다.
export function hydrateAnalysisForDisplay(contractResult, consultation) {
  return mergeContractAnalysisResponse(buildAnalysisResult(consultation || {}), contractResult);
}

export function mergeContractAnalysisResponse(baseAnalysis, contractResult, extra = {}) {
  const mapped = mapCoreAnalysisResponse(contractResult);
  // 긴급도 등급과 점수를 항상 짝이 맞게 재구성합니다.
  // - 백엔드가 사건별 점수(case_emergency_ratio)를 주면 그 값을 기준으로 등급을 정합니다(실제 AI).
  // - 점수 없이 등급만 오면(계약 mock은 등급이 고정이라 사건 구분이 안 됨) buildAnalysisResult가
  //   상담 내용으로 계산한 사건별 등급·점수를 그대로 신뢰합니다.
  const backendRatio = typeof mapped.emergencyRatio === 'number' ? mapped.emergencyRatio : null;
  const level = backendRatio != null ? levelFromRatio(backendRatio) : (baseAnalysis.urgency || '하');
  const ratio = backendRatio != null ? backendRatio : (baseAnalysis.emergency?.ratio ?? 0.15);
  return {
    ...baseAnalysis,
    ...mapped,
    urgency: level,
    emergency: { level, ratio, reason: emergencyReason(level) },
    ...extra,
    extractedJson: {
      ...(baseAnalysis.extractedJson || {}),
      ...(mapped.extractedJson || {}),
      // ai-api의 구조화 분석 결과(당사자/금액/날짜/사건개요)를 최상위로 올립니다.
      // 이게 없으면 extracted_json에 사건분류와 STT 원문만 남아서, 서식 초안을
      // 만들 때 LLM이 요약문에서 이름을 눈치로 뽑아 쓰게 됩니다 — 실제로 유언에
      // 반대하는 형이 유언자 자리에 들어간 적이 있습니다. 분석 층은 그 형을
      // '상대방(형)', 피상속인은 '미상'으로 정확히 구분해 주는데, 그 값이 여기서
      // 버려지고 있었습니다. pickClientName()도 이 당사자 목록을 읽습니다.
      ...(contractResult?.consult_extracted || {}),
      aiAnalysisResponse: contractResult,
      ...(extra.extractedJson || {}),
    },
  };
}

// 코치 피드백: "줄글이 아닌 개요 형식의 짧게 요약". AI 요약이 문장 여러 개로 이어진 줄글로
// 오더라도, 문장 단위(마침표·줄바꿈)로 쪼개 개요(bullet) 목록으로 보여줍니다.
export function splitSummaryIntoBullets(summaryText = '') {
  // 문장으로 끊어 쓴 요약은 마침표 기준으로, "사건 유형: 이혼 / 긴급도: 중"처럼 슬래시로
  // 항목을 나열한 요약(core-api 응답 형식)은 슬래시 기준으로 쪼갭니다.
  //
  // 예전에는 '다'와 '요' 뒤에서도 끊었습니다("~했다", "~예요" 같은 한국어 종결어미를 잡으려던
  // 의도). 그런데 문장 끝인지를 안 보고 글자만 봐서, 문장 한가운데가 잘렸습니다:
  //   "남편이 남긴 채무가 재산보다 / 약 2억 원 더 많아..."   <- '재산보다'의 '다'
  // '~보다', '~하다가', '~한다면', '~하고요' 전부 같은 일이 납니다. 종결어미는 거의 항상
  // 마침표를 달고 오므로 문장부호만 기준으로 삼습니다. 마침표 없이 쓴 요약은 안 쪼개지고
  // 한 줄로 남는데, 문장이 잘리는 것보다는 낫습니다.
  return summaryText
    .split(/(?<=[.!?])\s+|\n+|\s+\/\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}
export function normalizeMissingInfoItems(items = []) {
  return items.map((item) => {
    if (typeof item === 'string') return item;
    if (item?.item) return item.item;
    if (item?.name) return item.name;
    if (item?.reason) return item.reason;
    return String(item);
  }).filter(Boolean);
}

export function markAiLinkedSection(analysis, sectionKey) {
  return {
    ...analysis,
    aiLinked: {
      ...(analysis.aiLinked || {}),
      [sectionKey]: {
        updatedAt: new Date().toISOString(),
      },
    },
  };
}
export function buildAiResultSummary(kind, result) {
  if (!result) return null;
  if (kind === 'eligibility') {
    return {
      title: '무료 법률구조 대상 확인 결과',
      description: '무료 법률구조 대상, 증빙 제출 여부, 긴급도 등급을 상담 내용에 반영했습니다.',
      metrics: [
        { label: '무료 법률구조 대상', value: result.eligibility || '검토 필요' },
        { label: '증빙 제출', value: result.eligibilityCheck?.evidenceSubmitted ? '제출 완료' : '미제출' },
        { label: '긴급도 등급', value: result.urgency ? `${result.urgency} (${Math.round((result.emergency?.ratio || 0) * 100)}%)` : '미확인' },
      ],
      items: [
        `무료 법률구조 대상: ${result.eligibility || '검토 필요'}`,
        `증빙서류: ${result.eligibilityCheck?.evidenceSubmitted ? '제출 확인됨' : `미제출${result.eligibilityCheck?.requiredEvidence ? ` (${result.eligibilityCheck.requiredEvidence})` : ''}`}`,
        `긴급도 근거: ${result.emergency?.reason || '근거 없음'}`,
      ],
    };
  }
  return {
    title: '누락자료 점검 결과',
    description: '보완이 필요한 자료를 찾아 아래 누락 자료 목록에 추가했습니다.',
    metrics: [
      { label: '누락자료', value: `${result.missingInfo?.length || 0}건` },
      { label: '제출 완료', value: `${Object.values(result.evidenceStatus || {}).filter((value) => value === 'submitted').length}건` },
      { label: '체크리스트', value: `${result.checklist?.filter((item) => item.checked).length || 0}/${result.checklist?.length || 0}` },
    ],
    items: (result.missingInfo || []).slice(0, 6).map((item) => `보완 필요: ${item}`),
  };
}
// 백엔드가 없을 때 상담 데이터만으로 '더 받아야 할 자료' 후보를 만듭니다.
export function localMissingDataSuggestions(selectedCase) {
  const attachments = selectedCase?.attachments || [];
  const eligibilityCheck = selectedCase?.eligibilityCheck;
  const hasAudio = attachments.some((item) => /transcript|녹취|audio/i.test(item.category || item.name || ''));
  return [
    ...(eligibilityCheck?.isTargetCandidate && !eligibilityCheck?.evidenceSubmitted ? [`${eligibilityCheck.requiredEvidence || '대상자 증빙서류'}`] : []),
    ...(hasAudio ? [] : ['상담 녹취록']),
    '상대방 연락처·주소',
    '관련 계약서 또는 거래 증빙',
    '기존 소송·조정 이력',
  ];
}
// 분석 결과에서 '상담을 받으러 온 사람'의 이름을 고릅니다.
//
// extracted_json.당사자는 [{역할, 이름}] 목록이고 상대방·피상속인까지 함께 들어 있어서,
// 아무거나 집으면 상대방 이름이 상담자 자리에 들어갑니다. 역할을 보고 골라야 합니다.
// '미상'처럼 확인 못 했다는 표시는 이름이 아니므로 거릅니다 — 그걸 채우면 화면에
// "상담받은 사람: 미상"이 뜨고, 서식에도 그대로 실려 나갑니다.
const CLIENT_ROLE_ORDER = ['청구인', '신청인', '내담자', '원고', '상속인'];
const UNKNOWN_NAME_MARKS = ['미상', '불명', '확인불가', '확인 불가', '알 수 없음', '없음'];

export function pickClientName(analysis) {
  const parties = analysis?.extractedJson?.당사자;
  if (!Array.isArray(parties) || !parties.length) return '';

  const usable = parties.filter((party) => {
    const name = (party?.이름 || '').trim();
    if (!name) return false;
    return !UNKNOWN_NAME_MARKS.some((mark) => name.includes(mark));
  });
  if (!usable.length) return '';

  for (const role of CLIENT_ROLE_ORDER) {
    const matched = usable.find((party) => (party?.역할 || '').includes(role));
    if (matched) return matched.이름.trim();
  }
  // 역할명이 예상 밖이면(예: '신고인') 첫 당사자를 씁니다. 상담자가 먼저 언급되는 게 보통입니다.
  return usable[0].이름.trim();
}

export function buildAnalysisResult(selectedCase) {
  // 전화상담(memo)과 대면상담(inpersonMemo)은 화면에서는 분리해서 보여주지만, 분석 대상 텍스트는
  // 상담원이 어느 채널로 들었든 상담 내용 전체를 반영해야 하므로 여기서 합칩니다
  // (App.jsx notifyAnalysisSaved가 실제 저장 시 core-api에 보내는 값과 같은 방식).
  const text = [selectedCase?.memo, selectedCase?.inpersonMemo]
    .filter((value) => value && value.trim())
    .join('\n\n') || selectedCase?.title || '';
  const attachments = selectedCase?.attachments || [];
  const attachmentLinks = buildAttachmentLinkMetadata(attachments);
  const submittedFileLinks = attachmentLinkValues(attachments);
  const modalities = summarizeAttachmentModalities(attachments);
  const hasMultimodalEvidence = modalities.some((item) => item.count > 0);
  const audioAttachments = attachments.filter((item) => /mp3|wav|m4a|webm/i.test(item.mimeType || item.name || ''));
  // 실시간 상담(전화 memo / 대면 inpersonMemo)도 STT 결과다. 첨부 녹취파일만 보면 마이크로만
  // 진행한 상담은 "개인정보가 가려진 상담 내용" 카드가 통째로 비어, 화면이 약속한 원문/가림
  // 대조를 보여줄 수 없다 — 정작 그 카드가 가장 필요한 경우가 실시간 상담이다.
  //
  // 마스킹본은 stt-mask-api가 조각마다 돌려준 값을 InPersonAnalysisPanel이 쌓아둔 것이라
  // 상담원 화면(녹음 패널)과 같은 값이다. 두 화면이 서로 다른 방식으로 가리면 조합해서
  // 원본을 복원할 수 있다는 지적(formatters.js의 규제 TODO)도 이렇게 같은 값을 쓰면 없어진다.
  const liveOriginal = [selectedCase?.memo, selectedCase?.inpersonMemo]
    .filter((value) => value && value.trim()).join('\n\n');
  const liveMasked = [selectedCase?.memoMasked, selectedCase?.inpersonMemoMasked]
    .filter((value) => value && value.trim()).join('\n\n');
  const sttOriginal = [
    ...audioAttachments.map((item) => item.sttOriginalText || item.extractedText),
    liveOriginal,
  ].filter(Boolean).join('\n\n');
  // 마스킹본이 아직 없을 때(전화 상담은 자동 STT가 없어 memoMasked가 비어 있다) 원문을
  // 그대로 올리지 않는다 — 가려졌다고 적힌 자리에 원문이 나가면 안 된다.
  const sttMasked = [
    ...audioAttachments.map((item) => item.sttMaskedText || item.extractedText),
    liveMasked,
  ].filter(Boolean).join('\n\n');
  // 긴급도 등급/점수/근거와 구조대상 판정은 '구조대상 판정' 버튼과 같은 규칙(공용 함수)으로 산출합니다.
  const emergency = computeCaseEmergency(selectedCase);
  const { eligibilityCheck, isTargetCandidate, evidenceSubmitted, eligibility } = resolveEligibilityFromCase(selectedCase);
  const missingInfo = [
    ...(!attachments.length ? ['증빙자료'] : []),
    ...(isTargetCandidate && !evidenceSubmitted ? [`${eligibilityCheck?.requiredEvidence || '대상자 증빙서류'}`] : []),
    '상대방 인적사항',
    '계약/거래 일자',
  ];
  return {
    summary: text
      ? `${selectedCase.title} 상담 내용${hasMultimodalEvidence ? '과 첨부자료(녹취/이미지/문서)' : ''}을 기준으로 사건 유형, 필요자료, 구조검토 항목을 정리했습니다.`
      : '상담 내용 부족 · 요약 불가',
    caseType: selectedCase?.type || '미분류',
    // 백본 CaseTypeResult.reason (분류 근거, 참고용 표현)
    caseTypeReason: text ? `상담 요약과 첨부자료 내용을 종합할 때 '${selectedCase?.type || '해당 유형'}'으로 보임 (참고용 분류).` : '분류 근거를 산출할 상담 내용이 부족합니다.',
    urgency: emergency.level,
    // 백본 EmergencyResult (case_emergency_level / case_emergency_ratio / reason)
    emergency,
    eligibility,
    eligibilityCheck,
    missingInfo,
    // 누락 자료 각 항목의 제출 상태. 기본은 '미제출'이고, 상담원이 받으면 '제출'로 바꿉니다.
    evidenceStatus: Object.fromEntries(missingInfo.map((item) => [item, 'missing'])),
    checklist: [
      { label: '법률구조 대상 여부 확인', checked: Boolean(eligibilityCheck) },
      { label: '법률구조 대상자 증빙서류 제출 여부 확인', checked: !isTargetCandidate || evidenceSubmitted },
      { label: '승소 가능성 기초자료 확인', checked: false },
      { label: '추가자료 요청 필요 여부 확인', checked: false },
    ],
    timeline: [
      { date: today, text: '상담 접수 및 인공지능 분석 후보 생성' },
    ],
    modalities,
    sourceAttachments: attachmentLinks,
    extractedJson: {
      attachment_links: attachmentLinks,
      submitted_file_link: submittedFileLinks,
    },
    // 파일별 STT/문서추출 처리 상태 (노트북에서 UI 연동 권장한 extracted_content_detail)
    extractionDetail: buildExtractionDetail(attachments),
    // STT 개인정보 마스킹 미리보기 (원문 → 마스킹본)
    sttPreview: {
      original: sttOriginal || '녹음하거나 녹취 파일을 올리면 상담 내용이 여기에 표시됩니다.',
      masked: sttMasked || MASKED_STT_EMPTY_TEXT,
    },
    verification: {
      // AI 응답 검증(형식/근거/환각 탐지, 요구사항 AI-07 시리즈)을 화면에서 확인할 수 있도록 만든 mock 검증 결과입니다.
      format: true,
      grounded: attachments.length > 0,
      hallucinationRisk: !text,
    },
  };
}
