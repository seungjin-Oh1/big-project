package com.aivle.bigproject.analysis;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface AiAnalysisRepository extends JpaRepository<AiAnalysis, Long> {

    // 메서드 이름만으로 Spring Data가 "consultation.id로 조회"하는 쿼리를 자동 생성함 (JPQL 직접 안 씀)
    List<AiAnalysis> findByConsultationId(Long consultationId);

    // 상담이 삭제될 때 딸린 분석 결과도 같이 지우기 위해 사용 (ConsultationService.delete 참고)
    void deleteByConsultationId(Long consultationId);

    // 관리자 대시보드 "분석 처리 현황"(승인/반려/대기) 집계용 (AdminStatsService)
    long countByStatus(AnalysisReviewStatus status);

    // 관리자 대시보드 "사건 유형별 상담 통계"용. case_type은 자유 문자열이라 enum 그룹핑이
    // 아니라 값 자체로 그룹핑함 — null인 건(아직 분류 전) 통계에서 제외.
    @Query("SELECT a.caseType, COUNT(a) FROM AiAnalysis a WHERE a.caseType IS NOT NULL GROUP BY a.caseType")
    List<Object[]> countGroupedByCaseType();
}
