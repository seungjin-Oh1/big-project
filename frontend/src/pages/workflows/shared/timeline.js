// 상담 원문과 AI 결과를 상담원·변호사 화면에서 같은 규칙으로 타임라인화합니다.

const DATE_PATTERN = /(?:(?:19|20)\d{2}\s*년\s*)?\d{1,2}\s*월\s*\d{1,2}\s*일|\b(?:19|20)\d{2}[-./]\d{1,2}[-./]\d{1,2}\b|\b\d{1,2}[-./]\d{1,2}\b|\b(?:19|20)\d{2}\s*년/g;
const EVENT_KEYWORDS = /사망|장례|상속|재산|채무|계좌|자료|증빙|요청|신청|접수|예약|제출|확인|계약|소송|판결|진단|치료|사고|입원|퇴원|해고|근무|지급|발급|협의|조정|기한|등기|부동산|유언|상환|변제|신고|조사/;
const BIRTH_DATE_KEYWORDS = /생년월일|출생|태어났|태어난|만\s*\d+\s*세/;

// 타임라인은 통화 대본이 아니라 사건 진행을 빠르게 훑는 용도입니다. 대화체 원문에서
// 법률 절차·자료·재산 관련 이정표만 골라 짧은 사건 언어로 바꿉니다.
function summarizeCaseMilestones(text = '') {
  const source = String(text).replace(/\s+/g, ' ').trim();
  const labels = [];
  const add = (condition, label) => {
    if (condition && !labels.includes(label)) labels.push(label);
  };

  const hasFuneralAndReport = /장례/.test(source) && /사망신고/.test(source);
  add(hasFuneralAndReport, '장례 및 사망신고 완료');
  add(!hasFuneralAndReport && /사망신고/.test(source), '사망신고');
  add(!hasFuneralAndReport && /장례/.test(source), '장례 절차');
  add(/상속포기[^.!?]*?(신청|접수|제출)/.test(source), '상속포기 신청');
  add(/상속포기/.test(source) && !/상속포기[^.!?]*?(신청|접수|제출)/.test(source), '상속포기 검토');
  add(/상속[^.!?]*?(절차|개시|진행|알아보기|확인)/.test(source), '상속 절차 확인');
  add(/금융거래조회[^.!?]*?(신청|접수)/.test(source), '금융거래조회 신청');
  add(/금융거래조회/.test(source) && !/금융거래조회[^.!?]*?(신청|접수)/.test(source), '금융거래조회 확인');
  const hasEvidenceRequest = /(?:증빙|자료|서류)[^.!?]*?(요청|부탁|보내\s*달라|제출\s*해\s*달라)/.test(source);
  add(hasEvidenceRequest, '증빙자료 요청');
  add(!hasEvidenceRequest && /(?:증빙|자료|서류)[^.!?]*?(제출|보냈|접수)/.test(source), '증빙자료 제출');
  add(/(?:증빙|자료|서류)[^.!?]*?(준비|챙기)/.test(source), '증빙자료 준비');
  add(/(?:계좌|거래내역)[^.!?]*?(확인|조회)/.test(source), '계좌·거래내역 확인');
  add(/부동산[^.!?]*?(확인|조회|평가|등기)/.test(source), '부동산 현황 확인');
  add(/(?:채무|채권)[^.!?]*?(확인|조사|상환|변제)/.test(source), '채무·채권 확인');
  add(/법원[^.!?]*?(신청|제출|접수)/.test(source), '법원 절차 진행');
  add(/(?:소송|조정)[^.!?]*?(신청|제출|진행)/.test(source), '분쟁 절차 진행');
  add(/(?:입원|치료|진단)[^.!?]*?(시작|진행|확인|받)/.test(source), '치료·진단 진행');

  return labels.slice(0, 2).join(' · ');
}

function compactTimelineText(text = '') {
  const milestoneSummary = summarizeCaseMilestones(text);
  if (milestoneSummary) return milestoneSummary;

  const withoutDate = String(text)
    .replace(DATE_PATTERN, '')
    .replace(/\s+/g, ' ')
    .replace(/^(네|예|아|그리고|그런데|다만|오늘|현재|제가|저는)\s*[,.]?\s*/u, '')
    .replace(/^(?:은는이가을를에의|부터)\s*/u, '')
    .trim();
  if (!withoutDate) return '';

  const clauses = withoutDate
    .split(/(?<=[.!?。！？])\s+|(?<=,|，)\s*(?=그리고|그런데|다만|이후|또는|또)/u)
    .map((clause) => clause.replace(/[.!?。！？]+$/u, '').trim())
    .filter(Boolean);
  const eventClauses = clauses.filter((clause) => EVENT_KEYWORDS.test(clause));
  const selected = (eventClauses.length ? eventClauses : clauses).slice(0, 1).join(' ');
  if (!EVENT_KEYWORDS.test(selected) && selected.replace(/[.·\s]/g, '').length < 8) return '';
  return selected.length > 72 ? `${selected.slice(0, 69).trim()}…` : selected;
}

