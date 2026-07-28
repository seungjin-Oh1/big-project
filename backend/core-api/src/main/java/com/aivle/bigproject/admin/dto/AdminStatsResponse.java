package com.aivle.bigproject.admin.dto;

import java.util.Map;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.annotation.JsonNaming;

// 관리자 대시보드 상단 요약 지표 + 통계 응답.
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public record AdminStatsResponse(
        long totalConsultations,
        long activeUsers,
        // 0.0~1.0. (승인+반려) / 전체분석건수 — "검토가 끝난 비율"을 의미함(대기 중인 건 제외)
        double analysisProcessingRate,
        long pendingUserApprovals,
        // case_type 값 -> 건수. 아직 case_type이 없는(분류 전) 분석은 제외됨
        Map<String, Long> caseTypeStats,
        AnalysisStatusBreakdown analysisStatusBreakdown
) {
    // DRAFTED/SUBMITTED_FOR_REVIEW는 아직 최종 결정 전이라 pending으로 합침
    public record AnalysisStatusBreakdown(long approved, long rejected, long pending) {
    }
}
