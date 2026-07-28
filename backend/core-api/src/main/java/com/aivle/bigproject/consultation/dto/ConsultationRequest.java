package com.aivle.bigproject.consultation.dto;

import com.aivle.bigproject.consultation.ConsultationStatus;
import java.util.List;

// 생성(POST)과 수정(PUT) 요청에 공통으로 쓰는 DTO.
// 수정 시엔 null이 아닌 필드만 반영됨 (ConsultationService.update 참고) — 즉 "부분 수정" 방식.
// 생성 시엔 status를 보내도 무시되고 항상 RECEIVED로 시작함 (ConsultationService.create 참고).
// attachments는 생성 시에만 반영됨 (PUT으로는 첨부파일을 갱신하지 않음 — 기존 설계 유지).
public record ConsultationRequest(
        Long userId,
        String title,
        String clientName,
        String inputText,
        String opponentName,
        ConsultationStatus status,
        String category,
        String type,
        String legalAidType,
        Boolean eligibilityEvidenceSubmitted,
        List<AttachmentRegistration> attachments
) {
    // 프론트가 S3에 직접 올린 뒤, "어디에 올렸는지"만 상담 생성 시 같이 넘기는 첨부파일 메타데이터.
    // fileKey가 비어있으면(S3 업로드 실패로 로컬 폴백된 항목) 서버에 등록할 실체가 없으므로 무시함.
    public record AttachmentRegistration(String fileName, String fileType, String fileKey, String fileUrl, String contentType) {}
}