function isLikelyPersonalDate(text = '', rawDate = '') {
  const source = String(text).replace(/\s+/g, ' ').trim();
  const year = Number(String(rawDate).match(/(?:19|20)\d{2}/)?.[0]);
  const isStandaloneDateAnswer = /^\D*(?:(?:19|20)\d{2}\s*년\s*)?\d{1,2}\s*월\s*\d{1,2}\s*일(?:입니다|이에요)?\D*$/u.test(source);
  return BIRTH_DATE_KEYWORDS.test(source)
    || (isStandaloneDateAnswer && year > 0 && year <= new Date().getFullYear() - 18 && !EVENT_KEYWORDS.test(source));
}

export function formatTimelineItems(items = []) {
  const rows = Array.isArray(items) ? items : [];
  const explicitYear = rows
    .map((item) => String(item?.date || item?.날짜 || ''))
    .map((value) => value.match(/\b((?:19|20)\d{2})\s*년|\b((?:19|20)\d{2})[-./]/))
    .find(Boolean);
  let inferredYear = Number(explicitYear?.[1] || explicitYear?.[2]) || new Date().getFullYear();

  const formatted = rows.map((item, index) => {
    const rawDate = String(item?.date || item?.날짜 || '');
    const rawText = typeof item === 'string' ? item : String(item?.text || item?.내용 || item?.description || '');
    if (isLikelyPersonalDate(rawText, rawDate)) return null;
    const text = compactTimelineText(rawText);
    const koreanDate = rawDate.match(/(?:((?:19|20)\d{2})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    const numericDate = rawDate.match(/\b((?:19|20)\d{2})[-./](\d{1,2})[-./](\d{1,2})\b/);
    const shortNumericDate = rawDate.match(/\b(\d{1,2})[-./](\d{1,2})\b/);
    const yearOnlyDate = rawDate.match(/\b((?:19|20)\d{2})\s*년/);
    const year = Number(koreanDate?.[1] || numericDate?.[1] || yearOnlyDate?.[1] || inferredYear);
    const month = Number(koreanDate?.[2] || numericDate?.[2] || shortNumericDate?.[1]);
    const day = Number(koreanDate?.[3] || numericDate?.[3] || shortNumericDate?.[2]);
    if (koreanDate?.[1] || numericDate?.[1] || yearOnlyDate?.[1]) inferredYear = year;
    const hasSpecificDate = Number.isInteger(month) && Number.isInteger(day);
    const hasYearOnlyDate = Boolean(yearOnlyDate?.[1]) && !hasSpecificDate;
    return {
      date: hasSpecificDate ? `${year}년 ${month}월 ${day}일` : (hasYearOnlyDate ? `${year}년` : (rawDate || '날짜 미확인')),
      dateKey: hasSpecificDate ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : (hasYearOnlyDate ? `${year}-year-${index}` : `unknown-${index}`),
      text,
      // 월·일이 없는 연도 사건은 그 해의 시작 시점으로 정렬합니다. 표기는 '2023년'으로
      // 남겨 사실관계에 없는 월·일을 만들어 내지 않습니다.
      timestamp: hasSpecificDate ? new Date(year, month - 1, day).getTime() : (hasYearOnlyDate ? new Date(year, 0, 1).getTime() : Number.POSITIVE_INFINITY),
      index,
    };
  }).filter((item) => item?.text).sort((left, right) => left.timestamp - right.timestamp || left.index - right.index);

  // 같은 날짜에 여러 문장이 있으면 한 줄로 묶어 타임라인을 압축합니다.
  return formatted.reduce((merged, item) => {
    const previous = merged[merged.length - 1];
    if (previous?.dateKey === item.dateKey) {
      const texts = new Set([...(previous.text ? [previous.text] : []), ...(item.text ? [item.text] : [])]);
      const combined = [...new Set([...texts].flatMap((text) => text.split(' · ')))].slice(0, 2).join(' · ');
      previous.text = combined.length > 96 ? `${combined.slice(0, 93).trim()}…` : combined;
      return merged;
    }
    merged.push({ ...item });
    return merged;
  }, []);
}

export function buildTimelineFromTranscript(text = '') {
  const source = String(text || '').replace(/[ \t]+/g, ' ').trim();
  if (!source) return [];
  const sentences = source.split(/(?<=[.!?。！？])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
  return sentences.flatMap((sentence, sentenceIndex) => {
    DATE_PATTERN.lastIndex = 0;
    const matches = sentence.match(DATE_PATTERN) || [];
    return matches
      .filter((match) => !isLikelyPersonalDate(sentence, match))
      .map((match, matchIndex) => ({
      date: match,
      text: sentence,
      source: 'transcript',
      index: sentenceIndex * 100 + matchIndex,
      }));
  });
}

export function isPlaceholderTimeline(items = []) {
  return !items.length || items.every((item) => {
    const text = typeof item === 'string' ? item : item?.text || item?.내용 || '';
    return text === '상담 접수 및 인공지능 분석 후보 생성';
  });
}

export function resolveTimelineForDisplay(analysis = {}, transcript = '') {
  const aiTimeline = Array.isArray(analysis?.timeline) ? analysis.timeline : [];
  return isPlaceholderTimeline(aiTimeline) ? buildTimelineFromTranscript(transcript) : aiTimeline;
}
