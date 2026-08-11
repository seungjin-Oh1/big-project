package com.aivle.bigproject.attachment;

import com.aivle.bigproject.attachment.dto.AttachmentPresignedUploadRequest;
import com.aivle.bigproject.attachment.dto.AttachmentPresignedUploadResponse;
import com.aivle.bigproject.attachment.dto.AttachmentRegistrationRequest;
import com.aivle.bigproject.attachment.dto.AttachmentResponse;
import java.time.Duration;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
public class AttachmentController {

    private final AttachmentService attachmentService;

    public AttachmentController(AttachmentService attachmentService) {
        this.attachmentService = attachmentService;
    }

    // POST /api/attachments/presigned-upload — 브라우저가 S3에 직접 PUT할 수 있는 임시 업로드 URL 발급
    // (frontend/src/services/s3UploadClient.js가 상담 등록 화면에서 파일 선택 즉시 호출)
    //
    // 예전에는 S3FileStorageService를 바로 불렀다. 그러면 "누구에게 어떤 key를 내줬는지"가
    // 아무 데도 남지 않아서, 나중에 그 key로 등록 요청이 왔을 때 임자를 확인할 수 없었다.
    @PostMapping("/api/attachments/presigned-upload")
    public AttachmentPresignedUploadResponse presignedUpload(@RequestBody AttachmentPresignedUploadRequest request) {
        var presigned = attachmentService.presignUpload(
                request.fileName(), request.contentType(), request.sizeBytes(), Duration.ofMinutes(15));
        return new AttachmentPresignedUploadResponse(presigned.uploadUrl(), presigned.key(), presigned.publicUrl());
    }

    // DELETE /api/attachments/unregistered?fileKey=... — 아직 어떤 상담에도 등록되지 않은(=Attachment DB
    // row가 없는) S3 오브젝트를 지운다. "새 상담 만들기" 화면에서 파일을 올렸다가(S3까지 감) 상담을
    // 만들기 전에 "삭제"를 누른 경우처럼, DELETE /attachments/{consultationId}/{attachmentId}로는 지울 수
    // 없는(consultationId·attachmentId가 아직 없는) 파일을 지우는 유일한 경로.
    @DeleteMapping("/api/attachments/unregistered")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteUnregistered(@RequestParam String fileKey) {
        attachmentService.deleteUnregistered(fileKey);
    }

    // POST /api/consultations/{consultationId}/attachments/register — 이미 presigned URL로 S3에 올라간
    // 파일의 메타데이터를 "기존" 상담에 등록 (multipart 재업로드 없이 DB에만 기록).
    // frontend/src/pages/workflows.jsx의 "기존 상담에 자료 추가 → 자료 저장"이 이 엔드포인트를 부른다.
    @PostMapping("/api/consultations/{consultationId}/attachments/register")
    @ResponseStatus(HttpStatus.CREATED)
    public AttachmentResponse register(@PathVariable Long consultationId,
                                        @RequestBody AttachmentRegistrationRequest request) {
        return AttachmentResponse.from(attachmentService.register(consultationId, request));
    }

    // POST /api/consultations/{consultationId}/attachments — 파일 업로드
    // JSON이 아니라 multipart/form-data로 받음 (file: 실제 파일, fileType: 문자열)
    @PostMapping("/api/consultations/{consultationId}/attachments")
    @ResponseStatus(HttpStatus.CREATED)
    public AttachmentResponse upload(@PathVariable Long consultationId,
                                      @RequestParam("file") MultipartFile file,
                                      @RequestParam("fileType") String fileType) {
        return AttachmentResponse.from(attachmentService.upload(consultationId, file, fileType));
    }

    // GET /api/consultations/{consultationId}/attachments/{attachmentId} — 파일 원본 다운로드
    @GetMapping("/api/consultations/{consultationId}/attachments/{attachmentId}")
    public ResponseEntity<Resource> download(@PathVariable Long consultationId, @PathVariable Long attachmentId) {
        Attachment attachment = attachmentService.findByIdForConsultation(consultationId, attachmentId);
        Resource resource = attachmentService.loadFile(consultationId, attachmentId);
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                // 브라우저가 파일을 열지 않고 "다운로드"하도록 지시하는 헤더, 원본 파일명도 같이 전달
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + headerSafeFileName(attachment) + "\"")
                .body(resource);
    }

    // DELETE /api/consultations/{consultationId}/attachments/{attachmentId} — 첨부파일 삭제
    @DeleteMapping("/api/consultations/{consultationId}/attachments/{attachmentId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long consultationId, @PathVariable Long attachmentId) {
        attachmentService.delete(consultationId, attachmentId);
    }

    // 파일명은 사용자가 올린 값이라 그대로 응답 헤더에 넣으면 안 된다.
    // CR/LF가 섞여 있으면 헤더가 거기서 끊기고 그 뒤가 새 응답으로 해석돼(HTTP 응답분할),
    // 공격자가 원하는 헤더나 본문을 붙일 수 있다. 큰따옴표는 filename="..."을 중간에 닫아버린다.
    // 업로드 시점에도 같은 문자를 거르지만(AttachmentService), 그 전에 저장된 이름이 DB에 남아 있어
    // 내보내는 쪽에서도 한 번 더 막는다.
    private static String headerSafeFileName(Attachment attachment) {
        String fileName = attachment.getFileName();
        if (fileName == null || fileName.isBlank()) return "attachment";
        return fileName.replaceAll("[\\r\\n\"]", "_");
    }
}
