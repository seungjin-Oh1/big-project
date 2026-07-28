# core-api REST API

Base URL: `http://localhost:8080`

현재 구현된 범위: **인증(회원가입/로그인/관리자 승인) / User / Consultation / Attachment / AI_ANALYSIS(+검토워크플로우) / GeneratedDocument(서식 추천·초안·검토워크플로우)**.

`AI_ANALYSIS`는 `contracts/ai_analysis_mock.json` 계약서 필드명과 1:1로 맞춰서 구현했으나,
`case_type` 카테고리 목록·`urgency_level`/`eligibility` 값 표기·`checklist_json` 항목은
아직 팀 회의로 확정 전이라 자유 문자열/JSON으로 열어둔 상태 (값이 나중에 바뀔 수 있음).

인증은 JWT 기반. `Authorization: Bearer <token>` 헤더가 없어도 대부분의 엔드포인트는 아직 통과됩니다
(프론트가 아직 토큰을 보내지 않는 과도기라 `SecurityConfig`에서 의도적으로 열어둠) —
단, 아래 표에 **[역할명]** 표시가 있는 엔드포인트는 실제로 그 역할의 유효한 토큰이 없으면 401/403이 납니다.

모든 요청/응답 Body는 `application/json` (파일 업로드만 `multipart/form-data`).

---

## 공통 에러 응답

`GlobalExceptionHandler`(`common/exception/`)가 아래 형식으로 내려줍니다.

```json
{
  "timestamp": "2026-07-20T05:00:18.393Z",
  "status": 404,
  "error": "Not Found",
  "message": "상담을 찾을 수 없습니다: 999",
  "path": "/api/consultations/999"
}
```

| status | 상황 |
|---|---|
| 400 | 요청 body 파싱 실패 (JSON 형식 오류, 인코딩 오류 등), 필수 입력값 누락(`POST /api/consultations`의 `title`/`clientName`/`userId` 등) |
| 401 | 로그인 실패(이메일/비밀번호 불일치), 토큰 없음/만료 |
| 403 | 가입 승인 대기·거절 계정의 로그인 시도, 역할 권한 부족(예: LAWYER 전용 API를 CONSULTANT 토큰으로 호출) |
| 404 | 경로의 id에 해당하는 리소스 없음 |
| 405 | 해당 경로에 정의되지 않은 HTTP 메서드 호출 |
| 409 | 이미 가입된 이메일, 잘못된 상태 전이(예: 이미 승인된 문서를 다시 승인 시도) |

---

## 인증 (`/api/auth`)

### POST /api/auth/register
회원가입. 성공 시 `201`.

Request
```json
{ "email": "lawyer1@example.com", "password": "pass1234", "name": "김변호", "role": "LAWYER" }
```
- `role`: `"CONSULTANT"` | `"LAWYER"` | `"ADMIN"`

Response
```json
{ "token": null, "userId": 5, "name": "김변호", "role": "LAWYER", "email": "lawyer1@example.com" }
```
- **`ADMIN`은 가입 즉시 `token`이 발급**되지만, **`CONSULTANT`/`LAWYER`는 관리자 승인 전까지 `token: null`**입니다.
  (승인 전에 발급된 토큰으로 승인 절차를 우회하는 걸 막기 위한 조치 — 승인 후 `/login`으로만 실제 토큰을 받을 수 있음)

### POST /api/auth/login
```json
{ "email": "lawyer1@example.com", "password": "pass1234" }
```
Response — 위 register와 동일한 형태, 이번엔 승인된 계정이면 진짜 `token`이 옴.
승인 대기 중이면 `403`, 거절된 계정이면 `403`, 이메일/비밀번호 불일치면 `401`.

---

## User / 관리자 승인 (`/api/users`)

### POST /api/users
상담원 생성 (회원가입 `/api/auth/register`와 별개 경로 — 초기 CRUD 시절부터 있던 엔드포인트, 인증 없이 계정만 만듦).

