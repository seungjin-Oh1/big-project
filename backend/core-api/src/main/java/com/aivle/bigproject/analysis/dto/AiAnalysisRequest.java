package com.aivle.bigproject.analysis.dto;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

// 생성/수정 요청 body.
// consultation_id는 요청에 안 넣음 — URL 경로(/api/consultations/{consultationId}/analyses)에서
// 이미 받기 때문. (Attachment 업로드 때 consultationId를 경로로만 받는 것과 같은 방식)
//
// @JsonNaming(SnakeCaseStrategy): Java 필드는 camelCase(caseType)로 쓰되, 실제 JSON은
// snake_case(case_type)로 주고받도록 자동 변환 — contracts/ai_analysis_mock.json과 필드명을
// 맞추기 위한 설정.
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public record AiAnalysisRequest(
        String summary,
        // 상담원이 분석을 저장할 때 화면 표시용 두 값도 같이 돌려보낸다. 안 실어 보내면
        // create(새 행)에서 통째로 비어버려서, 저장 직후 화면이 한 문장·키워드를 잃는다.
        String summaryHeadline,
        JsonNode summaryKeywordsJson,
        String caseType,
        String caseSubtype,
        String urgencyLevel,
        String eligibility,
        JsonNode extractedJson,
        JsonNode missingInfoJson,
        JsonNode checklistJson,
        JsonNode recommendationJson,
        JsonNode timelineJson,
        JsonNode clusterResultJson,
        String estimatedTime,
        JsonNode rawInputJson
) {
}
