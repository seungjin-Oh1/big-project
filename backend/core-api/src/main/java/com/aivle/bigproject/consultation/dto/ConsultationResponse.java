package com.aivle.bigproject.consultation.dto;

import com.aivle.bigproject.attachment.dto.AttachmentResponse;
import com.aivle.bigproject.consultation.Consultation;
import com.aivle.bigproject.consultation.ConsultationStatus;
import java.time.LocalDateTime;
import java.util.List;

// 상담 조회 응답 형태. 첨부파일 목록(attachments)까지 같이 내려줘서
// 클라이언트가 별도 API 호출 없이 한 번에 상담+첨부파일을 받을 수 있게 함.
public record ConsultationResponse(
        Long id,
        Long userId,
        String title,
        String clientName,
        String inputText,
        List<String> callInputTexts,
        List<String> inpersonInputTexts,
        String opponentName,
        ConsultationStatus status,
        String category,
        String type,
        String legalAidType,
        Boolean eligibilityEvidenceSubmitted,
        // 서식 작성용 개인정보와 그 동의 기록. 상담원이 화면에서 이어서 고칠 수 있어야
        // 하므로 내려준다. 주민등록번호는 애초에 저장하지 않으므로 여기에도 없다 —
        // 개인정보 보호법 제24조의2는 동의가 아니라 법령 근거를 요구한다.
        String clientAddress,
        String clientPhone,
        Boolean privacyConsent,
        LocalDateTime privacyConsentAt,
        String privacyConsentSource,
        LocalDateTime createdAt,
        LocalDateTime updatedAt,
        List<AttachmentResponse> attachments
) {
    // 엔티티 → 응답 DTO 변환.
    // 주의: consultation.getAttachments()는 지연 로딩(LAZY)이라, 이 메서드는
    // 반드시 DB 트랜잭션이 열려있는 동안(=서비스 계층 안에서)만 호출해야 함.
    // 트랜잭션이 끝난 뒤(예: 컨트롤러에서) 호출하면 LazyInitializationException 발생.
    public static ConsultationResponse from(Consultation consultation) {
        return new ConsultationResponse(
                consultation.getId(),
                consultation.getUser().getId(),
                consultation.getTitle(),
                consultation.getClientName(),
                consultation.getInputText(),
                consultation.getCallInputTexts(),
                consultation.getInpersonInputTexts(),
                consultation.getOpponentName(),
                consultation.getStatus(),
                consultation.getCategory(),
                consultation.getType(),
                consultation.getLegalAidType(),
                consultation.getEligibilityEvidenceSubmitted(),
                consultation.getClientAddress(),
                consultation.getClientPhone(),
                consultation.getPrivacyConsent(),
                consultation.getPrivacyConsentAt(),
                consultation.getPrivacyConsentSource(),
                consultation.getCreatedAt(),
                consultation.getUpdatedAt(),
                consultation.getAttachments().stream()
                        .map(AttachmentResponse::from)
                        .toList()
        );
    }
}