**개인정보 암호화**: `name`/`email`은 DB엔 AES-GCM으로 암호화되어 저장됩니다(결정론적 암호화라 `email` 중복 체크·로그인 조회는 그대로 작동). API 요청/응답은 항상 평문 — 암호화/복호화는 전부 서버 내부에서 투명하게 처리되고 클라이언트가 신경 쓸 건 없습니다.

### GET /api/users / GET /api/users/{id}
목록/단건 조회.

Response 예시
```json
{
  "id": 5, "name": "김변호", "role": "LAWYER", "email": "lawyer1@example.com",
  "approvalStatus": "PENDING", "createdAt": "...", "updatedAt": "..."
}
```
- `role`: `CONSULTANT` | `LAWYER` | `ADMIN`
- `approvalStatus`: `PENDING` | `APPROVED` | `REJECTED` (`ADMIN`은 가입과 동시에 `APPROVED`)

### GET /api/users/pending **[ADMIN]**
승인 대기 중인 계정 목록.

### POST /api/users/{id}/approve **[ADMIN]** / POST /api/users/{id}/reject **[ADMIN]**
가입 승인/거절. Response — `UserResponse` (approvalStatus 반영됨)

---

## Consultation (`/api/consultations`)

### POST /api/consultations
```json
{ "userId": 1, "title": "임금체불 상담", "clientName": "홍길동", "inputText": "3개월치 임금을 못 받았습니다", "opponentName": "OO상사" }
```
- `userId`: 필수(비어있으면 `400`), 존재하지 않는 id면 `404`
- `title`, `clientName`(내담자 본인 이름 — `opponentName`은 상대방이라 별개): 필수, 비어있으면 `400`
- `inputText`, `opponentName`: 선택
- `status`는 생성 시 무시되고 항상 `RECEIVED`로 시작
- `clientName`은 `User.name`/`email`과 같은 방식으로 DB에 암호화 저장됨(아래 참고)

### GET /api/consultations / GET /api/consultations/{id}
단건 조회는 `attachments` 배열도 같이 내려줌.

```json
{
  "id": 1, "userId": 1, "title": "임금체불 상담", "inputText": "...", "opponentName": "OO상사",
  "status": "RECEIVED", "createdAt": "...", "updatedAt": "...",
  "attachments": [ { "id": 1, "fileName": "rec.txt", "fileType": "음성", "extractedText": null, "uploadedAt": "...", "downloadUrl": "/api/consultations/1/attachments/1" } ]
}
```

### PUT /api/consultations/{id}
부분 수정 — body에 넣은 필드만 갱신. `status`: `RECEIVED` | `ANALYZING` | `COMPLETED` | `HOLD`(보류 — 내담자 연락두절, 추가자료 대기 등으로 상담 자체가 멈춘 상태. 검토워크플로우의 반려와는 별개 개념). `clientName`도 같은 방식으로 부분 갱신 가능. `userId`는 이 엔드포인트로 변경 불가.

### DELETE /api/consultations/{id}
상담 삭제. 딸린 `Attachment`/`AiAnalysis`/`GeneratedDocument`와 디스크 파일도 함께 삭제됨(cascade). Response `204`

---

## Attachment (`/api/consultations/{consultationId}/attachments`)

### POST — `multipart/form-data`
`file`(업로드 파일) + `fileType`(자유 문자열, 예: `"음성"`, `"계약서"`)

Response `201` — `{id, fileName, fileType, extractedText, uploadedAt, downloadUrl}`.
`extractedText`는 STT/OCR 결과용 필드, 업로드 시 항상 `null` (아직 채우는 로직 없음).

### GET /{attachmentId} — 파일 원본 다운로드 (`Content-Disposition: attachment`)
### DELETE /{attachmentId} — 삭제(DB row + 디스크 파일)

---

## AI_ANALYSIS (`/api/consultations/{consultationId}/analyses`)

`contracts/ai_analysis_mock.json` 계약서 필드명과 **1:1 매칭** (요청/응답 JSON은 snake_case). 상담 1건에 여러 번 재분석 가능(1:N, 이력 보존).

