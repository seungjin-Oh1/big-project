import React, { useEffect, useState } from 'react';
import { ShieldCheck, ClipboardList, ChevronDown, ChevronRight, Search, Check, FileAudio2, Mic, PhoneCall, Radio } from 'lucide-react';
import { today } from '../constants.jsx';
import { createAttachmentMetadata, generateDraftText, recommendTemplates, searchReferenceCandidates, validateAnalysisResult } from '../services/legalAidApi.js';
import { appendAuditLog, getFavoriteTemplates, readStorage, storageKeys, toggleFavoriteTemplate, writeStorage } from '../services/storage.js';
import { generateAiDraft } from '../services/aiApiClient.js';
import {
  approveCoreDocument,
  buildCoreDocumentDownloadUrl,
  createCoreAnalysis,
  createCoreConsultation,
  fetchCoreDocuments,
  generateCoreDraft,
  recommendCoreForms,
  requestCoreDocumentRevision,
  submitCoreAnalysisForReview,
  submitCoreDocumentForReview,
  triggerCoreAnalysis,
  mapCoreAnalysisResponse,
} from '../services/coreApiClientV2.js';
import { saveLocalDocumentReviewRequest } from '../services/documentReviewStore.js';
import { hydrateDraftDocument, rememberDraftDocumentSnapshot } from '../services/draftDocumentStore.js';
import { isHwpxTemplateAlias, resolveHwpxTemplateName } from '../services/formTemplateResolver.js';
import { createClientHwpxDraft } from '../services/clientHwpxGenerator.js';
import { uploadFileToS3, S3UploadUnavailableError } from '../services/s3UploadClient.js';
import { caseCategories, isKnownCaseType, legalTemplateSeed } from '../data/domain.js';
import { HitlConfirmModal } from '../components/common.jsx';
import { useAsyncAction } from '../components/loading.jsx';
import { useConfirm, useToast } from '../components/feedback.jsx';

// core-api(/api/consultations/{id}/analyze) 호출이 실패(서버 꺼짐 등)하면 로컬 목업 결과로
// 자연스럽게 대체해, 데모/개발 도중에도 화면이 끊기지 않도록 합니다.
async function fetchAnalysisWithFallback(selectedCase) {
  const localFallback = buildAnalysisResult(selectedCase);
  try {
    const coreResult = await triggerCoreAnalysis(selectedCase);
    // 백엔드가 아직 채워주지 않는 항목(모달리티 요약, 파일별 추출 상태, STT 마스킹 미리보기 등)은
    // 로컬 목업 값을 그대로 이어서 쓰고, 실제 응답이 담긴 핵심 분석 필드만 덮어씁니다.
    return mergeContractAnalysisResponse(localFallback, coreResult);
  } catch {
    return localFallback;
  }
}

function mergeContractAnalysisResponse(baseAnalysis, contractResult, extra = {}) {
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
      aiAnalysisResponse: contractResult,
      ...(extra.extractedJson || {}),
    },
  };
}

function normalizeMissingInfoItems(items = []) {
  return items.map((item) => {
    if (typeof item === 'string') return item;
    if (item?.item) return item.item;
    if (item?.name) return item.name;
    if (item?.reason) return item.reason;
    return String(item);
  }).filter(Boolean);
}

