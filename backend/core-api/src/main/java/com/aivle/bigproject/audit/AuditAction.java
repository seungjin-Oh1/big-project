package com.aivle.bigproject.audit;

// SEC-01-01-01 요구사항이 명시한 5가지 감사 대상 행위
public enum AuditAction {
    CONSULTATION_VIEW,   // 상담 조회
    AI_ANALYSIS_EXECUTE, // AI 분석 실행
    AI_ANALYSIS_MODIFY,  // 결과 수정
    REVIEW_APPROVE,      // 검토 승인
    REVIEW_REJECT,       // 검토 반려 (승인/반려를 한 쌍으로 같이 기록)
    DOCUMENT_DOWNLOAD    // 문서 다운로드
}
