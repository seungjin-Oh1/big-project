package com.aivle.bigproject.attachment.dto;

import jakarta.validation.constraints.NotEmpty;
import java.util.List;

// 이미 존재하는 상담에 "프론트가 S3에 직접 올려둔 첨부파일"을 나중에 등록할 때 쓰는 요청.
//
// 상담 생성(ConsultationRequest.attachments)과 파일 내용이 같은데도 별도 엔드포인트가 필요한 이유:
// 상담은 통화 시작 시점에 이미 만들어지고, 자료는 통화가 끝난 뒤 후처리로 올라옵니다. 그래서
// "생성 시점에 첨부를 함께 넘기는" 기존 경로로는 후처리분을 붙일 수 없습니다.
// multipart 업로드(POST .../attachments)와도 다릅니다 — 그쪽은 서버가 파일 바이트를 받아 S3에
// 올리는 경로이고, 이쪽은 브라우저가 presigned URL로 이미 올린 뒤 위치만 등록하는 경로입니다.
public record AttachmentRegisterRequest(
        @NotEmpty(message = "등록할 첨부파일이 없습니다") List<Item> attachments
) {
    // fileKey가 비어있으면(S3 업로드 실패로 로컬 폴백된 항목) 서버에 등록할 실체가 없으므로 무시함.
    public record Item(String fileName, String fileType, String fileKey, String fileUrl, String contentType) {}
}
