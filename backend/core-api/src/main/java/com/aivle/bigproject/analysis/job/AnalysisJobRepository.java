package com.aivle.bigproject.analysis.job;

import java.time.LocalDateTime;
import java.util.Collection;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface AnalysisJobRepository extends JpaRepository<AnalysisJob, Long> {

    // 아직 안 끝난 작업이 있는지 확인용(PENDING/RUNNING). 같은 상담에 분석을 두 번 걸지 않기 위해,
    // 그리고 새로고침한 화면이 진행 중이던 작업을 다시 찾아 붙기 위해 쓴다.
    Optional<AnalysisJob> findFirstByConsultationIdAndStatusInOrderByIdDesc(
            Long consultationId, Collection<AnalysisJobStatus> statuses);

    // 상담이 삭제될 때 딸린 작업도 같이 지운다. Consultation이 이 목록을 들고 있지 않은
    // 단방향 FK라 cascade가 걸리지 않는다(AiAnalysis/GeneratedDocument와 같은 사정).
    void deleteByConsultationId(Long consultationId);

    // ── result_json 정리 ──────────────────────────────────────────────────
    //
    // result_json은 산출물이 아니라 '백그라운드에서 화면으로 결과를 건네는 버퍼'다
    // (AnalysisJob.resultJson 주석 참고). 상담원이 보고 "분석 내용 저장"을 누르면
    // ai_analysis 행이 생기고, 그 뒤로 이 값을 읽는 곳은 없다.
    //
    // 그런데 지우지 않아서 재분석할 때마다 사본이 쌓였다 — 실측: 상담 55에 4벌.
    // 같은 사람의 이름과 사건 내용이 담긴 사본이라 그냥 두면 개인정보를 목적 없이
    // 보관하는 셈이 된다(개인정보 보호법 제21조, 목적 달성 후 파기).
    //
    // 행 자체는 남긴다. 상태·시각·요청자는 개인정보가 아니고, "언제 몇 번 분석했나"와
    // 실패 원인을 되짚는 데 쓴다. 지우는 건 본문뿐이다.

    /** 같은 상담의 지난 결과를 지운다. 화면은 최신 것만 보므로 새 결과가 나온 순간 필요 없어진다. */
    @Modifying
    @Query("""
            UPDATE AnalysisJob j SET j.resultJson = null
             WHERE j.consultation.id = :consultationId
               AND j.id <> :keepJobId
               AND j.resultJson IS NOT NULL
            """)
    int clearSupersededResults(@Param("consultationId") Long consultationId,
                               @Param("keepJobId") Long keepJobId);

    /** 상담별 최신 1건만 남기고 지운다. 위 규칙을 이미 쌓인 행에 소급 적용하는 용도. */
    @Modifying
    @Query("""
            UPDATE AnalysisJob j SET j.resultJson = null
             WHERE j.resultJson IS NOT NULL
               AND j.id NOT IN (SELECT MAX(b.id) FROM AnalysisJob b GROUP BY b.consultation.id)
            """)
    int clearAllSupersededResults();

    /** 보관기간이 지난 결과를 지운다. 상담원이 보고도 저장하지 않은 채 방치된 것들이다. */
    @Modifying
    @Query("""
            UPDATE AnalysisJob j SET j.resultJson = null
             WHERE j.resultJson IS NOT NULL
               AND j.finishedAt IS NOT NULL
               AND j.finishedAt < :cutoff
            """)
    int clearResultsFinishedBefore(@Param("cutoff") LocalDateTime cutoff);
}
