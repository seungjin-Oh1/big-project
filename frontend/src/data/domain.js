// 대한법률구조공단 전국 18개 지부 (본부 산하 지역 관할 조직). 상담원/변호사 회원가입 시
// 소속 지부를 선택하도록 하고, 이후 화면 곳곳에서 소속을 함께 보여주는 데 사용합니다.
export const legalAidBranchOffices = [
  '서울중앙지부',
  '서울동부지부',
  '서울남부지부',
  '서울북부지부',
  '서울서부지부',
  '의정부지부',
  '인천지부',
  '수원지부',
  '춘천지부',
  '대전지부',
  '청주지부',
  '대구지부',
  '부산지부',
  '울산지부',
  '창원지부',
  '광주지부',
  '전주지부',
  '제주지부',
];

export const attachmentTypes = [
  { key: 'transcript', label: '녹취록', storageBucket: 'consultation-recordings' },
  { key: 'idCard', label: '신분증', storageBucket: 'identity-documents' },
  { key: 'evidence', label: '증빙자료', storageBucket: 'evidence-documents' },
  { key: 'draft', label: '생성 서식', storageBucket: 'generated-documents' },
];

// ── 사건 분류 (가사법 4대 분류) ──
//
// 팀에서 서비스 범위를 가사법 4대 분류로 확정했고,
// 연결된 서식 폴더(서식_친족_상속_가사소송_가족관계등록)의 실제 하위 폴더 구조와 같습니다.
// 대분류(친족/상속/가사소송/가족관계등록) 안에 소분류를 두는 2단계 구조이며,
// 상담 등록 · 분석 · 통계 · 서식 필터가 모두 이 하나의 기준을 씁니다.
//
// 백엔드 계약(backend/ai-api/app/schemas/analysis.py)의 CaseType · CaseSubtype과 같은 값이어야 합니다.
// 한쪽만 바뀌면 서식 추천과 통계가 조용히 어긋나므로, 값을 고칠 때는 반드시 양쪽을 함께 고칩니다.
export const caseCategories = [
  {
    key: '친족',
    subTypes: [
      '약혼', '혼인의 성립, 무효, 취소', '협의이혼', '재판상이혼 등',
      '이혼 및 위자료', '이혼 및 재산분할청구권', '양육비', '면접교섭권',
      '입양, 파양, 친양자', '친권', '후견인', '부양',
    ],
  },
  {
    key: '상속',
    subTypes: ['상속일반', '상속분', '상속재산분할', '유언', '유류분'],
  },
  {
    key: '가사소송',
    subTypes: [
      '가사소송일반', '가,나,다류 가사소송', '라,마류 가사비송',
      '양육비직접지급명령', '이행명령', '과태료와 감치', '기타',
    ],
  },
  {
    key: '가족관계등록',
    subTypes: ['신고', '국적의 취득과 상실', '성본창설과 개명', '가족관계등록창설', '가족관계등록부정정'],
  },
];

// 소분류(caseType) -> 대분류(caseCategory) 조회용 헬퍼입니다. (통계 집계, 배지 표시 등에 사용)
// 아는 분류에 없으면 '기타'로 모아, 어떤 상담도 통계에서 사라지지 않게 합니다.
export function getCaseCategory(caseType) {
  const found = caseCategories.find((category) => category.subTypes.includes(caseType));
  return found?.key || '기타';
}

// AI가 돌려준 사건 유형이 이 분류 체계(대분류 4개 · 소분류 29개)에 실제로 있는 값인지 확인합니다.
// 백엔드 파이프라인이 다른 유형 집합을 돌려주는 경우가 있는데,
// 그때 모르는 값을 아는 척 넘기면 엉뚱한 서식이 연결되고 초안 본문에도 그대로 박힙니다.
// '모른다'를 명시적으로 판별해, 화면이 사용자에게 사실대로 알릴 수 있게 합니다.
export function isKnownCaseType(caseType) {
  if (!caseType) return false;
  return caseCategories.some((category) => category.key === caseType || category.subTypes.includes(caseType));
}

// 연결된 서식 폴더의 기존 hwp 서식을 hwpx로 변환한 기준에 맞춰 구성한 서식 목록입니다.
// (총 291개, src/data/legalTemplateSeed.js) requiredFields는 HWPX 표/셀 파싱 연동 전까지 공통 항목으로 채웠습니다.
export { legalTemplateSeed } from './legalTemplateSeed.js';
