package com.aivle.bigproject.analysis.dto;

import com.aivle.bigproject.analysis.AnalysisReviewStatus;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;
import java.time.LocalDateTime;

// contracts/ai_analysis_mock.json과 필드명이 1:1로 맞도록 만든 응답 형태.
// @JsonNaming(SnakeCaseStrategy)가 analysisId -> analysis_id, caseType -> case_type 식으로
// 자동 변환해줘서, 이 파일의 필드는 그대로 두고 이름만 계약서 형식(snake_case)으로 나감.
// extracted_json 등은 JsonNode 타입이라 문자열이 아니라 실제 중첩 JSON 객체/배열로 응답에 실림.
//
// 엔티티 -> 이 DTO로 변환하는 작업은 AiAnalysisService에서 함 (JSON 문자열 -> JsonNode 파싱이
// 필요해서 단순 정적 팩토리 메서드로는 못 하고 ObjectMapper가 있어야 함).
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public record AiAnalysisResponse(
        Long analysisId,
        Long consultationId,
        String summary,
        String caseType,
        String caseSubtype,
        String urgencyLevel,
        // 계약서 v0.1엔 등급만 있는데 ai-api가 점수(0.0~1.0)도 같이 낸다. 화면 게이지용.
        // 예전엔 extracted_json 안에 실려 나갔다. 등급과 마찬가지로 후보값.
        Double urgencyScore,
        String eligibility,
        JsonNode extractedJson,
        JsonNode missingInfoJson,
        JsonNode checklistJson,
        JsonNode recommendationJson,
        JsonNode timelineJson,
        JsonNode clusterResultJson,
        String estimatedTime,
        JsonNode rawInputJson,
        LocalDateTime createdAt,
        // 계약서엔 없는 필드(검토/승인 워크플로우용) — 뒤에 덧붙여서 기존 계약 필드 순서/이름은 안 건드림
        AnalysisReviewStatus status,
        Long reviewerId,
        String reviewerName,
        String reviewNote,
        LocalDateTime reviewedAt
) {
}
