package com.aivle.bigproject.attachment;

import com.aivle.bigproject.attachment.dto.AttachmentRegistrationRequest;
import com.aivle.bigproject.audit.AuditAction;
import com.aivle.bigproject.audit.AuditLogService;
import com.aivle.bigproject.common.exception.ConflictException;
import com.aivle.bigproject.common.exception.NotFoundException;
import com.aivle.bigproject.consultation.Consultation;
import com.aivle.bigproject.consultation.ConsultationService;
import com.aivle.bigproject.storage.S3FileStorageService;
import com.aivle.bigproject.storage.UploadKeyOwnership;
import java.time.Duration;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

@Service
@Transactional(readOnly = true)
public class AttachmentService {

    private final AttachmentRepository attachmentRepository;
    private final ConsultationService consultationService; // 업로드 대상 상담이 실제로 있는지·접근 권한이 있는지 확인용
    private final S3FileStorageService s3FileStorageService; // 실제 파일 저장/읽기/삭제 담당 (S3)
    private final AuditLogService auditLogService; // SEC-01-01-01: 문서 다운로드 기록용
    private final UploadKeyOwnership uploadKeyOwnership; // 클라이언트가 준 fileKey가 이 사람이 올린 것인지 확인용

    public AttachmentService(AttachmentRepository attachmentRepository,
                              ConsultationService consultationService,
                              S3FileStorageService s3FileStorageService,
                              AuditLogService auditLogService,
                              UploadKeyOwnership uploadKeyOwnership) {
        this.attachmentRepository = attachmentRepository;
        this.consultationService = consultationService;
        this.s3FileStorageService = s3FileStorageService;
        this.auditLogService = auditLogService;
        this.uploadKeyOwnership = uploadKeyOwnership;
    }

    // 브라우저가 S3에 직접 PUT할 수 있는 임시 업로드 URL을 발급하고, 누구에게 어떤 key를
    // 내줬는지 남긴다. 예전에는 컨트롤러가 S3FileStorageService를 바로 불렀는데, 그러면
    // 발급 사실이 어디에도 남지 않아 나중에 register 시점에 그 key의 임자를 알 수 없었다.
    @Transactional
    public S3FileStorageService.PresignedUpload presignUpload(String fileName, String contentType,
                                                                Long sizeBytes, Duration expiration) {
        var presigned = s3FileStorageService.presignUpload(fileName, contentType, sizeBytes, expiration);
        uploadKeyOwnership.record(presigned.key());
        return presigned;
    }

    @Transactional
    public Attachment upload(Long consultationId, MultipartFile file, String fileType) {
        // 1) 상담이 실제로 존재하는지 + 이 사용자가 다룰 수 있는 상담인지 확인 (아니면 404)
        Consultation consultation = consultationService.findAccessibleById(consultationId);
        // 2) S3에 파일 저장하고, 저장된 key를 돌려받음
        String storageKey = s3FileStorageService.store(consultationId, file);
        String originalName = file.getOriginalFilename() != null ? file.getOriginalFilename() : "file";
        String bucket = s3FileStorageService.getBucket();
        String fileUrl = "https://" + bucket + ".s3.amazonaws.com/" + storageKey;
        // 3) DB에 첨부파일 정보(메타데이터) 저장
        return attachmentRepository.save(
                new Attachment(consultation, originalName, fileType, fileUrl, bucket, storageKey, file.getContentType()));
    }