function markAiLinkedSection(analysis, sectionKey) {
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

// 긴급도 등급별 점수 대역. 같은 등급 안에서도 사건마다 다른 값이 나오도록 '고정값'이 아니라 '구간'으로 둡니다.
const URGENCY_BAND = { 상: [0.66, 0.97], 중: [0.36, 0.65], 하: [0.05, 0.35] };

// 긴급 신호 키워드. 상담 내용에 있을수록 점수가 올라갑니다.
// (백엔드 ai-api의 긴급도 판단 기준 프롬프트와 같은 맥락: 생명·신체 위험, 시효·집행 임박 등)
const HIGH_URGENCY_SIGNALS = ['강제집행', '소멸시효', '시효', '임박', '즉시', '당장', '폭행', '협박', '생명', '위독', '위험', '구속', '체포', '경매', '압류', '가압류', '퇴거', '명도', '자살', '실종'];
const MID_URGENCY_SIGNALS = ['소송', '기일', '재판', '조정', '최고', '내용증명', '합의', '미지급', '체불', '연체', '독촉', '이혼', '양육비', '상속', '기한'];

// 긴급도 등급 → 근거 문장. 등급 하나에서만 나오게 해 등급과 근거가 어긋나지 않게 합니다.
function emergencyReason(level) {
  return level === '상'
    ? '즉시 대응이 필요한 정황(기한 임박·금전 피해 등)으로 보입니다.'
    : level === '중'
      ? '수일~수주 내 대응이 필요한 사안으로 보입니다.'
      : '특별한 시한 압박은 낮은 것으로 보입니다.';
}

// 0~1 점수를 등급으로 변환.
function levelFromRatio(ratio) {
  return ratio >= URGENCY_BAND.상[0] ? '상' : ratio >= URGENCY_BAND.중[0] ? '중' : '하';
}

// 점수가 등급 대역을 벗어나면 그 대역 안으로 보정합니다. (백엔드가 등급만 줄 때 등급-점수 일관성 유지)
function fitRatioToLevel(ratio, level) {
  const band = URGENCY_BAND[level] || URGENCY_BAND.하;
  return Number(Math.min(band[1], Math.max(band[0], ratio)).toFixed(2));
}

// 긴급도(등급/점수/근거)를 상담 내용과 첨부자료의 여러 신호를 종합해 계산합니다.
// 등급별 고정 점수가 아니라, 신호를 가중합한 연속 점수를 내고 그 점수로 등급을 정합니다.
// → 같은 '상'이라도 사건마다 점수가 다르고, 사건 내용이 다르면 등급도 갈립니다.
// (백엔드 AI가 case_emergency_ratio를 주면 그 값을 우선 쓰고, 이 로컬 계산은 백엔드가 없을 때만 씁니다.)
function computeCaseEmergency(selectedCase) {
  const text = `${selectedCase?.title || ''} ${selectedCase?.memo || ''}`;
  const attachments = selectedCase?.attachments || [];
  const hasMultimodalEvidence = summarizeAttachmentModalities(attachments).some((item) => item.count > 0);

  let score = 0.12; // 단순 문의 수준의 기본선
  HIGH_URGENCY_SIGNALS.forEach((keyword) => { if (text.includes(keyword)) score += 0.17; });
  MID_URGENCY_SIGNALS.forEach((keyword) => { if (text.includes(keyword)) score += 0.08; });
  // 금액 규모: 자릿수가 클수록(만원→억) 가중
  const amounts = text.match(/\d[\d,]{2,}/g);
  if (amounts) {
    const maxDigits = Math.max(...amounts.map((value) => value.replace(/\D/g, '').length));
    score += Math.min(0.2, maxDigits * 0.03);
  }
  // 근거 자료가 많을수록 사안이 구체적이라고 보고 미세 가중
  if (hasMultimodalEvidence) score += 0.08;
  score += Math.min(0.1, attachments.length * 0.03);
  score += Math.min(0.06, (selectedCase?.memo || '').length / 2000);

  // 같은 키워드 조합이라도 사건마다 점수가 똑같이 겹쳐 보이지 않도록 사건 식별자 기반의 작은 흔들림을 더합니다.
  // caseNo/id로 만든 결정론적 값이라 새로고침해도 점수가 바뀌지 않습니다.
  const seed = String(selectedCase?.caseNo || selectedCase?.id || text).split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  score += ((seed % 7) - 3) * 0.01; // -0.03 ~ +0.03

  const ratio = Number(Math.max(0.05, Math.min(0.97, score)).toFixed(2));
  const level = levelFromRatio(ratio);
  return { level, ratio, reason: emergencyReason(level) };
}

// 상담 등록 단계에서 확인한 대상 유형·증빙 제출 여부로 구조대상 여부를 판정합니다.
// 대상 후보이면서 증빙까지 제출됐으면 '구조 가능', 대상 후보인데 증빙 미제출이면 '검토 필요',
// 애초에 대상 후보가 아니면 '부적합'으로 봅니다.
function resolveEligibilityFromCase(selectedCase, fallbackCheck) {
  const eligibilityCheck = selectedCase?.eligibilityCheck || fallbackCheck || null;
  const isTargetCandidate = Boolean(eligibilityCheck?.isTargetCandidate);
  const evidenceSubmitted = Boolean(eligibilityCheck?.evidenceSubmitted);
  const eligibility = isTargetCandidate ? (evidenceSubmitted ? '구조 가능' : '검토 필요') : '부적합';
  return { eligibilityCheck, isTargetCandidate, evidenceSubmitted, eligibility };
}

function buildAiResultSummary(kind, result) {
  if (!result) return null;
  if (kind === 'eligibility') {
    return {
      title: '구조대상 판정 결과',
      description: '구조대상 여부, 증빙 제출 여부, 긴급도 등급을 상담 내용에 반영했습니다.',
      metrics: [
        { label: '구조대상 여부', value: result.eligibility || '검토 필요' },
        { label: '증빙 제출', value: result.eligibilityCheck?.evidenceSubmitted ? '제출 완료' : '미제출' },
        { label: '긴급도 등급', value: result.urgency ? `${result.urgency} (${Math.round((result.emergency?.ratio || 0) * 100)}%)` : '미확인' },
      ],
      items: [
        `구조대상 판정: ${result.eligibility || '검토 필요'}`,
        `증빙서류: ${result.eligibilityCheck?.evidenceSubmitted ? '제출 확인됨' : `미제출${result.eligibilityCheck?.requiredEvidence ? ` (${result.eligibilityCheck.requiredEvidence})` : ''}`}`,
        `긴급도 근거: ${result.emergency?.reason || '산출된 근거가 없습니다.'}`,
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

async function requestEligibilityCandidate(selectedCase, analysis) {
  // 상담 등록 데이터를 근거로 대상여부·증빙·긴급도를 확정 계산합니다.
  // (백엔드 mock이 이 값들을 채워주지 않아도 버튼 한 번으로 실제 반영되도록 로컬 계산을 기본값으로 씁니다)
  const emergency = computeCaseEmergency(selectedCase);
  const { eligibilityCheck, isTargetCandidate, evidenceSubmitted, eligibility } = resolveEligibilityFromCase(selectedCase, analysis.eligibilityCheck);

  let mapped = {};
  let response = null;
  try {
    // /consult/analyze는 단일화된 파이프라인이라 부분 출력만 요청하는 개념이 없음 — 항상 전체를 반환받음.
    response = await triggerCoreAnalysis(selectedCase);
    mapped = mapCoreAnalysisResponse(response);
  } catch {
    // 백엔드가 꺼져 있으면 위에서 계산한 로컬 값만으로 진행합니다.
  }

  // 긴급도: 백엔드가 사건별 점수(case_emergency_ratio)를 주면 그 값을 최우선으로 씁니다.
  // 점수는 없고 등급만 오면, 사건별 로컬 점수를 그 등급 대역 안으로 보정해 등급-점수를 일관되게 맞춥니다.
  const backendRatio = typeof mapped.emergencyRatio === 'number' ? mapped.emergencyRatio : null;
  const urgency = backendRatio != null ? levelFromRatio(backendRatio) : (mapped.urgency || emergency.level);
  const urgencyRatio = backendRatio != null ? backendRatio : fitRatioToLevel(emergency.ratio, urgency);
  // 대상/증빙 관련 체크리스트 항목은 방금 확정한 값에 맞춰 자동으로 채웁니다.
  const baseChecklist = mapped.checklist?.length ? mapped.checklist : analysis.checklist;
  const checklist = baseChecklist.map((item) => {
    if (item.label.includes('대상 여부')) return { ...item, checked: Boolean(eligibilityCheck) };
    if (item.label.includes('증빙')) return { ...item, checked: !isTargetCandidate || evidenceSubmitted };
    return item;
  });

  return markAiLinkedSection({
    ...analysis,
    eligibility,
    eligibilityCheck,
    urgency,
    emergency: { level: urgency, ratio: urgencyRatio, reason: emergencyReason(urgency) },
    checklist,
    missingInfo: Array.from(new Set([...(analysis.missingInfo || []), ...normalizeMissingInfoItems(mapped.missingInfo || [])])),
    extractedJson: {
      ...(analysis.extractedJson || {}),
      aiEligibilityResponse: response,
    },
  }, 'eligibility');
}

// 백엔드가 없을 때 상담 데이터만으로 '더 받아야 할 자료' 후보를 만듭니다.
function localMissingDataSuggestions(selectedCase) {
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

async function requestMissingDataCandidate(selectedCase, analysis) {
  let mapped = {};
  let response = null;
  try {
    response = await triggerCoreAnalysis(selectedCase);
    mapped = mapCoreAnalysisResponse(response);
  } catch {
    // 백엔드가 꺼져 있으면 아래 로컬 제안 목록을 씁니다.
  }

  const suggested = normalizeMissingInfoItems(mapped.missingInfo || []);
  const additions = suggested.length ? suggested : localMissingDataSuggestions(selectedCase);
  const missingInfo = Array.from(new Set([...(analysis.missingInfo || []), ...additions]));
  // 새로 추가된 항목만 '미제출'로 초기화하고, 이미 상담원이 표시한 제출 상태는 그대로 둡니다.
  const evidenceStatus = { ...(analysis.evidenceStatus || {}) };
  missingInfo.forEach((item) => { if (!evidenceStatus[item]) evidenceStatus[item] = 'missing'; });

  // '구조대상 판정' 버튼은 체크리스트 중 '대상 여부'·'증빙' 항목을 자동으로 채웁니다(requestEligibilityCandidate).
  // 이 버튼(누락자료 점검)은 나머지 항목(승소 가능성/집행 가능성/구조 타당성/추가자료 요청 필요 여부 등
  // 대상·증빙과 무관한 모든 항목)을 점검 완료로 체크해, 두 버튼이 각각 자신이 맡은 체크리스트 항목만
  // 자동으로 채우도록 역할을 나눕니다.
  const baseChecklist = mapped.checklist?.length ? mapped.checklist : analysis.checklist;
  const checklist = baseChecklist.map((item) => (
    item.label.includes('대상 여부') || item.label.includes('증빙') ? item : { ...item, checked: true }
  ));

  return markAiLinkedSection({
    ...analysis,
    missingInfo,
    evidenceStatus,
    checklist,
    extractedJson: {
      ...(analysis.extractedJson || {}),
      aiMissingDataResponse: response,
    },
  }, 'missing');
}

function caseOptions(consultations) {
  return consultations.length ? consultations : [{ id: 'empty', caseNo: '상담 선택', title: '등록된 상담이 없습니다.' }];
}

// 서식 추천(legalTemplateSeed)과 법령·판례 검색은 소분류(caseSubtype) 단위로 데이터가 연결돼 있습니다.
// (legalTemplateSeed의 caseType 필드가 실제로는 '가사소송일반' 같은 소분류 값입니다.)
// AI 분석은 대분류(caseType)와 소분류(caseSubtype)를 따로 주므로, 소분류가 있으면 그걸 우선 쓰고
// 없거나 이 시스템이 모르는 값이면 대분류로, 그마저 없으면 상담 등록 때 고른 유형으로 내려갑니다.
function resolveConfirmedCaseType(selectedCase) {
  const analysis = selectedCase?.analysis;
  if (isKnownCaseType(analysis?.caseSubtype)) return analysis.caseSubtype;
  if (isKnownCaseType(analysis?.caseType)) return analysis.caseType;
  return selectedCase?.type;
}

function casePickerFields(item) {
  return [
    item.caseNo,
    item.name,
    item.title,
    item.type,
    item.subtype,
    item.date,
    item.registeredTime,
  ].filter(Boolean);
}

function matchesCasePickerQuery(item, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return casePickerFields(item).some((field) => String(field).toLowerCase().includes(normalizedQuery));
}

function casePickerDateLabel(item) {
  if (!item?.date) return '등록일시 미기록';
  return `${item.date}${item.registeredTime ? ` ${item.registeredTime}` : ''}`;
}

function CasePicker({ consultations, value, onChange, placeholder = '사건을 선택하세요' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const options = caseOptions(consultations);
  const selected = options.find((item) => String(item.id) === String(value)) || options[0];
  const filteredOptions = options.filter((item) => matchesCasePickerQuery(item, query));
  const hasSelectableCase = selected && selected.id !== 'empty';

  const selectCase = (item) => {
    if (item.id === 'empty') return;
    onChange(item.id);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="casePicker">
      <button
        className="casePickerButton"
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span className="casePickerButtonText">
          <strong>{hasSelectableCase ? selected.caseNo : placeholder}</strong>
          <span>{hasSelectableCase ? `${selected.name || '상담자 미지정'} · ${selected.title || '상담 제목 미입력'}` : selected?.title || '등록된 상담이 없습니다.'}</span>
          {hasSelectableCase ? <small>{casePickerDateLabel(selected)}</small> : null}
        </span>
        <ChevronDown size={18} aria-hidden="true" />
      </button>
      {open ? (
        <div className="casePickerPopover">
          <label className="casePickerSearch">
            <Search size={15} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="사건번호, 이름, 제목 검색"
            />
          </label>
          <div className="casePickerList">
            {filteredOptions.length ? filteredOptions.map((item) => (
              <button
                className={String(item.id) === String(value) ? 'casePickerItem active' : 'casePickerItem'}
                type="button"
                key={item.id}
                disabled={item.id === 'empty'}
                onClick={() => selectCase(item)}
              >
                <span>
                  <strong>{item.caseNo || '사건번호 없음'}</strong>
                  <small>{item.name || '상담자 미지정'} · {item.title || '상담 제목 미입력'}</small>
                </span>
                <em>{item.id === 'empty' ? '없음' : casePickerDateLabel(item)}</em>
              </button>
            )) : (
              <p className="casePickerEmpty">검색 결과가 없습니다.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function normalizeChoiceOptions(options) {
  return options.map((option) => (typeof option === 'string' ? { value: option, label: option } : option));
}

function matchesChoiceQuery(option, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [option.label, option.description].filter(Boolean).some((field) => String(field).toLowerCase().includes(normalizedQuery));
}

function ChoicePicker({ options, value, onChange, placeholder = '선택하세요', disabled = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const normalizedOptions = normalizeChoiceOptions(options);
  const selected = normalizedOptions.find((option) => String(option.value) === String(value));
  const filteredOptions = normalizedOptions.filter((option) => matchesChoiceQuery(option, query));

  const selectOption = (option) => {
    onChange(option.value);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="choicePicker">
      <button
        className="choicePickerButton"
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span className="choicePickerText">
          <strong>{selected?.label || placeholder}</strong>
          {selected?.description ? <small>{selected.description}</small> : null}
        </span>
        <ChevronDown size={18} aria-hidden="true" />
      </button>
      {open && !disabled ? (
        <div className="choicePickerPopover">
          <label className="choicePickerSearch">
            <Search size={15} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="항목 검색"
            />
          </label>
          <div className="choicePickerList">
            {filteredOptions.length ? filteredOptions.map((option) => (
              <button
                className={String(option.value) === String(value) ? 'choicePickerItem active' : 'choicePickerItem'}
                type="button"
                key={option.value}
                onClick={() => selectOption(option)}
              >
                <strong>{option.label}</strong>
                {option.description ? <small>{option.description}</small> : null}
              </button>
            )) : (
              <p className="choicePickerEmpty">검색 결과가 없습니다.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const legalAidApplicantTypes = [
  { key: 'none', label: '해당 없음', evidence: '대상자 증빙 없음' },
  { key: 'basicLivelihood', label: '기초생활수급자', evidence: '수급자 증명서' },
  { key: 'nearPoverty', label: '차상위계층', evidence: '차상위계층 확인서' },
  { key: 'disabled', label: '장애인', evidence: '장애인증명서 또는 복지카드' },
  { key: 'nationalMerit', label: '국가유공자', evidence: '국가유공자 확인서' },
  { key: 'crimeVictim', label: '범죄피해자', evidence: '피해사실 확인자료' },
  { key: 'domesticViolence', label: '가정폭력·성폭력 피해자', evidence: '상담확인서 또는 피해확인자료' },
  { key: 'wageArrears', label: '임금등 체불 피해근로자', evidence: '체불임금 확인자료' },
  { key: 'courtRescue', label: '법원의 소송구조 결정자', evidence: '소송구조 결정문' },
  { key: 'other', label: '기타 법률구조 대상자', evidence: '대상자 확인자료' },
];

// AI 백본 extracted_content_detail의 status 값을 사람이 읽을 수 있는 라벨로 변환합니다.
function extractionStatusLabel(status) {
  const labels = { success: '추출 성공', empty: '내용 없음', unsupported: '미지원', failed: '처리 실패' };
  return labels[status] || status;
}

function getEligibilityBadgeText(isApplicant, evidenceSubmitted) {
  if (!isApplicant) return '대상 아님';
  if (!evidenceSubmitted) return '증빙 필요';
  return '대상 확인';
}

function getEligibilityHelperText(isApplicant, evidenceSubmitted) {
  if (!isApplicant) return '법률구조 대상 유형에 해당하지 않는 것으로 표시됩니다.';
  if (!evidenceSubmitted) return '법률구조 대상자에 해당할 수 있으나 증빙서류가 아직 제출되지 않았습니다.';
  return '법률구조 대상자로 확인되었고 증빙서류 제출도 완료되었습니다.';
}

// 업로드 상태 문자열을 상태 칩 색 톤으로 매핑합니다.
function uploadStatusTone(status) {
  if (status === 'S3 업로드 완료') return 'tone-success';
  if (status === '업로드 실패') return 'tone-danger';
  if (status === '업로드 중') return 'tone-info';
  return 'tone-warn'; // 로컬 보관 (S3 대기) 등
}

// 오른쪽 2단계 카드는 예전엔 왼쪽 문단이 말로 설명하는 내용을 그림으로 다시 보여주기만 해서
// 있으나 마나 했습니다. 지금은 '지금 여기' 표시뿐 아니라, 지금 있지 않은 단계를 눌러 바로
// 넘어갈 수 있는 작은 스텝 네비게이션으로 씁니다(상단 메뉴까지 갈 필요 없이 화면 안에서 전환).
function CounselorFlowStage({ current = 'upload', onNavigate }) {
  const stages = [
    {
      key: 'upload',
      icon: FileAudio2,
      title: '상담 문서 업로드',
      detail: '문서, 녹취, 이미지 정리',
    },
    {
      key: 'realtime',
      icon: Radio,
      title: '실시간 분석 AI',
      detail: '통화, STT, 분석 보조',
    },
  ];

  return (
    <section className="flowStageBanner" aria-label="상담원 업무 단계">
      <div className="flowStageCopy">
        <span className="flowStageEyebrow">상담원 업무 흐름</span>
        <strong>{current === 'upload' ? '상담 접수 자료를 먼저 정리합니다.' : '통화와 STT를 보며 실시간 분석을 진행합니다.'}</strong>
        <p>
          {current === 'upload'
            ? '상담 문서 업로드 화면에서 사건 정보와 첨부자료를 정리한 뒤, 다음 단계에서 실시간 텍스트와 AI 분석 보조를 이어서 확인합니다.'
            : '전화를 받으면서 바로 진행할 때는 아래 ‘새 실시간 상담 바로 시작’으로 곧장 시작하세요. 이름·상담 내용 같은 세부 정보는 통화 중이나 통화 후에 채우면 됩니다.'}
        </p>
      </div>
      <div className="flowStageSteps">
        {stages.map((stage, index) => {
          const Icon = stage.icon;
          const active = current === stage.key;
          const canNavigate = !active && Boolean(onNavigate);
          return (
            <article
              className={active ? 'flowStageStep active' : canNavigate ? 'flowStageStep linkable' : 'flowStageStep'}
              key={stage.key}
              {...(canNavigate ? {
                role: 'button',
                tabIndex: 0,
                onClick: onNavigate,
                onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onNavigate(); } },
              } : {})}
            >
              <span className="flowStageIndex">{index + 1}</span>
              <div className="flowStageText">
                <strong><Icon size={15} strokeWidth={2.2} /> {stage.title}</strong>
                <small>{stage.detail}</small>
              </div>
              {active ? <em className="flowStageHereBadge">현재 화면</em> : null}
              {canNavigate ? <ChevronRight className="flowStageGo" size={16} strokeWidth={2.4} aria-hidden="true" /> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function UploadWorkbench({ onCreateConsultation, onGoToRealtimeAnalysis }) {
  const showToast = useToast();
  const confirm = useConfirm();
  const emptyUploadForm = { name: '', category: caseCategories[0].key, type: caseCategories[0].subTypes[0], title: '', memo: '', legalAidType: 'none', eligibilityEvidenceSubmitted: false };
  const savedDraft = readStorage(storageKeys.uploadDraft, null);
  const [form, setForm] = useState(savedDraft?.form || emptyUploadForm);
  const [files, setFiles] = useState(savedDraft?.files || []);
  const [message, setMessage] = useState('');
  // 면담 내용 외에 녹취(mp3 등), 이미지, 문서를 함께 받아 AI가 멀티모달로 분석할 수 있도록 업로드 종류를 구분합니다.
  const uploadTypes = [
    { key: 'transcript', label: '녹취록', accept: '.mp3,.wav,.m4a,.txt,.pdf' },
    { key: 'idCard', label: '신분증', accept: '.jpg,.jpeg,.png,.pdf' },
    { key: 'evidence', label: '증빙자료', accept: '.jpg,.jpeg,.png,.pdf,.hwpx,.doc,.docx' },
  ];
  const activeCategory = caseCategories.find((category) => category.key === form.category) || caseCategories[0];
  const selectedApplicantType = legalAidApplicantTypes.find((item) => item.key === form.legalAidType) || legalAidApplicantTypes[0];
  const isLegalAidApplicant = form.legalAidType !== 'none';
  const eligibilityBadgeText = getEligibilityBadgeText(isLegalAidApplicant, form.eligibilityEvidenceSubmitted);
  const eligibilityHelperText = getEligibilityHelperText(isLegalAidApplicant, form.eligibilityEvidenceSubmitted);
  const saveDraft = () => {
    writeStorage(storageKeys.uploadDraft, { form, files, savedAt: new Date().toISOString() });
    setMessage('임시저장되었습니다. 상담 등록 전까지 이 화면에서 다시 불러올 수 있습니다.');
  };
  const clearDraft = () => {
    writeStorage(storageKeys.uploadDraft, null);
    setForm(emptyUploadForm);
    setFiles([]);
    setMessage('임시저장 내용을 비웠습니다.');
  };
  // 파일을 고르면 브라우저에서 곧장 S3로 올립니다(파일 바이트는 백엔드를 거치지 않음).
  // 백엔드에 presigned 업로드 엔드포인트가 아직 없으면 로컬에 임시 보관하고 개발을 계속할 수 있게 폴백합니다.
  const addFiles = async (label, selectedFiles) => {
    const staged = Array.from(selectedFiles).map((file) => createAttachmentMetadata(file, label));
    if (!staged.length) return;
    // 먼저 '업로드 중'으로 즉시 목록에 표시해 사용자가 진행 상황을 알 수 있게 합니다.
    setFiles((items) => [...items, ...staged.map((meta) => ({ ...meta, status: '업로드 중' }))]);
    setMessage(`${label} 파일 ${staged.length}개를 S3에 업로드하고 있습니다…`);

    const patchFile = (id, changes) => setFiles((items) => items.map((item) => item.id === id ? { ...item, ...changes } : item));
    let fellBackToLocal = false;
    for (const meta of staged) {
      try {
        const { fileKey, fileUrl } = await uploadFileToS3(meta.file, label);
        patchFile(meta.id, { fileKey, uploadedUrl: fileUrl, status: 'S3 업로드 완료' });
      } catch (error) {
        if (error instanceof S3UploadUnavailableError) {
          // 백엔드 미지원 → 로컬 임시 보관. 상담 등록 자체는 그대로 가능합니다.
          fellBackToLocal = true;
          patchFile(meta.id, { status: '로컬 보관 (S3 대기)' });
        } else {
          // CORS 등 실제 업로드 실패는 사용자에게 알립니다.
          patchFile(meta.id, { status: '업로드 실패' });
          showToast(`${meta.name} 업로드 실패: ${error.message}`, 'warn');
        }
      }
    }
    setMessage(fellBackToLocal
      ? `${label} 파일을 추가했습니다. (S3 직접 업로드 준비 전이라 로컬에 임시 보관합니다)`
      : `${label} 파일 ${staged.length}개를 업로드했습니다.`);
  };
  const submit = async () => {
    if (!form.name || !form.title) {
      setMessage('상담자 이름과 상담 제목을 입력해주세요.');
      return;
    }
    const accepted = await confirm({
      title: '상담을 등록할까요?',
      message: `${form.name}님 상담 「${form.title}」을 등록합니다. 상담 내용, 사건 유형, 법률구조 대상 여부와 증빙 제출 상태를 다시 확인해주세요.`,
      confirmLabel: '등록',
      cancelLabel: '다시 확인',
      tone: 'info',
    });
    if (!accepted) return;
    const result = await onCreateConsultation({
      ...form,
      status: '진행 중',
      eligibilityCheck: {
        applicantType: selectedApplicantType.label,
        requiredEvidence: selectedApplicantType.evidence,
        isTargetCandidate: isLegalAidApplicant,
        evidenceSubmitted: isLegalAidApplicant ? form.eligibilityEvidenceSubmitted : false,
      },
      // 파일 바이트가 아니라 'S3에 올린 위치(fileKey)'와 열람 URL만 백엔드로 보냅니다.
      attachments: files.map(({ category, name, size, mimeType, storageBucket, fileKey, uploadedUrl, extractedText }) => ({ category, name, size, mimeType, storageBucket, fileKey, uploadedUrl, extractedText })),
    });
    setMessage('');
    writeStorage(storageKeys.uploadDraft, null);
    setForm(emptyUploadForm);
    setFiles([]);
    // 등록되면 화면이 대시보드로 넘어갑니다. 넘어간 화면에서도 결과가 보이도록
    // OS 확인창 대신 앱 안에서 잠깐 떠 있는 알림으로 알려, 등록 여부를 헷갈려 중복 클릭하는 일을 막습니다.
    // Core API 동기화까지 됐는지에 따라 성공/주의 색을 다르게 씁니다.
    showToast(result?.message || '상담이 등록되었습니다.', result?.coreSynced === false ? 'warn' : 'success');
  };

  return (
    <main className="workspacePage">
      <section className="workflowPanel uploadPanel">
        <h2>상담 문서 업로드</h2>
        <CounselorFlowStage current="upload" onNavigate={onGoToRealtimeAnalysis ? () => onGoToRealtimeAnalysis() : undefined} />
        <div className="formGrid">
          <label className="field"><span>상담자 이름</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="이름 입력" /></label>
          <label className="field"><span>상담 제목</span><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="상담 제목 입력" /></label>
          <label className="field">
            <span>사건 대분류</span>
            <ChoicePicker
              value={form.category}
              options={caseCategories.map((category) => ({
                value: category.key,
                label: category.key,
              }))}
              onChange={(nextValue) => {
                const nextCategory = caseCategories.find((category) => category.key === nextValue) || caseCategories[0];
                setForm({ ...form, category: nextCategory.key, type: nextCategory.subTypes[0] });
              }}
              placeholder="사건 대분류 선택"
            />
          </label>
          <label className="field">
            <span>사건 소분류</span>
            <ChoicePicker
              value={form.type}
              options={activeCategory.subTypes.map((type) => ({
                value: type,
                label: type,
              }))}
              onChange={(nextValue) => setForm({ ...form, type: nextValue })}
              placeholder="사건 소분류 선택"
            />
          </label>
        </div>
        <label className="field"><span>상담 내용 입력</span><textarea value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="상담 내용을 입력하세요." /></label>
        <section className="eligibilityPanel">
          <div className="eligibilityHeader">
            <div>
              <h3>법률구조 대상자 확인</h3>
              <p>민원인이 해당하는 대상 유형과 증빙서류 제출 여부를 상담 접수 단계에서 확인합니다.</p>
            </div>
            <span className={isLegalAidApplicant ? 'eligibilityBadge active' : 'eligibilityBadge'}>{eligibilityBadgeText}</span>
          </div>
          <div className="formGrid">
            <label className="field">
              <span>대상자 유형</span>
              <select
                className="eligibilitySelect highlighted"
                value={form.legalAidType}
                onChange={(event) => setForm({ ...form, legalAidType: event.target.value, eligibilityEvidenceSubmitted: false })}
              >
                {legalAidApplicantTypes.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </label>
            <div className="evidenceBox">
              <span>필요 증빙서류</span>
              <strong>{selectedApplicantType.evidence}</strong>
              <label>
                <input
                  type="checkbox"
                  checked={form.eligibilityEvidenceSubmitted}
                  disabled={!isLegalAidApplicant}
                  onChange={(event) => setForm({ ...form, eligibilityEvidenceSubmitted: event.target.checked })}
                />
                증빙서류 제출 확인
                {isLegalAidApplicant ? (
                  <em className={form.eligibilityEvidenceSubmitted ? 'evidenceStatus submitted' : 'evidenceStatus missing'}>
                    {form.eligibilityEvidenceSubmitted ? '제출 확인' : '미제출'}
                  </em>
                ) : null}
              </label>
            </div>
          </div>
          <p className={isLegalAidApplicant && !form.eligibilityEvidenceSubmitted ? 'eligibilityWarning' : 'helperText'}>
            {eligibilityHelperText}
          </p>
        </section>
        <div className="workflowColumns">
          <div>
            <h3>파일 업로드 (멀티모달 분석 대상)</h3>
            <p className="helperText">면담 내용 외에 녹취(mp3 등), 이미지(png/jpg), 문서(pdf/hwpx) 등 첨부자료를 함께 올리면 AI가 함께 분석합니다.</p>
            {uploadTypes.map((item) => (
              <label className="fileButton" key={item.key}>
                {item.label} 추가
                <input
                  type="file"
                  accept={item.accept}
                  multiple={item.key !== 'idCard'}
                  onChange={(event) => {
                    addFiles(item.label, event.target.files);
                    event.target.value = '';
                  }}
                />
              </label>
            ))}
          </div>
          <div>
            <h3>업로드 목록</h3>
            <div className="scrollBox">
              {files.length ? files.map((file) => (
                <button type="button" className="uploadItem" key={file.id} onClick={() => setFiles(files.filter((item) => item.id !== file.id))}>
                  <span className="uploadItemName">[{file.category}] {file.name} ({Math.ceil(file.size / 1024)}KB)</span>
                  <span className={`uploadItemStatus ${uploadStatusTone(file.status)}`}>{file.status || '대기'}</span>
                  <span className="uploadItemRemove">삭제</span>
                </button>
              )) : <p>업로드된 파일이 없습니다.</p>}
            </div>
          </div>
        </div>
        <div className="uploadActionRow">
          <div className="uploadSecondaryActions">
            <button type="button" onClick={saveDraft}>임시저장</button>
            <button type="button" onClick={clearDraft}>임시저장 비우기</button>
          </div>
          <button className="primaryButton uploadSubmitButton" type="button" onClick={submit} disabled={!form.name || !form.title}>상담 등록</button>
        </div>
        {message ? <p className="helperText">{message}</p> : null}
      </section>
    </main>
  );
}

// 멀티모달 분석: 면담 텍스트뿐 아니라 녹취(mp3 등)·이미지·문서 첨부자료까지 함께 고려해서
// 사건 유형/긴급도 후보를 산출한다는 것을 화면에서 확인할 수 있도록 구성했습니다.
function summarizeAttachmentModalities(attachments = []) {
  const audio = attachments.filter((item) => /mp3|wav|m4a/i.test(item.mimeType || item.name || ''));
  const image = attachments.filter((item) => /png|jpe?g/i.test(item.mimeType || item.name || ''));
  const document = attachments.filter((item) => /pdf|hwpx|doc/i.test(item.mimeType || item.name || ''));
  return [
    { key: '녹취(mp3 등)', count: audio.length },
    { key: '이미지(png/jpg)', count: image.length },
    { key: '문서(pdf/hwpx 등)', count: document.length },
  ];
}

// AI 백본(ai-api) case_analysis 출력의 extracted_content_detail을 화면에 그대로 보여주기 위한 mock 생성기입니다.
// 노트북 기준 파일별 상태: success(추출 성공) / empty(내용없음) / unsupported(레거시 hwp 등 변환 필요) / failed(다운로드·추출 실패)
function buildExtractionDetail(attachments = []) {
  return attachments.map((item) => {
    const name = item.name || '';
    const isHwpx = /\.hwpx$/i.test(name) || /hwpx/i.test(item.mimeType || '');
    const isLegacyHwp = /\.hwp$/i.test(name) || /hwp/i.test(item.mimeType || '') && !isHwpx;
    const isAudio = /mp3|wav|m4a/i.test(item.mimeType || name);
    const status = isLegacyHwp ? 'unsupported' : 'success';
    const fileType = isAudio ? 'audio_video' : isLegacyHwp ? 'legacy_hwp_convert_required' : isHwpx ? 'hwpx_document' : /png|jpe?g/i.test(name) ? 'image' : 'document';
    return {
      fileLink: item.fileKey || item.uploadedUrl || name,
      fileName: name,
      fileType,
      status,
      // 서식 자동 채움은 표/셀 XML 접근이 가능한 hwpx를 기준으로 처리합니다.
      note: isLegacyHwp ? '레거시 hwp 파일입니다. hwpx 변환 후 자동 채움 대상에 포함됩니다.' : isHwpx ? 'HWPX XML 기반 표/필드 추출 가능' : isAudio ? 'Whisper STT 추출' : '문서 텍스트 추출',
    };
  });
}

function buildAttachmentLinkMetadata(attachments = []) {
  return attachments.map((item) => ({
    category: item.category || '',
    fileName: item.name || item.fileName || '',
    fileType: item.mimeType || item.fileType || '',
    storageBucket: item.storageBucket || '',
    fileKey: item.fileKey || '',
    fileUrl: item.uploadedUrl || item.fileUrl || '',
    status: item.status || '',
  })).filter((item) => item.fileName || item.fileKey || item.fileUrl);
}

function attachmentLinkValues(attachments = []) {
  return buildAttachmentLinkMetadata(attachments)
    .map((item) => item.fileKey || item.fileUrl || item.fileName)
    .filter(Boolean);
}

// STT 개인정보 마스킹(한현우 STT Privacy Filter 파트) 미리보기용 mock 마스커.
// 실제 마스킹은 ai-api STT 단계에서 수행되며, 프론트는 원문/마스킹본 토글로 검토자에게 보여줍니다.
function maskSensitiveText(text = '') {
  return text
    .replace(/\d{6}\s*-\s*\d{7}/g, '[RRN]') // 주민등록번호
    .replace(/01[016789]\s*-?\s*\d{3,4}\s*-?\s*\d{4}/g, '[PHONE]') // 휴대전화
    .replace(/\d{2,4}\s*-\s*\d{3,4}\s*-\s*\d{4}/g, '[PHONE]'); // 유선전화
}

function buildAnalysisResult(selectedCase) {
  const text = selectedCase?.memo || selectedCase?.title || '';
  const attachments = selectedCase?.attachments || [];
  const attachmentLinks = buildAttachmentLinkMetadata(attachments);
  const submittedFileLinks = attachmentLinkValues(attachments);
  const modalities = summarizeAttachmentModalities(attachments);
  const hasMultimodalEvidence = modalities.some((item) => item.count > 0);
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
      : '상담 내용이 부족하여 요약을 생성할 수 없습니다.',
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
      original: '안녕하세요, 저는 홍길동이고 주민번호는 850101-2345678입니다. 연락처는 010-1234-5678이에요.',
      masked: maskSensitiveText('안녕하세요, 저는 홍길동이고 주민번호는 850101-2345678입니다. 연락처는 010-1234-5678이에요.'),
    },
    verification: {
      // AI 응답 검증(형식/근거/환각 탐지, 요구사항 AI-07 시리즈)을 화면에서 확인할 수 있도록 만든 mock 검증 결과입니다.
      format: true,
      grounded: attachments.length > 0,
      hallucinationRisk: !text,
    },
  };
}

// 상담원이 실제로 이 화면을 쓸 때 가장 먼저 막히는 지점은 '지금 통화 중인 내용을 어디에 적지?'였습니다.
// 이전 버전은 실시간 텍스트 영역이 화면 동작만 흉내 내는 가짜 재생 데모였고, 실제로 타이핑할 수 있는
// 자리가 이 화면 어디에도 없어서 상담원이 아무것도 기록할 수 없었습니다. 지금은 그 자리를 실제로
// 저장되는 메모 입력창으로 바꿔서, 통화 중 들은 내용을 바로 적고 그 메모가 곧 분석 대상 텍스트가 되도록
// 합니다. 실시간 STT가 연동되면 사람이 타이핑하는 대신 STT가 이 칸을 채워주면 됩니다(같은 자리 재사용).
function RealtimeStatusChips({ hasCase }) {
  return (
    <div className="realtimeStatusChips">
      <span className="statusChip tone-muted"><PhoneCall size={13} strokeWidth={2.4} /> 통화 · 연동 대기</span>
      <span className="statusChip tone-muted"><Mic size={13} strokeWidth={2.4} /> STT · 연동 대기</span>
      <span className={`statusChip ${hasCase ? 'tone-info' : 'tone-muted'}`}><Check size={13} strokeWidth={2.4} /> 메모 · {hasCase ? '입력 가능' : '사건 선택 필요'}</span>
    </div>
  );
}

function RealtimeSessionCard({ selectedCase }) {
  const attachmentCount = selectedCase?.attachments?.length || 0;
  return (
    <article className="realtimeSummaryCard">
      <h3>세션 정보</h3>
      <dl className="realtimeMetricList">
        <div><dt>상담 번호</dt><dd>{selectedCase?.caseNo || '미선택'}</dd></div>
        <div><dt>상담 제목</dt><dd>{selectedCase?.title || '사건을 선택하면 표시됩니다.'}</dd></div>
        <div><dt>첨부자료</dt><dd>{attachmentCount}건</dd></div>
      </dl>
      <p className="realtimeCallNotice">통화·실시간 STT 기능은 개발팀에서 연동 중입니다. 연동 전까지는 오른쪽 메모 칸에 직접 적어가며 상담을 진행하세요.</p>
    </article>
  );
}

// 통화 중 곧바로 타이핑할 수 있는 실제 입력창입니다. 여기 적은 내용이 selectedCase.memo로 저장되고,
// 아래 'AI 분석 결과'가 그대로 이 텍스트를 분석 대상으로 씁니다 — 즉 이 칸을 채우는 것이
// 실시간 분석을 정확하게 만드는 가장 중요한 행동입니다.
function RealtimeMemoCard({ selectedCase, onUpdateConsultation }) {
  const hasCase = Boolean(selectedCase);
  const memo = selectedCase?.memo || '';
  const charCount = memo.trim().length;
  return (
    <article className="realtimeTranscriptCard">
      <div className="realtimeTranscriptHead">
        <h3>실시간 상담 메모</h3>
        <span className={`statusChip ${charCount ? 'tone-info' : 'tone-muted'}`}>{charCount ? `${charCount}자 기록됨` : '작성 전'}</span>
      </div>
      <textarea
        className="realtimeMemoTextarea"
        value={memo}
        disabled={!hasCase}
        onChange={(event) => onUpdateConsultation(selectedCase.id, { memo: event.target.value })}
        placeholder={hasCase
          ? '통화 중 들은 내용을 여기에 바로 적어주세요. 실시간 STT가 연결되면 이 칸이 자동으로 채워집니다.'
          : '사건을 선택하거나 위의 ‘새 실시간 상담 바로 시작’으로 세션을 먼저 만들어주세요.'}
      />
      <p className="helperText">이 메모가 아래 ‘AI 분석 결과’의 분석 대상 텍스트로 그대로 사용됩니다. 통화 중간에도 자유롭게 이어 적을 수 있습니다.</p>
    </article>
  );
}

// 상담원이 통화 중 무엇을 더 물어볼지 놓치지 않도록, 지금까지 적은 메모에서 키워드를 찾아
// 물어보면 좋을 질문을 제안합니다. 클릭해서 '질문함'으로 표시하는 것 외에는 아무 것도 자동으로 하지 않고,
// 실제로 무엇을 물을지는 상담원이 판단합니다(참고용 제안일 뿐, 자동화된 응답이 아닙니다).
const FOLLOWUP_QUESTION_RULES = [
  { keyword: '계약', question: '계약서를 직접 갖고 계신가요? 계약 체결일과 조건을 확인해 주시겠어요?' },
  { keyword: '연락', question: '상대방과 마지막으로 연락한 날짜와 방법을 알려주시겠어요?' },
  { keyword: '금액', question: '정확한 금액과 지급 기한을 확인해 주시겠어요?' },
  { keyword: '폭행', question: '진단서나 상해를 확인할 수 있는 자료가 있으신가요?' },
  { keyword: '이혼', question: '혼인 신고일과 별거를 시작한 시점을 알려주시겠어요?' },
  { keyword: '체불', question: '근로계약서와 임금 명세서를 갖고 계신가요?' },
];

const DEFAULT_FOLLOWUP_QUESTIONS = [
  '사건이 발생한 정확한 날짜를 알려주시겠어요?',
  '상대방의 연락처나 주소를 알고 계신가요?',
  '관련된 증빙 자료(계약서, 문자, 녹취 등)를 갖고 계신가요?',
];

function buildSuggestedQuestions(memoText) {
  const matched = FOLLOWUP_QUESTION_RULES.filter((rule) => memoText.includes(rule.keyword)).map((rule) => rule.question);
  const suggestions = matched.length ? matched : DEFAULT_FOLLOWUP_QUESTIONS;
  return Array.from(new Set(suggestions)).slice(0, 4);
}

function RealtimeSuggestedQuestions({ memoText }) {
  const [askedQuestions, setAskedQuestions] = useState([]);
  const suggestions = buildSuggestedQuestions(memoText);

  const toggleAsked = (question) => {
    setAskedQuestions((current) => current.includes(question) ? current.filter((item) => item !== question) : [...current, question]);
  };

  return (
    <article className="realtimeQuestionsCard">
      <div className="realtimeTranscriptHead">
        <h3>AI 추천 추가 질문</h3>
        <span className="statusChip tone-info">통화 중 참고용</span>
      </div>
      <p className="helperText">지금까지 적은 메모를 바탕으로, 상담자에게 바로 물어보면 좋을 질문을 제안합니다. 실제로 무엇을 물을지는 상담원이 판단해 진행해주세요.</p>
      <div className="realtimeQuestionList">
        {suggestions.map((question) => {
          const asked = askedQuestions.includes(question);
          return (
            <button
              type="button"
              key={question}
              className={asked ? 'realtimeQuestionItem asked' : 'realtimeQuestionItem'}
              onClick={() => toggleAsked(question)}
              aria-pressed={asked}
            >
              <span>{question}</span>
              <em>{asked ? '질문함' : '질문하기'}</em>
            </button>
          );
        })}
      </div>
    </article>
  );
}

function RealtimeAnalysisPanel({ selectedCase, onUpdateConsultation }) {
  const hasCase = Boolean(selectedCase);
  return (
    <section className="realtimeWorkbenchPanel" aria-label="실시간 상담 메모">
      <div className="realtimeWorkbenchHeader">
        <div>
          <span className="flowStageEyebrow">실시간 상담</span>
          <strong>통화 중 들은 내용을 바로 적으면서 진행하세요.</strong>
          <p>통화 기능과 STT는 개발팀에서 연동 중입니다. 연동 전까지는 아래 메모 칸에 직접 기록하면, 그 내용이 곧바로 AI 분석 대상이 됩니다.</p>
        </div>
        <RealtimeStatusChips hasCase={hasCase} />
      </div>
      <div className="realtimeWorkbenchGrid">
        <RealtimeSessionCard selectedCase={selectedCase} />
        <RealtimeMemoCard selectedCase={selectedCase} onUpdateConsultation={onUpdateConsultation} />
      </div>
      {hasCase ? <RealtimeSuggestedQuestions memoText={selectedCase?.memo || ''} /> : null}
    </section>
  );
}

function AnalysisWorkbench({ consultations, onCreateConsultation, onUpdateConsultation, onRequestLegalReview, onAnalysisSaved, currentUser, onGoToDashboard, focusedConsultationId, onGoToUpload }) {
  const [selectedId, setSelectedId] = useState(focusedConsultationId || caseOptions(consultations)[0].id);
  const [analyzed, setAnalyzed] = useState(false);
  const selectedCase = consultations.find((item) => String(item.id) === String(selectedId));
  const [chosen, setChosen] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [timelineText, setTimelineText] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [reviewMessage, setReviewMessage] = useState('');
  const [aiTaskMessage, setAiTaskMessage] = useState('');
  const [aiResultSummary, setAiResultSummary] = useState(null);
  const [analysisSaved, setAnalysisSaved] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isStartingQuickSession, setIsStartingQuickSession] = useState(false);
  const runWithLoading = useAsyncAction();
  const showToast = useToast();
  const [showMaskedStt, setShowMaskedStt] = useState(true);
  const [pendingHitlAction, setPendingHitlAction] = useState(null);
  const activeReviewAction = selectedCase?.reviewAction && !selectedCase.reviewAction.resolved ? selectedCase.reviewAction : null;
  useEffect(() => {
    if (!focusedConsultationId) return;
    const focusedCase = consultations.find((item) => String(item.id) === String(focusedConsultationId));
    setSelectedId(focusedConsultationId);
    setAnalyzed(Boolean(focusedCase?.analysis));
    setAnalysis(focusedCase?.analysis || null);
    setSavedMessage('');
    setReviewMessage('');
    setAnalysisSaved(Boolean(focusedCase?.analysis));
  }, [focusedConsultationId, consultations]);
  // 이 상담을 진행할 때 도움이 될 후속 작업을 AI가 제안합니다.
  // 각 항목이 '무엇을 하는 것인지' 상담원이 바로 알 수 있도록 설명을 함께 둡니다. (요구사항 AI-04·05 계열)
  const suggestions = [
    { label: '유사 상담 기록 검토', description: '과거 비슷한 사건의 상담 이력을 찾아 참고합니다.' },
    { label: '관련 판례 추천', description: '이 사건 유형에 적용되는 판례를 제안합니다.' },
    { label: '법률 요건 정리', description: '청구가 성립하려면 갖춰야 할 법적 요건을 정리합니다.' },
    { label: '인수인계 요약 생성', description: '다른 담당자가 이어받을 수 있도록 사건 핵심을 요약합니다.' },
    { label: '계약서 등 조사자료 요청', description: '사실관계 확인에 필요한 계약서·증빙 문서를 요청합니다.' },
    { label: '계좌이체내역 확인 요청', description: '금전 거래 정황을 뒷받침할 이체 내역을 확인합니다.' },
    { label: '내용증명 발송 이력 확인', description: '상대방에게 보낸 내용증명이 있는지 확인합니다.' },
  ];
  const startAnalysis = async () => {
    if (!selectedCase || isAnalyzing) return;
    setIsAnalyzing(true);
    try {
      await runWithLoading(async () => {
        const nextAnalysis = await fetchAnalysisWithFallback(selectedCase);
        setAnalysis(nextAnalysis);
        setAnalyzed(true);
        setAnalysisSaved(false);
        setSavedMessage('');
        setReviewMessage('');
        setAiTaskMessage('AI 사건 분석 결과를 반영했습니다.');
        setAiResultSummary({
          title: '사건 분석 AI 결과',
          description: 'AI API 응답을 사건 유형, 긴급도, 구조검토 후보에 반영했습니다.',
          metrics: [
            { label: '사건 유형', value: nextAnalysis.caseType || '미분류' },
            { label: '긴급도', value: nextAnalysis.urgency || '미확인' },
            { label: '구조대상', value: nextAnalysis.eligibility || '검토 필요' },
          ],
          items: (nextAnalysis.missingInfo || []).slice(0, 4).map((item) => `확인 필요: ${item}`),
        });
      }, 'AI가 상담 내용을 분석하고 있습니다');
    } finally {
      setIsAnalyzing(false);
    }
  };
  const selectCase = (caseId) => {
    const nextCase = consultations.find((item) => String(item.id) === String(caseId));
    setSelectedId(caseId);
    setAnalyzed(Boolean(nextCase?.analysis));
    setAnalysis(nextCase?.analysis || null);
    setChosen([]);
    setTimelineText('');
    setSavedMessage('');
    setReviewMessage('');
    setAiTaskMessage('');
    setAiResultSummary(null);
    setAnalysisSaved(Boolean(nextCase?.analysis));
  };
  // 132콜센터처럼 전화를 받자마자 바로 이야기를 들으며 진행하는 상담은, 상담 문서 업로드 화면에서
  // 이름·제목을 먼저 채우고 오는 절차를 기다릴 수 없습니다. 최소 정보만으로 사건을 즉시 만들고
  // 이 화면(실시간 분석 AI)에 곧장 이어서, 통화 중·통화 후에 사건 정보를 채워 넣을 수 있게 합니다.
  const buildQuickSessionForm = () => {
    const startedAt = new Date();
    const startedLabel = `${String(startedAt.getHours()).padStart(2, '0')}:${String(startedAt.getMinutes()).padStart(2, '0')}`;
    return {
      name: '',
      title: `실시간 상담 (${startedLabel} 접수)`,
      category: caseCategories[0].key,
      type: caseCategories[0].subTypes[0],
      memo: '',
      legalAidType: 'none',
      eligibilityEvidenceSubmitted: false,
      status: '진행 중',
      eligibilityCheck: { applicantType: '해당 없음', requiredEvidence: '대상자 증빙 없음', isTargetCandidate: false, evidenceSubmitted: false },
      attachments: [],
    };
  };
  const startQuickRealtimeSession = async () => {
    if (isStartingQuickSession || !onCreateConsultation) return;
    setIsStartingQuickSession(true);
    try {
      const result = await onCreateConsultation(buildQuickSessionForm(), { skipNavigation: true });
      if (result?.id == null) {
        showToast('실시간 상담을 시작하지 못했습니다. 다시 시도해주세요.', 'warn');
        return;
      }
      selectCase(result.id);
      showToast('실시간 상담을 시작했습니다. 통화하면서 사건 정보를 채워주세요.', result.coreSynced === false ? 'warn' : 'success');
    } finally {
      setIsStartingQuickSession(false);
    }
  };
  const updateChecklist = (index) => {
    setAnalysis((current) => ({
      ...current,
      checklist: current.checklist.map((item, itemIndex) => itemIndex === index ? { ...item, checked: !item.checked } : item),
    }));
  };
  // 누락 자료 항목의 제출 상태(미제출 ↔ 제출)를 토글합니다.
  // 상담자에게 자료를 받으면 '제출'로 바꿔, 아직 안 받은 자료가 무엇인지 한눈에 남게 합니다.
  const toggleEvidenceStatus = (item) => {
    setAnalysis((current) => {
      const nextStatus = current.evidenceStatus?.[item] === 'submitted' ? 'missing' : 'submitted';
      return { ...current, evidenceStatus: { ...(current.evidenceStatus || {}), [item]: nextStatus } };
    });
  };
  const caseInfoText = selectedCase ? `${selectedCase.caseNo} · ${selectedCase.name || '상담자 미지정'} · ${selectedCase.title}` : '';
  const runEligibilityCheck = async () => {
    if (!selectedCase || !analysis) return;
    setAiTaskMessage('');
    await runWithLoading(async () => {
      try {
        const result = await requestEligibilityCandidate(selectedCase, analysis);
        setAnalysis(result);
        setAnalysisSaved(false);
        setAiTaskMessage('구조대상 판정을 완료했습니다. 대상 여부·증빙 제출·긴급도가 아래에 반영되었습니다.');
        setAiResultSummary(buildAiResultSummary('eligibility', result));
      } catch (error) {
        setAiTaskMessage(error.message);
      }
    }, '구조대상 여부를 확인하고 있습니다');
  };

  const runMissingDataCheck = async () => {
    if (!selectedCase || !analysis) return;
    setAiTaskMessage('');
    await runWithLoading(async () => {
      try {
        const result = await requestMissingDataCandidate(selectedCase, analysis);
        setAnalysis(result);
        setAnalysisSaved(false);
        setAiTaskMessage('누락자료 점검을 완료했습니다. 더 받아야 할 자료를 아래 목록에 추가했습니다.');
        setAiResultSummary(buildAiResultSummary('missing', result));
      } catch (error) {
        setAiTaskMessage(error.message);
      }
    }, '더 받아야 할 자료를 점검하고 있습니다');
  };

  const buildReviewAnalysisPackage = () => {
    const sourceAttachments = analysis?.sourceAttachments?.length
      ? analysis.sourceAttachments
      : buildAttachmentLinkMetadata(selectedCase?.attachments || []);
    const submittedFileLinks = sourceAttachments
      .map((item) => item.fileKey || item.fileUrl || item.fileName)
      .filter(Boolean);

    return {
      ...analysis,
      sourceAttachments,
      extractedJson: {
        ...(analysis?.extractedJson || {}),
        attachment_links: sourceAttachments,
        submitted_file_link: submittedFileLinks,
      },
      adoptedItems: chosen,
      counselorReviewNote: [
        `상담원 저장 분석: ${analysis?.summary || '요약 없음'}`,
        `사건유형 ${analysis?.caseType || '미분류'} · 긴급도 ${analysis?.urgency || '미확인'} · 구조대상 ${analysis?.eligibility || '검토 필요'}`,
        chosen.length ? `검토 반영 항목: ${chosen.join(', ')}` : '검토 반영 항목 없음',
      ].join('\n'),
    };
  };

  const performSaveAnalysis = async () => {
    const reviewAnalysis = buildReviewAnalysisPackage();
    onUpdateConsultation(selectedCase.id, {
      analysis: reviewAnalysis,
      workflowStatus: '상담 검토',
      status: '진행 중',
      reviewAction: selectedCase.reviewAction ? { ...selectedCase.reviewAction, resolved: true, resolvedAt: today } : null,
      logs: [...(selectedCase.logs || []), { status: `인공지능 분석 저장: ${reviewAnalysis.eligibility}`, createdAt: today }],
    });
    let syncMessage = '';
    try {
      const syncResult = await onAnalysisSaved?.(selectedCase, reviewAnalysis);
      syncMessage = syncResult?.message ? ` ${syncResult.message}` : '';
    } catch (error) {
      syncMessage = ` Core API 저장 실패: ${error.message}`;
    }
    setSavedMessage(`저장 완료: 분석 내용이 저장되고 처리 단계에 반영되었습니다.${syncMessage}`);
    setReviewMessage('');
    setAnalysisSaved(true);
    setAnalysis(reviewAnalysis);
    appendAuditLog({
      actor: currentUser?.email || '상담원',
      action: selectedCase.reviewAction ? '상담 분석 수정 저장' : '상담 분석 저장',
      target: selectedCase.caseNo,
      metadata: {
        title: selectedCase.title,
        caseType: reviewAnalysis.caseType,
        urgency: reviewAnalysis.urgency,
        eligibility: reviewAnalysis.eligibility,
        missingInfo: reviewAnalysis.missingInfo?.join(', ') || '',
        adoptedItems: reviewAnalysis.adoptedItems?.join(', ') || '',
        reviewReason: selectedCase.reviewAction?.reason || '',
      },
    });
  };

  const saveAnalysis = () => {
    setSavedMessage('');
    if (!selectedCase || !analysis) return;
    if (!validateAnalysisResult(analysis)) {
      setSavedMessage('저장 실패: 분석 항목이 모두 채워졌는지 확인해주세요.');
      return;
    }
    setPendingHitlAction({ type: 'save' });
  };

  // 분석 결과가 core-api에 저장돼 있으면(coreId+coreAnalysisId) 실제 검토 상태(AnalysisReviewStatus)도
  // SUBMITTED_FOR_REVIEW로 함께 바꿔둡니다. 아직 core-api에 동기화되지 않은 사건(프로토타입 로컬 진행)에서는
  // 이 호출만 조용히 건너뛰고, 기존 로컬 검토 큐(reviews) 등록은 그대로 진행합니다.
  const syncAnalysisReviewToCoreApi = async () => {
    if (!selectedCase.coreId || !selectedCase.coreAnalysisId) return;
    try {
      await submitCoreAnalysisForReview(selectedCase.coreId, selectedCase.coreAnalysisId);
    } catch (error) {
      console.warn('[분석 검토 요청] core-api 동기화 실패, 로컬 검토 큐만 갱신합니다:', error.message);
    }
  };

  const performRequestReview = async () => {
    await syncAnalysisReviewToCoreApi();
    const result = onRequestLegalReview(selectedCase.id, buildReviewAnalysisPackage());
    setReviewMessage(result?.message || '변호사 검토 요청이 등록되었습니다.');
    if (result?.ok && onGoToDashboard) {
      setTimeout(onGoToDashboard, 1000);
    }
  };

  const requestReview = () => {
    setReviewMessage('');
    if (!selectedCase || !analysis || !onRequestLegalReview) return;
    if (!analysisSaved) {
      setReviewMessage('분석 내용을 먼저 저장한 뒤 검토 요청을 진행해주세요.');
      return;
    }
    setPendingHitlAction({ type: 'review' });
  };

  const confirmHitlAction = async () => {
    const actionType = pendingHitlAction?.type;
    setPendingHitlAction(null);
    if (actionType === 'save') await performSaveAnalysis();
    if (actionType === 'review') await performRequestReview();
  };

  return (
    <main className="workspacePage">
      <section className="workflowPanel analysisPanel">
        <h2>실시간 분석 AI</h2>
        <CounselorFlowStage current="realtime" onNavigate={onGoToUpload ? () => onGoToUpload() : undefined} />
        <div className="inlineControls">
          <CasePicker consultations={consultations} value={selectedId} onChange={selectCase} />
          <button type="button" className="quickStartButton" onClick={startQuickRealtimeSession} disabled={isStartingQuickSession}>
            <PhoneCall size={15} strokeWidth={2.4} /> {isStartingQuickSession ? '시작하는 중...' : '새 실시간 상담 바로 시작'}
          </button>
          <button type="button" onClick={startAnalysis} disabled={isAnalyzing || !selectedCase}>
            {isAnalyzing ? (
              '분석 중...'
            ) : analyzed ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={15} strokeWidth={2.6} /> 재분석 실행</span>
            ) : '분석 시작'}
          </button>
        </div>
        {selectedCase ? (
          <div className="analysisCaseMeta">
            <span>사건 번호 <strong>{selectedCase.caseNo}</strong></span>
            <label className={`analysisCaseMetaEdit realtimeRequiredNameField${selectedCase.name ? '' : ' missing'}`}>
              <span>상담받은 사람 <em>필수 입력</em></span>
              <input
                value={selectedCase.name || ''}
                onChange={(event) => onUpdateConsultation(selectedCase.id, { name: event.target.value })}
                placeholder="통화 중 확인 즉시 반드시 입력"
              />
              {!selectedCase.name ? <small>이름은 서식 생성과 검토 요청에 사용되므로 놓치지 말고 입력하세요.</small> : null}
            </label>
            <label className="analysisCaseMetaEdit">
              <span>상담 제목</span>
              <input
                value={selectedCase.title || ''}
                onChange={(event) => onUpdateConsultation(selectedCase.id, { title: event.target.value })}
                placeholder="상담 제목 입력"
              />
            </label>
            <span>작성 시간 <strong>{selectedCase.date || '-'}{selectedCase.registeredTime ? ` ${selectedCase.registeredTime}` : ''}</strong></span>
          </div>
        ) : null}
        <RealtimeAnalysisPanel selectedCase={selectedCase} onUpdateConsultation={onUpdateConsultation} />
        {selectedCase ? (
          <div className="analysisSectionDivider">
            <span>AI 분석 결과</span>
            <p>업로드된 상담 내용과 첨부자료를 기준으로 생성된 분석입니다. 통화·STT 연동 전에도 그대로 사용할 수 있습니다.</p>
          </div>
        ) : null}
        {selectedCase ? (
          <div className="analysisProgressPanel">
            <span className={analyzed ? 'statusChip tone-success' : 'statusChip tone-muted'}>{analyzed ? '분석 완료' : '분석 전'}</span>
            {/* 분석 전에는 저장할 대상이 없으므로 주의색(주황) 대신 중립색으로 '저장 전'을 보여주고,
                분석을 마쳐 저장할 내용이 생겼을 때만 '저장 필요'(주황)로 주의를 끕니다. */}
            <span className={analysisSaved ? 'statusChip tone-success' : analyzed ? 'statusChip tone-warn' : 'statusChip tone-muted'}>{analysisSaved ? '저장됨' : analyzed ? '저장 필요' : '저장 전'}</span>
            <span className={selectedCase.reviewAction && !selectedCase.reviewAction.resolved ? 'statusChip tone-warn' : 'statusChip tone-info'}>
              {selectedCase.reviewAction && !selectedCase.reviewAction.resolved ? `${selectedCase.reviewAction.status} 대응` : selectedCase.workflowStatus || '상담 분석'}
            </span>
          </div>
        ) : null}
        {analyzed ? (
          <div className="analysisControlBar">
            <div>
              <strong>AI 자동 확인</strong>
              <span>아래 두 가지를 AI가 대신 확인해 드립니다. 결과를 살펴본 뒤 저장하고, 필요하면 변호사 검토를 요청하세요.</span>
            </div>
            <div className="analysisActions">
              {/* 두 버튼은 하는 일이 서로 다릅니다. 색만으로 구분되지 않도록 아이콘·제목·설명을 나눠 표시합니다. */}
              <button className={`aiActionCard tone-eligibility${analysis?.aiLinked?.eligibility ? ' done' : ''}`} type="button" onClick={runEligibilityCheck}>
                <ShieldCheck size={22} strokeWidth={2.2} />
                <span>
                  <strong>구조대상 판정</strong>
                  <small>대상여부 · 증빙 · 긴급도</small>
                </span>
                {analysis?.aiLinked?.eligibility ? <em><Check size={13} strokeWidth={3} /> 완료</em> : null}
              </button>
              <button className={`aiActionCard tone-missing${analysis?.aiLinked?.missing ? ' done' : ''}`} type="button" onClick={runMissingDataCheck}>
                <ClipboardList size={22} strokeWidth={2.2} />
                <span>
                  <strong>누락자료 점검</strong>
                  <small>더 받아야 할 서류 찾기</small>
                </span>
                {analysis?.aiLinked?.missing ? <em><Check size={13} strokeWidth={3} /> 완료</em> : null}
              </button>
            </div>
          </div>
        ) : null}
        {activeReviewAction ? (
          <section className="reviewRequestBanner">
            <div>
              <strong>{activeReviewAction.status}</strong>
              <span>{activeReviewAction.requestedAt}</span>
            </div>
            <dl>
              <dt>작성 변호사</dt>
              <dd>
                {activeReviewAction.reviewer?.name || '변호사'}
                {activeReviewAction.reviewer?.email ? ` · ${activeReviewAction.reviewer.email}` : ''}
                {activeReviewAction.reviewer?.organization ? ` · ${activeReviewAction.reviewer.organization}` : ''}
              </dd>
            </dl>
            <p>{activeReviewAction.reason}</p>
          </section>
        ) : null}
        {aiTaskMessage && (aiTaskMessage.includes('API') || aiTaskMessage.includes('실패') || aiTaskMessage.includes('연결')) ? (
          <p className="formError" role="status">{aiTaskMessage}</p>
        ) : null}
        {aiResultSummary ? (
          <section className="aiResultPanel" aria-label={aiResultSummary.title}>
            {aiTaskMessage ? (
              <div className="aiResultNotice" role="status">
                <strong>{aiTaskMessage}</strong>
                <span>아래 결과를 확인한 뒤 필요한 항목을 상담 기록에 반영해주세요.</span>
              </div>
            ) : null}
            <div className="aiResultHeader">
              <div>
                <h3>{aiResultSummary.title}</h3>
                <p>{aiResultSummary.description}</p>
              </div>
              <span className="statusChip tone-info">AI API 반영</span>
            </div>
            <div className="aiResultMetrics">
              {aiResultSummary.metrics.map((item) => (
                <span key={item.label}><small>{item.label}</small><strong>{item.value}</strong></span>
              ))}
            </div>
            {aiResultSummary.items.length ? (
              <ul className="aiResultList">
                {aiResultSummary.items.map((item) => <li key={item}>{item}</li>)}
              </ul>
            ) : <p className="helperText">추가로 표시할 세부 항목은 없습니다.</p>}
          </section>
        ) : null}
        {!analyzed ? (
          <div className="emptyState">
            <ClipboardList size={22} strokeWidth={2} aria-hidden="true" />
            <p>위 메모 칸에 통화 내용을 적은 뒤 분석을 시작하면 사건 유형, 긴급도, 필요 서류를 확인할 수 있습니다.</p>
            <button type="button" className="emptyStateAction" onClick={startAnalysis} disabled={isAnalyzing || !selectedCase}>
              {isAnalyzing ? '분석 중...' : '지금 분석 시작'}
            </button>
          </div>
        ) : (
          <div className="workflowColumns">
            <div>
              {/* AI 출력은 참고용이며 최종 확정은 담당자가 수행합니다. (사람이 검토·확정하는 원칙) */}
              <div className="hitlBanner">AI가 정리한 내용은 참고용이에요. 사건 유형·긴급도·구조대상 여부는 상담원과 변호사가 직접 확인한 뒤 확정합니다.</div>
              <h3>인공지능 분석 요약</h3>
              <div className="resultCard">{analysis.summary}</div>
              <h3>멀티모달 입력 분석</h3>
              <div className="resultCard">
                {analysis.modalities.map((item) => <span key={item.key} className="miniField" style={{ marginRight: 12 }}>{item.key}: {item.count}건</span>)}
              </div>
              <h3>첨부파일 추출 처리 상태</h3>
              <div className="resultCard">
                {analysis.extractionDetail?.length ? analysis.extractionDetail.map((item, index) => (
                  <div key={`${item.fileLink}-${index}`} className="extractRow">
                    <span className={`extractStatus status-${item.status}`}>{extractionStatusLabel(item.status)}</span>
                    <span className="extractName">{item.fileLink || '(파일명 없음)'}</span>
                    <span className="extractNote">{item.note}</span>
                  </div>
                )) : <p>첨부파일이 없습니다. (면담 텍스트만으로 분석)</p>}
              </div>
              <h3>STT 개인정보 마스킹</h3>
              <div className="resultCard">
                <div className="segmented compactSegmented">
                  <button type="button" className={showMaskedStt ? 'active' : ''} onClick={() => setShowMaskedStt(true)}>마스킹본</button>
                  <button type="button" className={!showMaskedStt ? 'active' : ''} onClick={() => setShowMaskedStt(false)}>원문</button>
                </div>
                {!showMaskedStt ? <p className="sensitiveSourceNotice">원문에는 주민등록번호·연락처 등 민감정보가 포함될 수 있습니다. 검증 목적일 때만 확인하세요.</p> : null}
                <p className="sttPreviewText">{showMaskedStt ? analysis.sttPreview?.masked : analysis.sttPreview?.original}</p>
                <p className="helperText">기본 검토 화면은 마스킹본을 기준으로 사용합니다. 원문은 STT 오류나 과도한 마스킹 여부를 확인할 때만 참고합니다.</p>
              </div>
              <h3>AI 응답 검증</h3>
              <div className="resultCard">
                <span className="miniField">형식 검증: {analysis.verification?.format ? '통과' : '오류'}</span>
                <span className="miniField">근거 검증: {analysis.verification?.grounded ? '첨부자료 근거 확인' : '근거 부족 (첨부자료 없음)'}</span>
                <span className="miniField">환각 탐지: {analysis.verification?.hallucinationRisk ? '위험 - 원문 내용 부족' : '이상 없음'}</span>
              </div>
              <h3>구조검토</h3>
              <div className={analysis.aiLinked?.eligibility ? 'resultCard aiLinkedCard' : 'resultCard'}>
                {analysis.aiLinked?.eligibility ? (
                  <div className="fieldSyncNotice">
                    <strong>구조대상 판정 반영됨</strong>
                    <span>구조대상 여부, 증빙 제출 여부, 긴급도 등급과 체크리스트가 판정 결과에 맞춰 갱신되었습니다.</span>
                  </div>
                ) : null}
                <label className="miniField">사건 유형<input value={analysis.caseType} onChange={(event) => setAnalysis({ ...analysis, caseType: event.target.value })} /></label>
                <p className="reasonText">분류 근거: {analysis.caseTypeReason}</p>
                <label className="miniField">긴급도 등급
                  <select value={analysis.urgency} onChange={(event) => setAnalysis({ ...analysis, urgency: event.target.value, emergency: { ...analysis.emergency, level: event.target.value } })}><option>상</option><option>중</option><option>하</option></select>
                </label>
                <div className="urgencyGauge">
                  <div className="urgencyGaugeTrack"><div className={`urgencyGaugeFill level-${analysis.emergency?.level}`} style={{ width: `${Math.round((analysis.emergency?.ratio || 0) * 100)}%` }} /></div>
                  <span className="urgencyGaugeValue">긴급도 점수 {Math.round((analysis.emergency?.ratio || 0) * 100)}%</span>
                </div>
                <p className="reasonText">긴급도 근거: {analysis.emergency?.reason}</p>
                <label className="miniField">구조대상 여부<select value={analysis.eligibility} onChange={(event) => setAnalysis({ ...analysis, eligibility: event.target.value })}><option>검토 필요</option><option>구조 가능</option><option>부적합</option><option>보류</option></select></label>
                {analysis.eligibilityCheck ? (
                  <div className={analysis.eligibilityCheck.isTargetCandidate && !analysis.eligibilityCheck.evidenceSubmitted ? 'eligibilitySummary missingEvidence' : 'eligibilitySummary'}>
                    <span>대상 유형: {analysis.eligibilityCheck.applicantType}</span>
                    <span>필요 증빙: {analysis.eligibilityCheck.requiredEvidence}</span>
                    <span>증빙 제출: {analysis.eligibilityCheck.evidenceSubmitted ? '확인됨' : '미제출'}</span>
                  </div>
                ) : null}
              </div>
              <h3>체크리스트</h3>
              <div className="resultCard checklistBox">
                {analysis.checklist.map((item, index) => (
                  <label key={item.label}><input type="checkbox" checked={item.checked} onChange={() => updateChecklist(index)} />{item.label}</label>
                ))}
              </div>
            </div>
            <div className="analysisActionRail">
              <div className="railIntro">
                <strong>검토 조치 패널</strong>
                <span>AI 제안을 확인하고 실제 검토에 반영할 항목만 채택합니다.</span>
              </div>
              <h3>누락 자료 확인</h3>
              <p className="railHint">상담자에게 받아야 할 자료입니다. 받은 자료는 눌러서 <b>제출</b>로 바꾸면, 아직 안 받은 자료만 <b>미제출</b>로 남습니다.</p>
              <div className={analysis.aiLinked?.missing ? 'scrollBox small aiLinkedList' : 'scrollBox small'}>
                {analysis.aiLinked?.missing ? (
                  <p className="fieldSyncNotice compactNotice"><strong>누락자료 점검 반영됨</strong><span>AI가 더 받아야 할 자료를 목록에 추가했습니다.</span></p>
                ) : null}
                {analysis.missingInfo.length ? analysis.missingInfo.map((item) => {
                  const submitted = analysis.evidenceStatus?.[item] === 'submitted';
                  return (
                    <button type="button" key={item} className={`evidenceItem ${submitted ? 'submitted' : 'missing'}`} onClick={() => toggleEvidenceStatus(item)} aria-pressed={submitted}>
                      <span className="evidenceItemName">{item}</span>
                      <span className="evidenceItemState">{submitted ? '제출' : '미제출'}</span>
                    </button>
                  );
                }) : <p>확인할 누락 자료가 없습니다.</p>}
              </div>
              <h3>AI 추천 후속 작업</h3>
              <p className="railHint">이 상담을 진행할 때 도움이 될 작업을 AI가 제안합니다. 필요한 것만 채택하면 아래 ‘검토 반영 항목’에 담깁니다.</p>
              <div className="scrollBox">
                {suggestions.map((item) => {
                  const picked = chosen.includes(item.label);
                  return (
                    <button className={`adoptButton${picked ? ' picked' : ''}`} type="button" key={item.label} onClick={() => setChosen((current) => current.includes(item.label) ? current : [...current, item.label])} disabled={picked}>
                      <span className="adoptText"><strong>{item.label}</strong><small>{item.description}</small></span>
                      <strong className="adoptAction">{picked ? '채택됨' : '채택'}</strong>
                    </button>
                  );
                })}
              </div>
              <h3>사실관계 타임라인</h3>
              <div className="scrollBox small">
                {analysis.timeline.map((item, index) => <button type="button" key={`${item.date}-${index}`}>{item.date} - {item.text}</button>)}
              </div>
              <div className="inlineControls compactInline">
                <input value={timelineText} onChange={(event) => setTimelineText(event.target.value)} placeholder="타임라인 항목" />
                <button type="button" onClick={() => {
                  if (!timelineText.trim()) return;
                  setAnalysis({ ...analysis, timeline: [...analysis.timeline, { date: today, text: timelineText }] });
                  setTimelineText('');
                }}>추가</button>
              </div>
              <h3>검토 반영 항목</h3>
              <div className="scrollBox small chosenBox">{chosen.length ? chosen.map((item) => <button type="button" key={item} onClick={() => setChosen(chosen.filter((value) => value !== item))}>{item} · 제외</button>) : <p>아직 채택한 항목이 없습니다. 추천 항목에서 필요한 내용만 채택하세요.</p>}</div>
            </div>
          </div>
        )}
        {analyzed ? (
          <div className="analysisFinalActions">
            <button className="primaryButton compactAction" type="button" onClick={saveAnalysis}>분석 내용 저장</button>
            <button className="secondaryActionButton compactAction" type="button" onClick={requestReview} disabled={!analysisSaved}>변호사 검토 요청</button>
          </div>
        ) : null}
        {savedMessage ? (
          <p className={savedMessage.startsWith('저장 실패') ? 'formError' : 'successBanner'} role="status">
            {savedMessage.startsWith('저장 실패') ? null : <span className="successBannerBadge">저장 완료</span>}
            {savedMessage.replace(/^저장 (완료|실패): /, '')}
          </p>
        ) : null}
        {reviewMessage ? (
          <p className={reviewMessage.includes('찾을 수') || reviewMessage.includes('먼저 저장') ? 'formError' : 'successBanner'} role="status">
            {reviewMessage.includes('찾을 수') || reviewMessage.includes('먼저 저장') ? null : <span className="successBannerBadge">요청 완료</span>}
            {reviewMessage}
          </p>
        ) : null}
        {pendingHitlAction ? (
          <HitlConfirmModal
            title={pendingHitlAction.type === 'save' ? '상담 분석 저장 전 최종 확인' : '변호사 검토 요청 전 최종 확인'}
            actionLabel={pendingHitlAction.type === 'save' ? '확인 후 저장' : '확인 후 요청'}
            caseInfo={caseInfoText}
            onConfirm={confirmHitlAction}
            onCancel={() => setPendingHitlAction(null)}
          />
        ) : null}
      </section>
    </main>
  );
}

function DraftWorkbench({ consultations, currentUser, role, onUpdateConsultation, onNotify, onDocumentReviewDecision, focusedConsultationId }) {
  const showToast = useToast();
  const [step, setStep] = useState('select');
  const [caseId, setCaseId] = useState(caseOptions(consultations)[0].id);
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
  const [aiRecommendations, setAiRecommendations] = useState([]);
  const [recommendLoading, setRecommendLoading] = useState(false);
  useEffect(() => {
    setAiRecommendations([]);
    if (!canUseCoreApi) return;
    let cancelled = false;
    setRecommendLoading(true);
    recommendCoreForms(selectedCase.coreId, selectedCase.coreAnalysisId)
      .then((response) => {
        if (!cancelled) setAiRecommendations(response?.recommendations || []);
      })
      .catch(() => {
        // 실패해도 화면을 막지 않습니다 — 아래 로컬 추천으로 계속 진행됩니다.
        if (!cancelled) setAiRecommendations([]);
      })
      .finally(() => {
        if (!cancelled) setRecommendLoading(false);
      });
    return () => { cancelled = true; };
  }, [canUseCoreApi, selectedCase?.coreId, selectedCase?.coreAnalysisId]);

  // ── 생성된 초안의 core-api 문서 상태(초안 생성 → 검토 요청 → 승인/반려)입니다.
  // 사건이나 서식을 바꾸면 이전 초안의 id가 지금 화면과 안 맞으니 초기화합니다.
  const [draftDocument, setDraftDocument] = useState(null);
  const [submitReviewPending, setSubmitReviewPending] = useState(false);
  useEffect(() => {
    setDraftDocument(null);
  }, [caseId, template]);

  // ── 변호사 전용: 선택한 사건에 제출된 서식 초안 목록(승인/반려 대상)입니다.
  const isLawyerReviewer = role === 'lawyer';
  const [caseDocuments, setCaseDocuments] = useState([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const reloadCaseDocuments = () => {
    if (!isLawyerReviewer || !selectedCase?.coreId) {
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
  }, [isLawyerReviewer, selectedCase?.coreId]);

  // 변호사 승인/반려 인라인 폼 상태. 한 번에 하나의 문서만 검토 폼을 열어둡니다.
  const [reviewingDocumentId, setReviewingDocumentId] = useState(null);
  const [reviewAction, setReviewAction] = useState('approve');
  const [reviewNoteText, setReviewNoteText] = useState('');
  const [reviewMaterialsText, setReviewMaterialsText] = useState('');
  const [reviewPending, setReviewPending] = useState(false);
  const startDocumentReview = (documentId, action) => {
    setReviewingDocumentId(documentId);
    setReviewAction(action);
    setReviewNoteText('');
    setReviewMaterialsText('');
  };
  const cancelDocumentReview = () => setReviewingDocumentId(null);
  const confirmDocumentReview = async () => {
    if (!selectedCase?.coreId || !reviewingDocumentId) return;
    // 반려는 사유가 없으면 상담원이 뭘 고쳐야 할지 알 수 없으므로 필수로 막습니다. (백엔드 RequestRevisionRequest.note도 필수)
    if (reviewAction === 'revision' && !reviewNoteText.trim()) {
      showToast('반려 사유를 입력해주세요.', 'warn');
      return;
    }
    setReviewPending(true);
    try {
      const token = currentUser?.token;
      const reviewedDocument = caseDocuments.find((doc) => doc.document_id === reviewingDocumentId);
      const reviewerInfo = {
        name: currentUser?.name || '변호사',
        email: currentUser?.email || '',
        organization: currentUser?.organization || '',
      };
      const materials = reviewMaterialsText.split(',').map((item) => item.trim()).filter(Boolean);
      if (reviewAction === 'approve') {
        await approveCoreDocument(selectedCase.coreId, reviewingDocumentId, reviewNoteText, token);
        showToast('서식 초안을 승인했습니다.', 'success');
      } else {
        await requestCoreDocumentRevision(selectedCase.coreId, reviewingDocumentId, reviewNoteText, materials, token);
        showToast('서식 초안에 수정을 요청했습니다.', 'success');
      }
      onDocumentReviewDecision?.({
        caseNo: selectedCase.caseNo,
        action: reviewAction === 'approve' ? 'approve' : 'revision',
        reason: reviewNoteText || '',
        reviewer: reviewerInfo,
        recipientEmail: selectedCase.counselor?.email || '',
        formName: reviewedDocument?.requested_form_name || reviewedDocument?.form_name || '',
        requestedMaterials: reviewAction === 'revision' ? materials : [],
      });
      onNotify?.({
        roles: 'counselor',
        title: reviewAction === 'approve' ? '서식 초안 승인' : '서식 보완 요청',
        message: `${selectedCase.caseNo} · ${reviewedDocument?.form_name || '서식 초안'}${reviewNoteText ? ` / ${reviewNoteText}` : ''}`,
        target: selectedCase.caseNo,
        recipientEmail: selectedCase.counselor?.email || '',
        view: '서식 생성',
      });
      setReviewingDocumentId(null);
      reloadCaseDocuments();
    } catch (error) {
      showToast(`처리에 실패했습니다: ${error.message}`, 'warn');
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
  const [onlyForCase, setOnlyForCase] = useState(false);
  const activeMajor = caseCategories.find((category) => category.key === majorFilter);
  const minorOptions = ['전체', ...(activeMajor ? activeMajor.subTypes : [])];

  // 켜둔 채로 분류가 없는 사건으로 넘어가면 목록이 빈 채로 잠기므로, 실제 적용 여부는 분류 유무까지 함께 봅니다.
  const scopeToCase = onlyForCase && Boolean(draftCaseType);
  // 추천 목록을 켜면 그 결과를, 끄면 전체 서식을 바탕으로 아래 3단계 필터를 겁니다.
  const baseTemplates = scopeToCase ? recommendTemplates(draftCaseType) : legalTemplateSeed;

  const filteredTemplates = baseTemplates.filter((item) => {
    const matchesMajor = majorFilter === '전체' || item.caseCategory === majorFilter;
    const matchesMinor = minorFilter === '전체' || item.caseType === minorFilter;
    const matchesSearch = !searchText.trim() || item.templateName.includes(searchText.trim());
    return matchesMajor && matchesMinor && matchesSearch;
  });
  // AI 추천(recommend-forms) 결과가 있으면 즐겨찾기보다도 먼저 보여줍니다 — 지금 이 사건에
  // 대해 실제로 추천된 서식이라 가장 눈에 잘 띄어야 합니다. rank가 있으면 그 순서를 따릅니다.
  const aiRecommendationRank = new Map(aiRecommendations.map((item, index) => [item.form_name, item.rank ?? index]));
  const templates = [...filteredTemplates].sort((a, b) => {
    const aRank = aiRecommendationRank.has(a.templateName) ? aiRecommendationRank.get(a.templateName) : Infinity;
    const bRank = aiRecommendationRank.has(b.templateName) ? aiRecommendationRank.get(b.templateName) : Infinity;
    if (aRank !== bRank) return aRank - bRank;
    const aFav = favorites.includes(a.templateName) ? 0 : 1;
    const bFav = favorites.includes(b.templateName) ? 0 : 1;
    return aFav - bFav;
  });
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

  // 실제 초안 생성: core-api(→ai-api)로 먼저 시도하고, 실패하면 ai-api를 직접 불러 로컬 검토용
  // 문서로 만듭니다. 그마저 안 되면 지금 화면의 초안 본문으로 브라우저에서 즉석 HWPX를 만들어
  // 검토 요청 흐름이 끊기지 않게 합니다(생성 자체가 막혀도 변호사 검토까지는 진행할 수 있도록).
  const generateDraftDocument = async (draftContent) => {
    const analysis = selectedCase.analysis || buildAnalysisResult(selectedCase);
    const hwpxTemplateName = resolveHwpxTemplateName(selectedTemplate.templateName);
    try {
      const coreContext = canUseCoreApi
        ? { coreId: selectedCase.coreId, coreAnalysisId: selectedCase.coreAnalysisId }
        : await syncCaseForDraftGeneration();
      if (!coreContext) throw new Error('상담 또는 분석 결과를 Core API에 저장하지 못했습니다.');
      const created = await generateCoreDraft(coreContext.coreId, coreContext.coreAnalysisId, hwpxTemplateName);
      // core-api 응답(GeneratedDocumentResponse)에는 draft_content가 없고 서버 로컬 경로(draftFilePath)만
      // 내려옵니다. 그 경로는 브라우저가 접근할 수 없어 다운로드 링크를 만들 수 없으므로, 지금 화면에
      // 이미 만들어 둔 초안 본문(draftContent)을 함께 실어 보내 GeneratedFileBox/GeneratedFileLink가
      // 브라우저에서 즉석 HWPX를 만들어 다운로드할 수 있게 합니다(백엔드에 다운로드 엔드포인트가
      // 생기기 전까지의 대체 경로).
      return { ...normalizeGeneratedDocument(created), draftContent };
    } catch (coreError) {
      console.warn('[서식 생성] core-api 초안 생성 실패, ai-api 직접 생성으로 대체합니다:', coreError.message);
      try {
        await generateAiDraft(buildAiDraftPayload({
          templateName: selectedTemplate.templateName,
          consultation: selectedCase,
          analysis,
        }));
      } catch (aiError) {
        console.warn('[서식 생성] ai-api 초안 생성 실패, 브라우저에서 HWPX를 만듭니다.', aiError.message);
      }
      return createClientHwpxReviewDocument({
        consultation: selectedCase,
        templateName: selectedTemplate.templateName,
        draftContent,
      });
    }
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
        setGeneratedFileMessage(document.draftFilePath
          ? isHwpxTemplateAlias(selectedTemplate.templateName)
            ? `ai-api 원본명 「${resolveHwpxTemplateName(selectedTemplate.templateName)}」으로 HWPX 초안을 생성했습니다. 아래 생성 파일 영역에서 확인하세요.`
            : 'HWPX 초안이 생성되었습니다. 아래 생성 파일 영역에서 확인하세요.'
          : 'HWPX 초안 문서가 생성되었지만 파일 경로가 응답에 포함되지 않았습니다.');
      } catch (error) {
        const fallbackDraft = nextDraft;
        const fallbackDocument = createClientHwpxReviewDocument({
          consultation: selectedCase,
          templateName: selectedTemplate.templateName,
          draftContent: fallbackDraft,
        });
        setDraftDocument(fallbackDocument);
        syncDraftSnapshot(fallbackDocument, fallbackDraft);
        const message = draftGenerationFallbackMessage(error);
        setGeneratedFileMessage(message);
        showToast(message, 'success');
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
        setGeneratedFileMessage(document.draftFilePath
          ? isHwpxTemplateAlias(selectedTemplate.templateName)
            ? `ai-api 원본명 「${resolveHwpxTemplateName(selectedTemplate.templateName)}」으로 HWPX 초안을 다시 생성했습니다.`
            : 'HWPX 초안을 다시 생성했습니다. 아래 생성 파일 영역에서 확인하세요.'
          : 'HWPX 초안 문서를 다시 생성했지만 파일 경로가 응답에 포함되지 않았습니다.');
        showToast('HWPX 초안을 다시 생성했습니다.', 'success');
      } catch (error) {
        const fallbackDraft = nextDraft;
        const fallbackDocument = createClientHwpxReviewDocument({
          consultation: selectedCase,
          templateName: selectedTemplate.templateName,
          draftContent: fallbackDraft,
        });
        setDraftDocument(fallbackDocument);
        syncDraftSnapshot(fallbackDocument, fallbackDraft);
        const message = draftGenerationFallbackMessage(error);
        setGeneratedFileMessage(message);
        showToast(message, 'success');
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
      if (draftDocument.source === 'ai-api-local' || draftDocument.source === 'text-local' || draftDocument.source === 'client-hwpx') {
        const submitted = saveLocalDocumentReviewRequest({ consultation: selectedCase, document: draftDocument });
        const normalized = normalizeGeneratedDocument(submitted);
        setDraftDocument(normalized);
        syncDraftSnapshot(normalized, draft);
        onNotify?.({
          roles: 'lawyer',
          title: '서식 검토 요청',
          message: `${selectedCase.caseNo} · ${draftDocument.formName || selectedTemplate?.templateName || '서식 초안'}`,
          target: selectedCase.caseNo,
          view: '대시보드',
        });
        showToast('변호사에게 검토를 요청했습니다.', 'success');
        return;
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
      showToast('변호사에게 검토를 요청했습니다.', 'success');
    } catch (error) {
      showToast(`검토 요청에 실패했습니다: ${error.message}`, 'warn');
    } finally {
      setSubmitReviewPending(false);
    }
  };

  const canRequestDocumentReview = Boolean(draftDocument?.documentId) && draftDocument?.source === 'core-api' && role !== 'lawyer'
    && draftDocument.status !== 'SUBMITTED_FOR_REVIEW'
    && draftDocument.status !== 'APPROVED';
  const reviewRequestGuide = !draftDocument?.documentId
    ? 'HWPX 초안이 서버에 생성된 뒤 변호사 검토를 요청할 수 있습니다.'
    : draftDocument.status === 'SUBMITTED_FOR_REVIEW'
      ? '이미 변호사에게 검토 요청된 서식입니다.'
      : draftDocument.status === 'APPROVED'
        ? '변호사가 이미 승인한 서식입니다.'
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
    const message = `「${selectedTemplate.templateName}」 초안을 저장했습니다. 이 브라우저에서 다시 열 수 있습니다.`;
    setSavedMessage(message);
    // 저장 버튼 아래 안내 문구는 스크롤 위치에 따라 안 보일 수 있습니다.
    // 눌렀다는 걸 바로 알 수 있도록 화면 우측 아래 토스트로도 같이 띄웁니다.
    showToast(message, 'success');
  };

  if (step === 'draft') {
    return (
      <main className="workspacePage">
        <section className="workflowPanel draftPanel">
          <h2>서식 초안</h2>
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
              {submitReviewPending ? '검토 요청하는 중…' : draftDocument?.status === 'SUBMITTED_FOR_REVIEW' ? '검토 요청됨' : '변호사 검토 요청'}
            </button>
            <button className="secondaryActionButton compactAction" type="button" onClick={regenerateDraftDocument}>HWPX 다시 생성</button>
          </div>
          {reviewRequestGuide ? <p className="helperText">{reviewRequestGuide}</p> : null}
          {savedMessage ? <p className="successBanner"><span className="successBannerBadge">저장 완료</span>{savedMessage}</p> : null}
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
        <h2>{isLawyerReviewer ? '법률 서식 초안 검토' : '법률 서식 초안 생성'}</h2>
        <div className="apiPendingBanner">
          <strong>{isLawyerReviewer ? 'HWPX 서식 검토 연동' : 'HWPX 서식 생성 연동'}</strong>
          <span>
            {isLawyerReviewer
              ? '상담원이 제출한 HWPX 초안을 확인하고 승인·반려 결과를 서버에 반영합니다.'
              : '서식을 고르면 core-api/ai-api가 실제 HWPX 초안을 생성하고, 상담원의 검토 요청과 변호사의 승인·반려까지 서버에 그대로 반영됩니다.'}
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
        {isLawyerReviewer && selectedCase ? (
          <section className="documentReviewPanel">
            <div className="panelTitleRow">
              <h3>제출된 서식 검토</h3>
              {documentsLoading ? <span className="helperText">불러오는 중…</span> : null}
            </div>
            {!selectedCase.coreId ? (
              <p className="templateEmpty">이 상담은 core-api에 저장되지 않아(로컬 전용) 서식 검토를 불러올 수 없습니다.</p>
            ) : caseDocuments.length ? (
              <div className="documentReviewList">
                {caseDocuments.map((doc) => (
                  <div className="documentReviewRow" key={doc.document_id}>
                    <div className="documentReviewInfo">
                      <strong>{doc.form_name}</strong>
                      <span className={`statusChip tone-${documentStatusTone(doc.status)}`}>{DOCUMENT_STATUS_LABEL[doc.status] || doc.status}</span>
                      <GeneratedFileLink
                        path={doc.draft_file_path}
                        consultationId={selectedCase.coreId}
                        documentId={doc.document_id}
                        content={doc.draft_content}
                        downloadFileName={doc.download_file_name}
                      />
                      {doc.review_note ? <p className="reasonText">지난 검토 코멘트: {doc.review_note}</p> : null}
                      {doc.requested_materials?.length ? <p className="reasonText">요청 자료: {doc.requested_materials.join(', ')}</p> : null}
                    </div>
                    {doc.status === 'SUBMITTED_FOR_REVIEW' ? (
                      reviewingDocumentId === doc.document_id ? (
                        <div className="documentReviewForm">
                          <textarea
                            value={reviewNoteText}
                            onChange={(event) => setReviewNoteText(event.target.value)}
                            placeholder={reviewAction === 'approve' ? '승인 코멘트 (선택)' : '반려 사유 (필수)'}
                          />
                          {reviewAction === 'revision' ? (
                            <input
                              value={reviewMaterialsText}
                              onChange={(event) => setReviewMaterialsText(event.target.value)}
                              placeholder="상담원에게 요청할 자료 (쉼표로 구분, 선택)"
                            />
                          ) : null}
                          <div className="inlineControls">
                            <button type="button" onClick={cancelDocumentReview} disabled={reviewPending}>취소</button>
                            <button
                              className="primaryButton"
                              type="button"
                              onClick={confirmDocumentReview}
                              disabled={reviewPending || (reviewAction === 'revision' && !reviewNoteText.trim())}
                            >
                              {reviewPending ? '처리하는 중…' : reviewAction === 'approve' ? '승인 확정' : '반려 확정'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="inlineControls">
                          <button className="secondaryActionButton" type="button" onClick={() => startDocumentReview(doc.document_id, 'approve')}>승인</button>
                          <button className="ghostActionButton" type="button" onClick={() => startDocumentReview(doc.document_id, 'revision')}>반려</button>
                        </div>
                      )
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="templateEmpty">{documentsLoading ? '' : '이 사건에 제출된 서식 초안이 없습니다.'}</p>
            )}
          </section>
        ) : null}
        {!isLawyerReviewer ? (
          <>
            <div className="workflowColumns">
              <div>
                <h3>서식 선택</h3>
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
                    <span className="templateScopeEmpty">이 분류에 연결된 서식이 없습니다. 전체에서 찾아주세요.</span>
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
                            {aiMatch ? <em className="templateAiBadge" title={aiMatch.reason || 'AI 추천 서식'}>AI 추천</em> : null}
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
                          {favorites.includes(item.templateName) ? '★' : '+'}
                        </span>
                      </button>
                    );
                  }) : <p className="templateEmpty">해당 조건의 서식이 없습니다.</p>}
                </div>
              </div>
              <div>
                <h3>추출 필드 자동 채움</h3>
                <div className="draftApiPlan">
                  <strong>API 요청 예정 데이터</strong>
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
                  ) : <p>서식을 선택하면 필요한 항목이 표시됩니다.</p>}
                </div>
              </div>
            </div>
            <div className="draftFinalActions">
              <button className="primaryButton compactAction" type="button" onClick={goToPreview} disabled={!selectedTemplate}>서식 초안 생성</button>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}

function SearchWorkbench({ consultations }) {
  const [caseId, setCaseId] = useState(caseOptions(consultations)[0].id);
  const [referenceType, setReferenceType] = useState('precedent');
  const [mode, setMode] = useState('추천');
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState([]);
  const [referenceMessage, setReferenceMessage] = useState('');
  const label = referenceType === 'precedent' ? '판례' : referenceType === 'similar' ? '유사 상담사례' : '법령';
  const selectedCase = consultations.find((item) => String(item.id) === String(caseId));
  const results = searched || mode === '추천' ? searchReferenceCandidates({ type: referenceType, query, caseType: selectedCase?.type }) : [];
  const selectedTitles = selected.map((item) => item.title);
  const runAiReferenceSearch = () => {
    setSearched(true);
    setReferenceMessage('법령·판례 추천 API가 연결되면 상담 분석 요약과 사건 유형을 함께 전송합니다. 현재는 준비된 후보 목록을 기준으로 검토 흐름을 확인합니다.');
  };
  const adoptReference = (item) => {
    setSelected((current) => current.some((value) => value.id === item.id) ? current : [...current, item]);
  };

  return (
    <main className="workspacePage">
      <section className="workflowPanel searchPanel">
        <h2>법령 및 판례 찾기</h2>
        <div className="apiPendingBanner">
          <strong>AI 추천 연동 준비</strong>
          <span>상담 분석 결과를 기준으로 법령·판례·유사사례를 검토하고 채택하는 흐름입니다.</span>
        </div>
        <div className="inlineControls">
          <CasePicker
            consultations={consultations}
            value={caseId}
            onChange={(nextCaseId) => {
              setCaseId(nextCaseId);
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
        <div className="segmented">
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
                setSelected([]);
                setSearched(mode === '추천');
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="referenceToolbar">
          <div className="segmented">
            {['추천', '직접 검색'].map((item) => <button className={mode === item ? 'active' : ''} type="button" key={item} onClick={() => { setMode(item); setSearched(item === '추천'); }}>{item}</button>)}
          </div>
          {mode === '직접 검색' ? (
            <div className="referenceSearchBox">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`${label} 검색어`} />
              <button type="button" onClick={() => setSearched(true)}>검색</button>
            </div>
          ) : null}
        </div>
        <div className="referenceActionBar">
          <div>
            <strong>{mode === '추천' ? '상담 분석 기반 추천' : '직접 검색 결과 검토'}</strong>
            <span>{selected.length ? `${selected.length}개 항목을 검토 자료로 선택했습니다.` : '목록에서 실제 검토에 쓸 후보를 선택하세요.'}</span>
          </div>
          <div className="referenceActionButtons">
            <button className="secondaryActionButton compactAction" type="button" onClick={runAiReferenceSearch}>AI 추천 실행</button>
            <button className="primaryButton compactAction" type="button" onClick={() => setReferenceMessage('선택한 법령·판례·유사 상담사례를 상담 분석 검토 자료에 반영했습니다.')} disabled={!selected.length}>선택 항목 반영</button>
          </div>
        </div>
        {referenceMessage ? <p className="apiPendingMessage" role="status">{referenceMessage}</p> : null}
        <div className="workflowColumns">
          <div>
            <h3>{label} 목록</h3>
            <div className="referenceList">
              {results.length ? results.map((item) => (
                <button className={selectedTitles.includes(item.title) ? 'referenceCard selected' : 'referenceCard'} type="button" key={item.id} onClick={() => adoptReference(item)}>
                  <span className="referenceCardTitle">{item.title}</span>
                  <span className="referenceCardMeta">{item.source} · {item.caseType}</span>
                  <strong>{selectedTitles.includes(item.title) ? '선택됨' : '선택'}</strong>
                </button>
              )) : <p className="templateEmpty">조건에 맞는 {label} 후보가 없습니다.</p>}
            </div>
          </div>
          <div>
            <h3>검토에 반영할 자료</h3>
            <div className="referenceSelectedPanel">
              {selected.length ? selected.map((item) => (
                <button type="button" key={item.id} onClick={() => setSelected(selected.filter((value) => value.id !== item.id))}>
                  <span>{item.title}</span>
                  <small>{item.source}</small>
                  <strong>빼기</strong>
                </button>
              )) : <p>선택된 {label}가 없습니다. 목록에서 실제 검토에 쓸 후보만 채택하세요.</p>}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function NotificationPanel({ role, currentUser, notifications = [], onReadNotifications, onDeleteNotification, onOpenNotification }) {
  const confirm = useConfirm();
  const notificationKey = `${role}:${currentUser?.email || 'all'}`;
  const roleNotifications = notifications.filter((item) => {
    if (!item.roles?.includes(role)) return false;
    if (item.recipientEmail && item.recipientEmail !== currentUser?.email) return false;
    return !item.deletedBy?.includes(role) && !item.deletedBy?.includes(notificationKey);
  });
  const unreadCount = roleNotifications.filter((item) => !item.readBy?.includes(role) && !item.readBy?.includes(notificationKey)).length;
  const handleDelete = async (event, item, unread) => {
    event.stopPropagation();
    if (unread) {
      const accepted = await confirm({
        title: '읽지 않은 알림을 삭제할까요?',
        message: `「${item.title}」은 아직 확인하지 않은 알림입니다. 삭제하면 다시 볼 수 없습니다.`,
        confirmLabel: '삭제',
        tone: 'danger',
      });
      if (!accepted) return;
    }
    onDeleteNotification?.(item.id, role, currentUser?.email);
  };
  return (
    <section className="workPanel notificationPanel">
      <div className="notificationHeader">
        <div>
          <h2>알림</h2>
          <p>내가 처리해야 할 업무 알림을 확인합니다.</p>
        </div>
        <span className="notificationCount">새 알림 {unreadCount}건</span>
      </div>
      {roleNotifications.length ? (
        <div className="notificationList">
          {roleNotifications.map((item) => {
            const unread = !item.readBy?.includes(role) && !item.readBy?.includes(notificationKey);
            return (
              <article
                className={unread ? 'notificationItem unread' : 'notificationItem read'}
                key={item.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpenNotification?.(item)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onOpenNotification?.(item);
                }}
              >
                <div className="notificationItemTop">
                  <strong className="notificationItemTitle">{item.title}</strong>
                  <span className="notificationItemTime">{new Date(item.createdAt).toLocaleString('ko-KR')}</span>
                </div>
                <p className="notificationItemMessage">{item.message}</p>
                <div className="notificationActions">
                  <span className="notificationState">{unread ? '바로 처리' : '내용 보기'}</span>
                  <button className="notificationDelete" type="button" onClick={(event) => handleDelete(event, item, unread)}>삭제</button>
                </div>
              </article>
            );
          })}
        </div>
      ) : <p className="notificationEmpty">확인할 알림이 없습니다.</p>}
      <button className="primaryButton compactAction" type="button" onClick={() => onReadNotifications?.(role, currentUser?.email)} disabled={!unreadCount}>전체 읽음 처리</button>
    </section>
  );
}

function ProfilePanel({ role, currentUser, onUpdateProfile }) {
  const [form, setForm] = useState({
    email: currentUser?.email || '',
    organization: currentUser?.organization || '',
    phone: currentUser?.phone || '',
    password: '',
    confirmPassword: '',
  });
  const [message, setMessage] = useState('');
  const mismatch = form.confirmPassword && form.password !== form.confirmPassword;
  const roleLabel = role === 'counselor' ? '상담원' : role === 'lawyer' ? '변호사' : '관리자';
  // 상담원/변호사는 가입 시 등록된 이메일·소속기관이 계정 식별/조직 배정 기준이라
  // 본인이 임의로 바꾸지 못하도록 막습니다. (변경이 필요하면 관리자에게 문의)
  const lockContactFields = role === 'counselor' || role === 'lawyer';
  // 소속은 '지부 / 부서' 한 문자열로 저장되어 있어, 화면에서는 두 칸으로 나눠 보여줍니다.
  // 부서 없이 가입한 예전 계정도 있으므로 branch 필드를 우선 쓰고 없으면 앞부분을 사용합니다.
  const [savedBranch, ...savedDepartmentParts] = (currentUser?.organization || '').split(' / ');
  const branchValue = currentUser?.branch || savedBranch || '';
  const departmentValue = currentUser?.department || savedDepartmentParts.join(' / ');

  const save = () => {
    if (!form.email) {
      setMessage('이메일을 입력해주세요.');
      return;
    }
    if (mismatch) {
      setMessage('비밀번호와 비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    onUpdateProfile({
      // 잠긴 필드는 화면에서 수정이 막혀 있지만, 혹시 모를 우회를 방지하고자 저장 시에도
      // 원래 계정 값(currentUser)을 그대로 사용하고 form 값은 무시합니다.
      email: lockContactFields ? (currentUser?.email || '') : form.email,
      password: form.password || currentUser?.password || '',
      organization: lockContactFields ? (currentUser?.organization || '') : form.organization,
      // 연락처는 신원·소속 확인용 정보가 아니라 실무 연락 목적이라 역할과 무관하게 본인이 직접 수정할 수 있습니다.
      phone: form.phone,
    });
    setMessage('프로필이 저장되었습니다.');
    setForm((current) => ({ ...current, password: '', confirmPassword: '' }));
  };

  return (
    <section className="workPanel profilePanel">
      <h2>프로필</h2>
      <p>{roleLabel} 권한으로 로그인 중입니다.</p>
      <label className="field">
        <span>이메일</span>
        <input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} type="email" placeholder="이메일 입력" readOnly={lockContactFields} disabled={lockContactFields} />
      </label>
      {/* 상담원·변호사는 가입 시 고른 지부와 입력한 부서를 각각 보여줍니다.
        * 둘 다 조직 배정 기준이라 이메일과 마찬가지로 본인이 고칠 수 없습니다. */}
      {lockContactFields ? (
        <div className="formGrid">
          <label className="field">
            <span>소속기관 (지부)</span>
            <input value={branchValue} placeholder="가입 시 선택한 소속 지부" readOnly disabled />
          </label>
          <label className="field">
            <span>부서</span>
            <input value={departmentValue} placeholder="가입 시 입력한 부서" readOnly disabled />
          </label>
        </div>
      ) : (
        <label className="field">
          <span>소속지부 / 부서</span>
          <input value={form.organization} onChange={(event) => setForm({ ...form, organization: event.target.value })} placeholder="대한법률구조공단 / 전산" />
        </label>
      )}
      {lockContactFields ? <p className="helperText">이메일과 소속기관·부서는 가입 시 등록된 정보로 고정되며 본인이 변경할 수 없습니다. 변경이 필요하면 관리자에게 문의해주세요.</p> : null}
      <label className="field">
        <span>연락처</span>
        <input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} type="tel" placeholder="010-0000-0000" />
      </label>
      <div className="formGrid">
        <label className="field">
          <span>새 비밀번호</span>
          <input value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} type="password" placeholder="변경할 때만 입력" />
        </label>
        <label className="field">
          <span>새 비밀번호 확인</span>
          <input value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} type="password" placeholder="비밀번호 확인" />
        </label>
      </div>
      {mismatch ? <p className="formError">비밀번호와 비밀번호 확인이 일치하지 않습니다.</p> : null}
      {message ? <p className={message.includes('저장') ? 'helperText success' : 'formError'}>{message}</p> : null}
      <button className="primaryButton" type="button" onClick={save}>프로필 수정 저장</button>
    </section>
  );
}

function UtilityPanel({ view, role, consultations, onCreateConsultation, onRequestLegalReview, onAnalysisSaved, onUpdateConsultation, currentUser, onUpdateProfile, notifications, onReadNotifications, onDeleteNotification, onOpenNotification, onGoToDashboard, onNotify, onDocumentReviewDecision, focusedConsultationId, onOpenConsultationForm, onOpenAnalysis }) {
  // '상담 등록'은 상담원 고유 업무입니다. 다른 역할에서 실수로 activeView가 넘어와도
  // 접수 화면이 열리지 않도록 역할을 한 번 더 확인합니다. (네비게이션 메뉴 구성과 이중 방어)
  if (view === '상담 등록') return role === 'counselor' ? <UploadWorkbench onCreateConsultation={onCreateConsultation} onGoToRealtimeAnalysis={() => onOpenAnalysis?.()} /> : <ProfilePanel role={role} currentUser={currentUser} onUpdateProfile={onUpdateProfile} />;
  if (view === '법률, 판례') return <SearchWorkbench consultations={consultations} />;
  if (view === '서식 생성') return (
    <DraftWorkbench
      consultations={consultations}
      currentUser={currentUser}
      role={role}
      onUpdateConsultation={onUpdateConsultation}
      onNotify={onNotify}
      onDocumentReviewDecision={onDocumentReviewDecision}
      focusedConsultationId={focusedConsultationId}
    />
  );
  if (view === '알림') return <NotificationPanel role={role} currentUser={currentUser} notifications={notifications} onReadNotifications={onReadNotifications} onDeleteNotification={onDeleteNotification} onOpenNotification={onOpenNotification} />;
  if (view === '기타' && role === 'lawyer') return <ProfilePanel role={role} currentUser={currentUser} onUpdateProfile={onUpdateProfile} />;
  if (view === '기타') return <AnalysisWorkbench consultations={consultations} onCreateConsultation={onCreateConsultation} onUpdateConsultation={onUpdateConsultation} onRequestLegalReview={onRequestLegalReview} onAnalysisSaved={onAnalysisSaved} currentUser={currentUser} onGoToDashboard={onGoToDashboard} focusedConsultationId={focusedConsultationId} onGoToUpload={onOpenConsultationForm} />;
  return <ProfilePanel role={role} currentUser={currentUser} onUpdateProfile={onUpdateProfile} />;
}

// ── 아래는 dashboards.jsx(변호사 대시보드의 서식 초안 검토 대기 패널·HITL 모달)가 그대로 가져다 쓰는
// 표시 전용 헬퍼입니다. DraftWorkbench 내부 로직과는 독립적이라, 이 파일의 다른 부분과 상관없이
// 안전하게 export만 유지합니다. ──

// /consult/analyze가 돌려준 구조검토 체크리스트입니다.
// 승소·집행·타당성은 결론이 아니라 '신호'이므로, 판정처럼 보이지 않게 근거 문장 그대로만 둡니다.
function ReliefReviewSummary({ review }) {
  const signals = [
    { label: '승소 가능성', signal: review.winnability },
    { label: '집행 가능성', signal: review.executability },
    { label: '구조 타당성', signal: review.appropriateness },
  ].filter((item) => item.signal?.note);
  return (
    <div className="reliefReviewBox">
      <p className="reliefReviewHead">
        <span className="statusChip tone-info">증빙 {review.evidenceStatusLabel}</span>
        {review.matchedReasons.length ? <span className="reliefReviewReasons">{review.matchedReasons.join(' · ')}</span> : null}
      </p>
      {review.judgmentNote ? <p className="reasonText">판정 근거: {review.judgmentNote}</p> : null}
      {signals.length ? (
        <dl className="reliefSignalList">
          {signals.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.signal.note}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {review.lawyerSummary ? <p className="reliefLawyerSummary">변호사 검토 요약: {review.lawyerSummary}</p> : null}
    </div>
  );
}

// 서식 초안 검토 상태(DocumentReviewStatus, backend/core-api)를 화면에 보여줄 라벨/톤으로 바꿉니다.
const DOCUMENT_STATUS_LABEL = {
  DRAFTED: '초안 작성됨 (검토 요청 전)',
  SUBMITTED_FOR_REVIEW: '변호사 검토 요청됨',
  APPROVED: '변호사 승인 완료',
  REVISION_REQUESTED: '반려됨 (수정 필요)',
};
function documentStatusTone(status) {
  if (status === 'APPROVED') return 'success';
  if (status === 'REVISION_REQUESTED') return 'danger';
  if (status === 'SUBMITTED_FOR_REVIEW') return 'info';
  return 'muted';
}

function resolveGeneratedFileHref(path = '') {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  if (/^blob:/i.test(path)) return path;
  if (path.startsWith('/')) return path;
  return '';
}

function generatedFileName(path = '') {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).at(-1) || path;
}

function escapePreviewHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// label을 넘기면 그 문구를 표시 이름으로 쓰고(예: '조정신청서 초안 파일'), 안 넘기면 예전처럼
// 실제 저장 파일명을 그대로 보여줍니다. 서버가 생성하는 파일명은 사람이 알아보기 어려운 무작위
// 식별자라, 변호사 검토 화면처럼 이미 서식명을 알고 있는 곳에서는 label로 바꿔 보여주는 게 낫습니다.
// consultationId+documentId를 넘기면(=core-api에 실제 저장된 문서) 새로 생긴 다운로드 API로
// 진짜 파일을 받는 링크를 만듭니다. 없으면(로컬 전용 문서) 예전처럼 draft_file_path 자체를
// 링크로 쓸 수 있는지만 확인합니다(blob: URL 등).
function escapePreviewAttribute(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildDraftContentPreviewHtmlWithFile(content = '', title = '', options = {}) {
  if (!content) return '';
  const safeTitle = escapePreviewHtml(title || '서식 초안 미리보기');
  const safeContent = escapePreviewHtml(content);
  const safeFileName = escapePreviewHtml(options.fileName || '생성 파일');
  const safeDownloadUrl = options.downloadUrl ? escapePreviewAttribute(options.downloadUrl) : '';
  const safePreviewUrl = options.previewUrl ? escapePreviewAttribute(options.previewUrl) : '';
  const fileActions = safeDownloadUrl || safePreviewUrl
    ? `<section class="filebox"><div class="filebox-head"><strong>생성 파일</strong><span>${safeFileName}</span></div><div class="filebox-actions">${safePreviewUrl ? `<a class="ghost" href="${safePreviewUrl}" target="_blank" rel="noreferrer">미리보기</a>` : ''}${safeDownloadUrl ? `<a class="primary" href="${safeDownloadUrl}" download="${safeFileName}">다운로드</a>` : ''}</div></section>`
    : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${safeTitle}</title><style>body{margin:0;padding:32px;font-family:Apple SD Gothic Neo,Malgun Gothic,sans-serif;background:#f6f8fb;color:#1f2937}main{max-width:960px;margin:0 auto;background:#fff;border:1px solid #d8e1eb;border-radius:16px;padding:32px;box-shadow:0 12px 30px rgba(15,23,42,.08)}h1{margin:0 0 20px;font-size:24px}.filebox{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px 20px;margin:0 0 24px;border:1px solid #d8e1eb;border-radius:12px;background:#f8fbff}.filebox-head{display:flex;flex-direction:column;gap:6px}.filebox-actions{display:flex;gap:10px;flex-wrap:wrap}.filebox-actions a{text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:700}.filebox-actions .ghost{border:1px solid #9fb7d3;color:#204d7a;background:#fff}.filebox-actions .primary{background:#204d7a;color:#fff}pre{white-space:pre-wrap;word-break:break-word;line-height:1.8;font-size:15px;margin:0}</style></head><body><main><h1>${safeTitle}</h1>${fileActions}<pre>${safeContent}</pre></main></body></html>`;
}


function parseDownloadFileName(headerValue = '') {
  const encodedMatch = headerValue.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      return encodedMatch[1];
    }
  }

  const quotedMatch = headerValue.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) return quotedMatch[1];

  const plainMatch = headerValue.match(/filename=([^;]+)/i);
  return plainMatch?.[1]?.trim() || '';
}

function isFileDownloadResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  return !contentType.includes('application/json') && !contentType.includes('text/json');
}

async function downloadServerDocument(url, fallbackFileName) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`다운로드 실패 (${response.status})`);
  }
  if (!isFileDownloadResponse(response)) {
    throw new Error('서버가 파일 대신 오류 응답을 보냈습니다.');
  }

  const blob = await response.blob();
  if (!blob.size) {
    throw new Error('빈 파일 응답입니다.');
  }

  const fileName = parseDownloadFileName(response.headers.get('content-disposition') || '')
    || fallbackFileName
    || 'document.hwpx';
  const objectUrl = window.URL.createObjectURL(blob);

  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 300000);
  }
}

function ServerDocumentDownloadButton({ url, fileName, className = '' }) {
  if (!url) return null;
  return (
    <span className="serverDocumentDownload">
      <a
        className={className || undefined}
        href={url}
        download={fileName || true}
      >
        다운로드
      </a>
    </span>
  );
}

function GeneratedFileLink({ path, label, consultationId, documentId, content, downloadFileName }) {
  if (!path && !content) return null;

  const downloadUrl = consultationId && documentId
    ? buildCoreDocumentDownloadUrl(consultationId, documentId)
    : '';
  const rawFileName = label || downloadFileName || generatedFileName(path) || '\uC0DD\uC131 \uD30C\uC77C';
  const safeFileName = rawFileName.includes('?') ? '\uC0DD\uC131 \uD30C\uC77C' : rawFileName;

  if (downloadUrl) {
    return (
      <div className="generatedFileInline">
        <span>{safeFileName}</span>
        <ServerDocumentDownloadButton url={downloadUrl} fileName={safeFileName} />
      </div>
    );
  }

  if (content) {
    return (
      <div className="generatedFileInline">
        <span>{safeFileName}</span>
        <code>서버 파일 없음</code>
      </div>
    );
  }

  return (
    <div className="generatedFileInline">
      <span>{safeFileName}</span>
      <code>{path}</code>
    </div>
  );
}

function DraftContentReviewLabel({ content }) {
  if (!content) return null;
  return <span className="generatedFileInline">{'\uBCF8\uBB38 \uCD08\uC548 \uAC80\uD1A0'}</span>;
}

function normalizeGeneratedDocument(response = {}) {
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

// ai-api를 직접 호출해 만든 초안은 core-api에 저장된 documentId가 없으므로, 브라우저 쪽에서만
// 통하는 로컬 키를 만들어 같은 카드/버튼 로직을 그대로 쓸 수 있게 합니다.
function normalizeAiGeneratedDocument({ response, consultation, templateName }) {
  const localKey = `ai-draft-${consultation?.id || 'case'}-${Date.now()}`;
  return normalizeGeneratedDocument({
    local_key: localKey,
    document_id: localKey,
    consultation_id: consultation?.id || '',
    status: 'DRAFTED',
    form_name: templateName,
    requested_form_name: response?.requested_form_name || '',
    draft_file_path: response?.file || '',
    source: 'ai-api-local',
  });
}

// core-api·ai-api 둘 다 응답을 못 주는 최후의 경우, 지금까지 화면에 쓰던 초안 본문 텍스트로
// 브라우저에서 즉석 HWPX 미리보기 파일을 만들어 검토 요청 흐름이 끊기지 않게 합니다.
function createClientHwpxReviewDocument({ consultation, templateName, draftContent }) {
  const localKey = `client-hwpx-${consultation?.id || 'case'}-${Date.now()}`;
  return normalizeGeneratedDocument({
    local_key: localKey,
    document_id: localKey,
    consultation_id: consultation?.id || '',
    status: 'DRAFTED',
    form_name: templateName,
    draft_file_path: '',
    download_file_name: '',
    draft_content: draftContent,
    source: 'server-missing',
  });
}

function draftGenerationErrorMessage(error) {
  const detail = error?.message ? ` (${error.message})` : '';
  return `HWPX 초안 생성에 실패했습니다${detail}. ai-api 상태와 선택한 서식명을 확인해주세요.`;
}

function draftGenerationFallbackMessage(error) {
  if (error?.message?.includes('서식 파일 없음')) {
    return '원본 서식 파일을 찾지 못해 현재 초안 본문으로 HWPX 파일을 만들었습니다.';
  }
  return `${draftGenerationErrorMessage(error)} 현재 초안 본문으로 검토 요청을 계속할 수 있습니다.`;
}

function buildAiDraftPayload({ templateName, consultation, analysis }) {
  const resolvedTemplateName = resolveHwpxTemplateName(templateName);
  return {
    form_name: resolvedTemplateName,
    requested_form_name: templateName,
    extracted: {
      ...(analysis?.extractedJson || {}),
      상담자: consultation?.name || '',
      상대방: consultation?.opponentName || '',
      사건명: consultation?.title || '',
      사건유형: analysis?.caseSubtype || analysis?.caseType || consultation?.type || '',
      누락자료: analysis?.missingInfo || [],
    },
    summary: analysis?.summary || consultation?.memo || consultation?.title || '',
  };
}

// consultationId를 넘기고 document가 core-api에 실제 저장된 것(source: 'core-api')이면 실제
// 다운로드 API(.../documents/{id}/download, GeneratedDocumentController)로 진짜 파일을 받는
// 버튼을 보여줍니다. 이 경우는 항상 다운로드로 응답하도록 백엔드가 고정돼 있어
// (Content-Disposition: attachment) '미리보기'는 의미가 없으므로 다운로드 버튼만 둡니다.
//
// 로컬 전용 문서(ai-api-local/text-local/client-hwpx)는 draftFilePath 자체가 브라우저 blob: URL인
// 경우가 있는데, blob: URL은 그 blob을 만든 "이 페이지 세션"에서만 유효하고 새로고침하거나 나중에
// 다시 열면(변호사 검토 요청 후 다른 시점에 다시 여는 경우 등) 이미 죽어 있어 다운로드가
// "사이트에서 사용할 수 없는 파일" 오류로 항상 실패합니다. 그래서 draftContent(초안 본문 텍스트,
// localStorage에 같이 저장돼 세션이 바뀌어도 남아있음)가 있으면 옛 blob을 재사용하지 않고 매번
// 새로 HWPX를 만들어(createClientHwpxDraft) 항상 살아있는 다운로드 링크를 보장합니다.
// draftContent조차 없을 때만(구버전에 저장된 문서 등) 예전 filePath를 그대로 시도합니다.
function GeneratedFileBox({ document, consultationId }) {
  const filePath = document?.draftFilePath || '';
  const downloadUrl = document?.source === 'core-api' && consultationId && document?.documentId
    ? buildCoreDocumentDownloadUrl(consultationId, document.documentId)
    : '';
  const fileName = document?.downloadFileName || generatedFileName(filePath);
  const draftContent = '';

  const [clientDraft, setClientDraft] = useState(null);
  useEffect(() => {
    if (downloadUrl || !draftContent) {
      setClientDraft(null);
      return undefined;
    }
    const templateName = (document?.formName || fileName || '서식초안').replace(/\.hwpx$/i, '');
    const generated = createClientHwpxDraft({ templateName, draftText: draftContent });
    setClientDraft(generated);
    return () => window.URL.revokeObjectURL(generated.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadUrl, draftContent, document?.formName]);

  // 우선순위: 백엔드 실제 다운로드 URL > 방금 새로 만든 클라이언트 blob > (draftContent가 아예
  // 없을 때만) 예전 filePath 그대로. staticHref는 blob:일 수도 있어 마지막 순위로만 씁니다.
  const staticHref = resolveGeneratedFileHref(filePath);
  const href = downloadUrl;
  const effectiveHref = href || clientDraft?.url || '';
  const effectiveFileName = fileName || clientDraft?.fileName || '';

  return (
    <div className="generatedFileBox">
      <div className="generatedFileHeader">
        <strong>생성 파일</strong>
        {effectiveHref ? (
          <div className="generatedFileActions">
            <ServerDocumentDownloadButton
              className="primaryButton compactAction"
              url={effectiveHref}
              fileName={effectiveFileName || 'document.hwpx'}
            />
          </div>
        ) : null}
      </div>
      {filePath ? (
        <>
          <span>
            {effectiveFileName || '생성된 HWPX 파일'}
            {href
              ? '을 다운로드할 수 있습니다.'
              : clientDraft
                ? (filePath.startsWith('blob:')
                  ? '은 브라우저에서 새로 만들어 다운로드할 수 있습니다.'
                  : '은 백엔드 경로로 생성되었고, 브라우저에서 만든 사본을 다운로드할 수 있습니다.')
                : '은 백엔드 경로로 생성되었습니다.'}
          </span>
          {!href && !clientDraft ? <button type="button" disabled>다운로드 URL 미제공</button> : null}
          {!href && !filePath.startsWith('blob:') ? <code className="generatedFilePath">{filePath}</code> : null}
        </>
      ) : (
        <>
          <span>{document?.draftContent ? 'HWPX 파일 없이 화면의 초안 본문으로 검토 요청할 수 있습니다.' : '서식 생성 서버가 파일을 만들어 주면 여기에 다운로드 버튼이 나타납니다.'}</span>
          <button type="button" disabled>아직 생성된 파일 없음</button>
        </>
      )}
    </div>
  );
}

export { UtilityPanel, ReliefReviewSummary, DOCUMENT_STATUS_LABEL, documentStatusTone, GeneratedFileLink, DraftContentReviewLabel };