### POST /api/consultations/{consultationId}/analyses
```json
{
  "summary": "...", "case_type": "임금체불", "case_subtype": "정기임금 미지급",
  "urgency_level": "중", "eligibility": "대상후보",
  "extracted_json": {}, "missing_info_json": [], "checklist_json": [],
  "recommendation_json": {}, "timeline_json": [], "cluster_result_json": [], "estimated_time": null
}
```
`_json` 필드는 구조 자유(Postgres `jsonb`). Response `201` — 위 + `analysis_id`, `consultation_id`, `created_at`, 검토 관련 필드(아래 참고).

### GET (목록/단건) / PUT (부분수정) / DELETE
기존 Consultation과 같은 패턴.

### 검토 워크플로우 (신규)
상담원이 AI 분석 결과를 확인·수정한 뒤 검토를 요청하고, 변호사가 승인/반려하는 흐름.

| Method | Path | 비고 |
|---|---|---|
| POST | `.../analyses/{analysisId}/submit-for-review` | 상담원. `DRAFTED`/`REVISION_REQUESTED` 상태에서만 가능(그 외 `409`) |
| POST | `.../analyses/{analysisId}/approve` **[LAWYER]** | body `{"note": "..."}`. `SUBMITTED_FOR_REVIEW` 상태에서만(그 외 `409`) |
| POST | `.../analyses/{analysisId}/request-revision` **[LAWYER]** | body `{"note": "..."}` |

응답에 포함되는 검토 관련 필드: `status`(`DRAFTED`/`SUBMITTED_FOR_REVIEW`/`APPROVED`/`REVISION_REQUESTED`), `reviewer_id`, `reviewer_name`, `review_note`, `reviewed_at`.
재제출(`REVISION_REQUESTED` → `submit-for-review`) 시 review 필드는 초기화되고 `SUBMITTED_FOR_REVIEW`로 돌아감.

---

## 서식 추천 · 초안 · 검토 (`/api/consultations/{consultationId}/...`)

ai-api(`:8001`)와 연동. 요청/응답 JSON은 snake_case.

### POST /analyses/{analysisId}/recommend-forms
분석 결과(사건유형 등)를 ai-api `/forms/recommend`에 전달해 서식 후보를 추천받음. **DB에 저장하지 않음** — 상담원이 실제로 고르기 전까지는 확정이 아니라서, 호출할 때마다 ai-api를 다시 불러 최신 결과를 반환.

Response
```json
{
  "recommendations": [ { "rank": 1, "form_name": "이혼 조정신청서", "reason": "..." } ],
  "candidates_count": 102,
  "reason_if_empty": ""
}
```

### POST /analyses/{analysisId}/generate-draft
상담원이 고른 서식으로 ai-api `/forms/draft`를 호출해 실제 초안(`.hwpx`)을 생성하고 `GeneratedDocument`로 저장.

Request `{"form_name": "이혼 조정신청서"}` · Response `201` — 아래 GET 응답과 동일 형태, `status: "DRAFTED"`로 시작

### GET /documents
상담에 생성된 초안 전체 목록.

```json
{
  "document_id": 3, "consultation_id": 8, "form_name": "이혼 조정신청서",
  "recommendation_reason": null, "draft_file_path": "...\\output\\이혼 조정신청서_초안.hwpx",
  "status": "DRAFTED", "reviewer_id": null, "reviewer_name": null,
  "review_note": null, "requested_materials": [], "reviewed_at": null,
  "revision_count": 0, "created_at": "..."
}
```

### 검토 워크플로우
| Method | Path | 비고 |
|---|---|---|
| POST | `/documents/{documentId}/submit-for-review` | 상담원. `REVISION_REQUESTED` 상태에서 호출하면 최신 분석 내용으로 **초안을 재생성**하고 `revision_count` 증가 |
| POST | `/documents/{documentId}/approve` **[LAWYER]** | body `{"note": "..."}` |
| POST | `/documents/{documentId}/request-revision` **[LAWYER]** | body `{"note": "...", "requested_materials": ["소득증빙", "가족관계증명서"]}` |

