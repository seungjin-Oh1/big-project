# 대한법률구조공단 상담 지원 포털 Frontend

상담원이 상담을 접수하고 AI 분석 결과를 확인한 뒤, 서식 초안을 생성해 변호사에게 검토 요청하는 업무 흐름을 제공하는 React 프론트엔드입니다. 변호사는 별도 서식 생성 없이 `검토` 대시보드에서 법률구조 검토와 서식 초안 검토를 함께 처리합니다.

## 실행

```bash
npm install
npm run dev
npm run build
npm run lint
```

- 개발 서버 기본 주소: `http://localhost:5173`
- 기술 스택: React 19, Vite, lucide-react, CSS 디자인 토큰
- 테스트 계정: 로그인 화면의 `테스트용 빠른 로그인`에서 상담원, 변호사, 관리자 역할을 바로 선택할 수 있습니다.

## 주요 폴더

```text
src/
├── App.jsx                     앱 전역 상태, 로그인/역할별 대시보드 전환
├── components/
│   ├── layout.jsx              상단 헤더, 역할별 메뉴, 사용자 배지
│   ├── common.jsx              표, 요약 카드, 달력, 공용 모달
│   ├── loading.jsx             비동기 작업 로딩 오버레이
│   └── feedback.jsx            토스트, 확인창
├── pages/
│   ├── auth.jsx                로그인, 회원가입, 비밀번호 찾기
│   ├── dashboards.jsx          상담원/변호사/관리자 대시보드
│   └── workflows.jsx           상담 등록, 실시간 분석 AI, 법률·판례, 서식 생성/검토
├── services/
│   ├── coreApiClientV2.js      core-api 연동 클라이언트
│   ├── aiApiClient.js          ai-api 연동 클라이언트
│   ├── clientHwpxGenerator.js  브라우저 HWPX 대체 생성
│   ├── documentReviewStore.js  로컬 서식 검토 요청 저장/복원
│   ├── draftDocumentStore.js   생성 서식 문서 상태 보정
│   ├── legalAidApi.js          목업/연동 전환용 업무 API 유틸
│   ├── s3UploadClient.js       업로드 연동 클라이언트
│   └── storage.js              localStorage 기반 로컬 데이터 저장
├── data/                       사건 분류, 지부, 서식 시드
├── utils/                      날짜, 상태 색상 유틸
└── styles/global.css           전역 UI 디자인
```

## 역할별 화면

### 상담원

- `상담 현황`: 상담 목록, 일정별 상담, 보완 요청 확인
- `상담 문서 업로드`: 상담자 정보, 사건 분류, 상담 내용, 첨부자료 등록
- `실시간 분석 AI`: 통화/STT 연결을 대비한 실시간 상담 보조 화면
- `법률, 판례`: 상담 분석 기반 법령·판례·유사사례 확인
- `서식 생성`: 상담원이 서식을 선택하고 초안 본문을 저장한 뒤 변호사 검토를 요청

### 변호사

- `검토`: 법률구조 검토 요청과 서식 초안 검토 대기를 한 화면에서 처리
- `법률, 판례`: 검토 중인 사건 기준 참고자료 확인
- 변호사는 서식을 직접 생성하지 않고, 상담원이 제출한 초안을 다운로드/승인/반려합니다.

### 관리자

- `운영 현황`: 상담 통계, 사용자 현황, 분석 처리 현황
- `운영 관리`: 감사 로그, 계정 승인, 백엔드 연결 상태 점검

## 서식 초안 생성/검토 흐름

1. 상담원이 `서식 생성`에서 사건과 서식을 선택합니다.
2. 프론트는 `core-api`와 `ai-api`를 통해 HWPX 초안 생성을 요청합니다.
3. 생성된 문서 정보는 상담원 화면에 표시되고, `다운로드` 버튼으로 HWPX 파일을 받을 수 있습니다.
4. 상담원이 `변호사 검토 요청`을 누르면 문서 상태가 검토 대기로 바뀝니다.
5. 변호사는 `검토` 대시보드의 `서식 초안 검토 대기`에서 제출된 초안을 확인합니다.
6. 변호사는 초안을 다운로드하고 `승인` 또는 `반려`를 처리합니다.
7. 반려 시 상담원에게 보완 요청 알림과 사유가 전달됩니다.

## 백엔드 연동 현황

프론트는 Vite 프록시를 통해 백엔드와 통신합니다.

| 대상 | 프론트 파일 | 상태 |
|---|---|---|
| core-api 상담/분석/서식 저장 | `src/services/coreApiClientV2.js` | 연동 완료 |
| core-api 서식 파일 다운로드 URL | `buildCoreDocumentDownloadUrl` | `/api/consultations/{consultationId}/documents/{documentId}/download` 사용 |
| ai-api HWPX 생성 요청 | `src/services/aiApiClient.js` | 연동 및 실패 폴백 처리 |
| 브라우저 HWPX 대체 생성 | `src/services/clientHwpxGenerator.js` | 백엔드 실패 시 대체 생성 |
| 서식 검토 요청 로컬 복원 | `documentReviewStore.js`, `draftDocumentStore.js` | core-api 누락/실패 시 화면 유지 보조 |

## 이번 백엔드 작업 내용

이번 PR에는 서식 초안 다운로드를 위해 `backend/core-api`의 문서 파트도 함께 포함되어 있습니다.

```text
backend/core-api/src/main/java/com/aivle/bigproject/document/GeneratedDocumentController.java
backend/core-api/src/main/java/com/aivle/bigproject/document/GeneratedDocumentService.java
```

- `GET /api/consultations/{consultationId}/documents/{documentId}/download` 엔드포인트 추가
- `GeneratedDocumentService.loadDraftFile(...)` 추가
- DB에 저장된 `draftFilePath`의 실제 파일을 `FileSystemResource`로 스트리밍
- 파일이 없거나 경로가 비어 있으면 404 반환
- `Content-Disposition: attachment` 헤더로 브라우저 다운로드 처리
- `backend/ai-api/.env`는 열람하지 않았고 수정하지 않았습니다.

## UI/UX 변경 요약

- 전체 디자인을 `DESIGN.md` 기준의 밝은 공공서비스 스타일로 재정리
- 상담원, 변호사, 관리자 대시보드 최대 폭 확장 및 좌우 폭 균형 조정
- 표 안의 버튼, 상태 칩, 검색 입력 높이와 글자 크기 통일
- 글자가 세로로 쪼개지거나 잘리지 않도록 표 컬럼과 줄바꿈 규칙 보정
- 변호사 메뉴에서 `서식 검토`를 제거하고 `검토`로 통합
- 변호사는 서식 생성 UI 없이 제출된 서식 검토만 가능하도록 역할 분리
- 실시간 분석 AI 화면에서 상담받은 사람 입력 필요성을 강조
- 달력 버튼은 원형이 아닌 사각형 UI로 정리

## 작업 시 주의사항

- 프론트 작업은 `frontend` 폴더 안에서 진행합니다.
- `backend/ai-api/.env`는 API 키가 있으므로 열람하지 않습니다.
- 백엔드 추가 수정이 없다면 이후 커밋은 `git add frontend`만 사용하면 됩니다.
- 이미 푸시된 브랜치: `feature/frontend-ui-clean`
- PR 대상 저장소: `seungjin-Oh1/big-project`
