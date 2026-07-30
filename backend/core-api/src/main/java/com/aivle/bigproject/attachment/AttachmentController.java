package com.aivle.bigproject.attachment;

import com.aivle.bigproject.attachment.dto.AttachmentPresignedUploadRequest;
import com.aivle.bigproject.attachment.dto.AttachmentPresignedUploadResponse;
import com.aivle.bigproject.attachment.dto.AttachmentRegisterRequest;
import com.aivle.bigproject.attachment.dto.AttachmentResponse;
import com.aivle.bigproject.storage.S3FileStorageService;
import jakarta.validation.Valid;
import java.time.Duration;
import java.util.List;
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
    private final S3FileStorageService s3FileStorageService; // presign만 하므로 DB를 아는 AttachmentService를 안 거침

    public AttachmentController(AttachmentService attachmentService, S3FileStorageService s3FileStorageService) {
        this.attachmentService = attachmentService;
        this.s3FileStorageService = s3FileStorageService;
    }

    // POST /api/attachments/presigned-upload — 브라우저가 S3에 직접 PUT할 수 있는 임시 업로드 URL 발급
    // (frontend/src/services/s3UploadClient.js가 상담 등록 화면에서 파일 선택 즉시 호출)
    @PostMapping("/api/attachments/presigned-upload")
    public AttachmentPresignedUploadResponse presignedUpload(@RequestBody AttachmentPresignedUploadRequest request) {
        var presigned = s3FileStorageService.presignUpload(request.fileName(), request.contentType(), Duration.ofMinutes(15));
        return new AttachmentPresignedUploadResponse(presigned.uploadUrl(), presigned.key(), presigned.publicUrl());
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

    // POST /api/consultations/{consultationId}/attachments/register — S3에 이미 올린 파일 위치만 등록
    // 상담이 통화 시작 시점에 만들어지고 자료는 통화 후에 올라오기 때문에, 상담 생성 요청에
    // 첨부를 함께 실어 보내는 기존 경로로는 후처리분을 붙일 수 없어서 이 엔드포인트가 필요합니다.
    @PostMapping("/api/consultations/{consultationId}/attachments/register")
    @ResponseStatus(HttpStatus.CREATED)
    public List<AttachmentResponse> register(@PathVariable Long consultationId,
                                             @Valid @RequestBody AttachmentRegisterRequest request) {
        return attachmentService.register(consultationId, request).stream()
                .map(AttachmentResponse::from)
                .toList();
    }

    // GET /api/consultations/{consultationId}/attachments/{attachmentId} — 파일 원본 다운로드
    @GetMapping("/api/consultations/{consultationId}/attachments/{attachmentId}")
    public ResponseEntity<Resource> download(@PathVariable Long consultationId, @PathVariable Long attachmentId) {
        Attachment attachment = attachmentService.findByIdForConsultation(consultationId, attachmentId);
        Resource resource = attachmentService.loadFile(consultationId, attachmentId);
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                // 브라우저가 파일을 열지 않고 "다운로드"하도록 지시하는 헤더, 원본 파일명도 같이 전달
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + attachment.getFileName() + "\"")
                .body(resource);
    }

    // DELETE /api/consultations/{consultationId}/attachments/{attachmentId} — 첨부파일 삭제
    @DeleteMapping("/api/consultations/{consultationId}/attachments/{attachmentId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long consultationId, @PathVariable Long attachmentId) {
        attachmentService.delete(consultationId, attachmentId);
    }
}