    // 기존 상담에 "자료 추가"할 때 씀. 파일 바이트는 이미 presigned URL로 S3에 올라가 있고,
    // 여기서는 그 위치(fileKey 등) 메타데이터만 DB(Attachment)에 기록한다.
    // (상담을 새로 만들 때는 ConsultationService.create()가 같은 일을 상담 생성과 한 트랜잭션으로 처리하지만,
    //  이미 있는 상담에 자료만 추가하는 경우엔 PUT /api/consultations/{id}가 attachments를 반영하지 않으므로
    //  — ConsultationRequest 주석 참고 — 이 전용 엔드포인트가 필요하다.)
    @Transactional
    public Attachment register(Long consultationId, AttachmentRegistrationRequest request) {
        Consultation consultation = consultationService.findAccessibleById(consultationId);
        // fileKey는 클라이언트가 보내는 값이다. 검사 없이 저장하면 버킷 안의 다른 오브젝트를
        // 자기 상담에 붙여서 첨부 다운로드 경로로 내려받을 수 있다(UploadKeyOwnership 참고).
        uploadKeyOwnership.assertOwnedByCurrentUser(request.fileKey());
        String bucket = s3FileStorageService.getBucket();
        Attachment attachment = new Attachment(consultation, request.fileName(), request.fileType(),
                request.fileUrl(), bucket, request.fileKey(), request.contentType());
        return attachmentRepository.save(attachment);
    }

    // 다운로드/삭제 전에 "이 첨부파일이 진짜 이 상담 소속이 맞는지"까지 같이 검증하는 조회 메서드.
    // (다른 상담의 attachmentId를 URL에 넣어서 접근하는 걸 막기 위함)
    public Attachment findByIdForConsultation(Long consultationId, Long attachmentId) {
        Attachment attachment = attachmentRepository.findById(attachmentId)
                .orElseThrow(() -> new NotFoundException("첨부파일을 찾을 수 없습니다: " + attachmentId));
        if (!attachment.getConsultation().getId().equals(consultationId)) {
            throw new NotFoundException("첨부파일을 찾을 수 없습니다: " + attachmentId);
        }
        return attachment;
    }

    @Transactional
    public Resource loadFile(Long consultationId, Long attachmentId) {
        consultationService.findAccessibleById(consultationId);
        Attachment attachment = findByIdForConsultation(consultationId, attachmentId);
        auditLogService.record(AuditAction.DOCUMENT_DOWNLOAD, "ATTACHMENT", attachmentId, attachment.getFileName());
        return s3FileStorageService.loadAsResource(attachment.getStorageKey());
    }

    @Transactional
    public void delete(Long consultationId, Long attachmentId) {
        consultationService.findAccessibleById(consultationId);
        Attachment attachment = findByIdForConsultation(consultationId, attachmentId);
        s3FileStorageService.delete(attachment.getStorageKey()); // S3 오브젝트 삭제
        attachmentRepository.delete(attachment);                  // DB row 삭제
    }

    // 아직 어떤 상담에도 등록되지 않은(=Attachment DB row가 없는) S3 오브젝트를 지운다.
    // "새 상담 만들기" 화면에서 파일을 골라 presigned URL로 S3까지 올렸지만, 아직 상담을 만들기
    // 전(=등록할 consultationId가 없음)에 사용자가 "삭제"를 누른 경우가 유일한 대상이다.
    // 이미 다른 Attachment가 같은 key를 쓰고 있으면(=이미 정식 등록됨) 실수로 지우지 않도록 거부한다.
    //
    // "DB에 없는 key"라는 조건만으로는 부족하다. 그 조건은 버킷 안의 아직 등록되지 않은
    // 오브젝트 전부에 해당해서, 남이 방금 올려둔 파일이나 ai-api가 쓰는 오브젝트까지
    // 이 경로로 지울 수 있었다. 내가 발급받은 key인지 먼저 본다.
    @Transactional
    public void deleteUnregistered(String fileKey) {
        if (fileKey == null || fileKey.isBlank()) {
            return;
        }
        uploadKeyOwnership.assertOwnedByCurrentUser(fileKey);
        if (attachmentRepository.existsByStorageKey(fileKey)) {
            throw new ConflictException("이미 상담에 등록된 파일은 이 경로로 삭제할 수 없습니다: " + fileKey);
        }
        s3FileStorageService.delete(fileKey);
    }
}
