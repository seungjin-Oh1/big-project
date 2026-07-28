package com.aivle.bigproject.attachment;

import com.aivle.bigproject.audit.AuditAction;
import com.aivle.bigproject.audit.AuditLogService;
import com.aivle.bigproject.common.exception.NotFoundException;
import com.aivle.bigproject.consultation.Consultation;
import com.aivle.bigproject.consultation.ConsultationService;
import com.aivle.bigproject.storage.S3FileStorageService;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

@Service
@Transactional(readOnly = true)
public class AttachmentService {

    private final AttachmentRepository attachmentRepository;
    private final ConsultationService consultationService; // 업로드 대상 상담이 실제로 있는지 확인용
    private final S3FileStorageService s3FileStorageService; // 실제 파일 저장/읽기/삭제 담당 (S3)
    private final AuditLogService auditLogService; // SEC-01-01-01: 문서 다운로드 기록용

    public AttachmentService(AttachmentRepository attachmentRepository,
                              ConsultationService consultationService,
                              S3FileStorageService s3FileStorageService,
                              AuditLogService auditLogService) {
        this.attachmentRepository = attachmentRepository;
        this.consultationService = consultationService;
        this.s3FileStorageService = s3FileStorageService;
        this.auditLogService = auditLogService;
    }

    @Transactional
    public Attachment upload(Long consultationId, MultipartFile file, String fileType) {
        // 1) 상담이 실제로 존재하는지 확인 (없으면 404)
        Consultation consultation = consultationService.findById(consultationId);
        // 2) S3에 파일 저장하고, 저장된 key를 돌려받음
        String storageKey = s3FileStorageService.store(consultationId, file);
        String originalName = file.getOriginalFilename() != null ? file.getOriginalFilename() : "file";
        String bucket = s3FileStorageService.getBucket();
        String fileUrl = "https://" + bucket + ".s3.amazonaws.com/" + storageKey;
        // 3) DB에 첨부파일 정보(메타데이터) 저장
        return attachmentRepository.save(
                new Attachment(consultation, originalName, fileType, fileUrl, bucket, storageKey, file.getContentType()));
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
        Attachment attachment = findByIdForConsultation(consultationId, attachmentId);
        auditLogService.record(AuditAction.DOCUMENT_DOWNLOAD, "ATTACHMENT", attachmentId, attachment.getFileName());
        return s3FileStorageService.loadAsResource(attachment.getStorageKey());
    }

    @Transactional
    public void delete(Long consultationId, Long attachmentId) {
        Attachment attachment = findByIdForConsultation(consultationId, attachmentId);
        s3FileStorageService.delete(attachment.getStorageKey()); // S3 오브젝트 삭제
        attachmentRepository.delete(attachment);                  // DB row 삭제
    }
}
