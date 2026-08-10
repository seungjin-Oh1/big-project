package com.aivle.bigproject.consultation.dto;

// "상담 저장" 버튼 전용 요청 body. 실시간 상담(전화/대면) 채널별 현재 메모를 그대로 받아
// Consultation.input_text를 갱신하고 call_input_texts/inperson_input_texts에 스냅샷을
// append한다(ConsultationService.saveTranscript 참고).
//
// 가림본은 받지 않는다. 예전에는 화면이 가림본을 함께 보내 원본과 나란히 저장했는데,
// 원본이 그대로 남아 있는 한 가림본을 같이 두어도 유출 대비가 되지 않으면서 보관하는
// 개인정보만 두 배가 된다. 가림이 필요한 두 곳(검색 질의, 화면 미리보기)은 그때그때
// 가려서 쓰고 버린다.
//
// AiAnalysisRequest(분석 결과 저장)와는 완전히 분리된 경로다 — "분석 내용 저장"은 ai_analysis
// 테이블만 건드리고 Consultation은 건드리지 않는다는 요구에 따라, 상담 원문 저장은 이 엔드포인트가
// 전담한다.
//
// 같은 컨트롤러의 ConsultationRequest와 마찬가지로 @JsonNaming(SnakeCase)을 쓰지 않는다.
public record TranscriptSaveRequest(
        String callInputText,
        String inpersonInputText
) {
}