상태값(`status`)은 AI_ANALYSIS와 동일한 4단계.

---

## 관리자 대시보드 통계 (`/api/admin/stats`) **[ADMIN]**

### GET /api/admin/stats
관리자 대시보드 상단 요약 카드 + 사건유형별 통계 + 분석 처리 현황용 집계 하나로 제공. 목록(표) 데이터는 이 API가 아니라 기존 `GET /api/consultations`, `.../analyses` 등을 따로 호출해야 함.

```json
{
  "total_consultations": 2,
  "active_users": 6,
  "analysis_processing_rate": 1.0,
  "pending_user_approvals": 0,
  "case_type_stats": { "친족": 2 },
  "analysis_status_breakdown": { "approved": 2, "rejected": 0, "pending": 0 }
}
```
- `active_users`: `approvalStatus = APPROVED`인 유저 수
- `analysis_processing_rate`: (승인+반려) / 전체 분석건수, 0.0~1.0 (검토 대기 중인 건 제외한 "처리 완료율")
- `case_type_stats`: 분석 결과의 `case_type`별 건수 (아직 분류 전인 건 제외)
- `analysis_status_breakdown.pending`: `DRAFTED` + `SUBMITTED_FOR_REVIEW` 합계

---

## 감사 로그 (`/api/admin/audit-logs`) **[ADMIN]** — SEC-01-01-01

상담 조회, AI 분석 실행/결과 수정, 검토 승인/반려, 첨부파일 다운로드를 해시체인으로 기록. 각 로그는 직전 로그의 hash를 포함해서 저장되므로(`hash = SHA256(prevHash + 필드들)`), 중간 로그가 수정·삭제되면 그 이후 체인 전체가 깨져서 탐지 가능. insert-only — 수정/삭제 API는 없음.

### GET /api/admin/audit-logs
최신순 전체 목록.
```json
[{
  "id": 4, "actor_email": "lawyer@example.com", "action": "REVIEW_APPROVE",
  "target_type": "AI_ANALYSIS", "target_id": 12, "detail": "확인 완료", "created_at": "2026-07-28T11:45:56.850116"
}]
```
`action`: `CONSULTATION_VIEW` / `AI_ANALYSIS_EXECUTE` / `AI_ANALYSIS_MODIFY` / `REVIEW_APPROVE` / `REVIEW_REJECT` / `DOCUMENT_DOWNLOAD`
`actor_email`: 미인증 요청(토큰 없이 호출 가능한 엔드포인트가 아직 많음 — 상단 인증/인가 섹션 참고)이면 `null`

### GET /api/admin/audit-logs/verify
저장된 전체 로그를 처음부터 재계산해서 위변조 여부 확인.
```json
{ "intact": true, "broken_at_log_id": null }
```
`intact: false`면 `broken_at_log_id`가 위조가 시작된(또는 중간이 삭제된) 최초 로그 id.

---

## 파일 저장 방식

S3 (`S3FileStorageService`). 프론트가 presigned URL(`POST /api/attachments/presigned-upload`)로 브라우저에서 직접 S3에 업로드하고, 업로드 완료 후 상담 생성/수정 요청에 `fileKey` 등 메타데이터만 같이 보내면 서버가 그걸 `Attachment`로 등록하는 구조. 로컬 디스크 저장은 쓰지 않음(과거 `FileStorageService`는 S3 마이그레이션 후 삭제).

---

## 아직 없는 것

- `case_type`/`urgency_level`/`eligibility`/`checklist_json` 값 확정 (팀 회의 대기 중)
- 상담 필수 입력값 검증(Bean Validation) — 지금은 `title`/`clientName` 정도만 사실상 필수, 나머지는 형식 검증 없음
- 법령·판례 검색(RAG), AI 응답 형식/근거/할루시네이션 검증
- 자동화 테스트, 헬스체크 엔드포인트
- Swagger/OpenAPI 문서화 (지금은 이 파일이 유일한 레퍼런스)
