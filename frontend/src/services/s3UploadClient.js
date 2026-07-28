// 브라우저에서 파일을 S3로 "직접" 올리는 업로드 계층입니다.
//
// 왜 직접 올리나:
//   지금까지는 파일을 core-api(Spring)로 multipart 전송하면 서버가 다시 S3에 올렸습니다.
//   이러면 파일 바이트가 서버 메모리·디스크를 한 번 거쳐 추가 처리·부하가 생깁니다.
//   그래서 파일 바이트는 브라우저 → S3로 곧장 보내고, 백엔드에는 "어디에 올렸는지"(링크/키)만 전달합니다.
//
// 어떻게 안전하게 직접 올리나 (presigned URL 방식 — 브라우저 직접 업로드의 표준):
//   1) 백엔드에 "이 파일 올릴 임시 업로드 URL 주세요" 요청           (아래 requestPresignedUpload)
//   2) 백엔드가 S3용 presigned PUT URL과 최종 파일 키를 발급          (백엔드 작업 — 아래 규격 참고)
//   3) 브라우저가 그 URL로 파일을 S3에 직접 PUT                        (아래 putFileToS3)
//   4) 상담 등록 시 파일 키만 백엔드로 보내 DB에 기록                  (workflows/App 흐름에서 처리)
//   ※ AWS 자격증명(access key)은 절대 프론트에 두지 않습니다. presigned URL 안에 서명이 담깁니다.
//
// ─────────────────────────────────────────────────────────────────────────
// 백엔드(core-api)가 새로 열어줘야 하는 엔드포인트 — 아직 없으면 이 파일은 자동으로 폴백합니다.
//
//   POST {CORE_API}/api/attachments/presigned-upload
//     요청(JSON):  { "fileName": "rec.mp3", "contentType": "audio/mpeg", "fileType": "녹취록" }
//     응답(JSON):  { "uploadUrl": "https://<bucket>.s3.<region>.amazonaws.com/...서명...",
//                    "fileKey":  "temp/2026/uuid__rec.mp3",
//                    "fileUrl":  "https://<bucket>.s3.<region>.amazonaws.com/temp/2026/uuid__rec.mp3" }
//     구현 힌트: 기존 S3FileStorageService에 이미 S3Presigner를 쓰는 코드(getPresignedDownloadUrl)가 있으니,
//               presignPutObject 로 PUT용 URL을 발급하는 메서드만 추가하면 됩니다.
//
//   ※ S3 버킷 CORS에 PUT 허용과 프론트 오리진(http://localhost:5173 등)이 등록돼 있어야
//     브라우저가 S3로 직접 PUT할 수 있습니다.
//
//   업로드된 파일 키를 DB(Attachment)에 기록하는 것은 상담 생성 payload의 attachments[].fileKey로 전달합니다.
//   (별도 register 엔드포인트를 두는 방식도 가능하나, 현재 프론트는 상담 생성 시 함께 넘깁니다.)
// ─────────────────────────────────────────────────────────────────────────

import { CORE_API_BASE_URL } from './coreApiClientV2.js';

// 백엔드가 아직 준비되지 않았을 때(엔드포인트 없음/네트워크 실패) 던지는 신호용 에러.
// 이 에러면 호출부는 "기존 방식으로 폴백"하고, 그 외 에러는 사용자에게 실패로 알립니다.
export class S3UploadUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'S3UploadUnavailableError';
  }
}

// 환경변수로 직접 업로드를 아예 꺼둘 수 있습니다(기본: 시도함). '0'/'false'면 항상 폴백.
const DIRECT_UPLOAD_ENABLED = !['0', 'false', 'off'].includes(
  String(import.meta.env.VITE_S3_DIRECT_UPLOAD ?? '').toLowerCase(),
);

// 1단계: 백엔드에 presigned PUT URL을 요청합니다.
async function requestPresignedUpload({ fileName, contentType, fileType }) {
  let response;
  try {
    response = await fetch(`${CORE_API_BASE_URL}/api/attachments/presigned-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, contentType, fileType }),
    });
  } catch {
    // 서버가 꺼져 있거나 네트워크 자체가 안 되는 경우 → 폴백 신호
    throw new S3UploadUnavailableError('Core API에 연결할 수 없어 S3 직접 업로드를 건너뜁니다.');
  }

  // 404/405 = 백엔드에 아직 이 엔드포인트가 없음 → 폴백 신호
  if (response.status === 404 || response.status === 405) {
    throw new S3UploadUnavailableError('백엔드에 presigned 업로드 엔드포인트가 아직 없습니다.');
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`presigned URL 발급 실패 (HTTP ${response.status}): ${detail || response.statusText}`);
  }

  const data = await response.json();
  if (!data?.uploadUrl || !data?.fileKey) {
    throw new Error('presigned 응답에 uploadUrl 또는 fileKey가 없습니다.');
  }
  return data; // { uploadUrl, fileKey, fileUrl }
}

// 3단계: 발급받은 presigned URL로 파일을 S3에 직접 PUT합니다. (파일 바이트가 백엔드를 거치지 않음)
async function putFileToS3(uploadUrl, file) {
  let response;
  try {
    response = await fetch(uploadUrl, {
      method: 'PUT',
      // presigned URL 서명 시 지정한 Content-Type과 맞아야 합니다.
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch {
    // S3 도달 실패는 대개 버킷 CORS 미설정입니다. (폴백이 아니라 실제 실패로 알립니다)
    throw new Error('S3에 파일을 전송하지 못했습니다. 버킷 CORS(PUT 허용) 설정을 확인해주세요.');
  }
  if (!response.ok) {
    throw new Error(`S3 업로드 실패 (HTTP ${response.status}).`);
  }
}

// 파일 하나를 S3에 직접 올리고, 백엔드에 기록할 링크 정보를 돌려줍니다.
// 성공: { fileKey, fileUrl }  /  백엔드 미지원: S3UploadUnavailableError 던짐(호출부가 폴백)
export async function uploadFileToS3(file, fileType) {
  if (!DIRECT_UPLOAD_ENABLED) {
    throw new S3UploadUnavailableError('S3 직접 업로드가 환경변수로 비활성화되어 있습니다.');
  }
  const { uploadUrl, fileKey, fileUrl } = await requestPresignedUpload({
    fileName: file.name,
    contentType: file.type || 'application/octet-stream',
    fileType,
  });
  await putFileToS3(uploadUrl, file);
  // fileUrl이 없으면 키만으로도 백엔드가 접근 경로를 만들 수 있으므로 키를 대체 값으로 둡니다.
  return { fileKey, fileUrl: fileUrl || fileKey };
}
