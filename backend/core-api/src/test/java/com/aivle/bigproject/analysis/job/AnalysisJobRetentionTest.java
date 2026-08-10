package com.aivle.bigproject.analysis.job;

import static org.assertj.core.api.Assertions.assertThat;

import com.aivle.bigproject.consultation.Consultation;
import com.aivle.bigproject.user.User;
import jakarta.persistence.EntityManager;
import java.time.LocalDateTime;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;

// 분석 결과 본문(result_json)이 필요 없어졌을 때 실제로 지워지는지 본다.
// 개인정보 사본이 남느냐 마느냐라서, 규칙만이 아니라 DB에 반영되는 것까지 확인한다.
// RANDOM_PORT로 띄운다 — 기본 MOCK 환경에는 WebSocket 컨테이너가 없어서
// WebSocketConfig가 뜨지 못한다(BigprojectApplicationTests와 같은 사정).
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Transactional
@DisplayName("분석 결과 본문 정리")
class AnalysisJobRetentionTest {

    @Autowired
    private AnalysisJobRepository analysisJobRepository;

    @Autowired
    private EntityManager em;

    private Consultation consultation;

    @BeforeEach
    void setUp() {
        User user = em.createQuery("SELECT u FROM User u", User.class)
                .setMaxResults(1).getSingleResult();
        consultation = new Consultation(user, "정리 테스트", "홍길동", "상담 원문", null,
                null, null, null, false);
        em.persist(consultation);
    }

    private AnalysisJob job(String resultJson, LocalDateTime finishedAt) {
        AnalysisJob job = new AnalysisJob(consultation, "tester@test.test");
        job.setResultJson(resultJson);
        job.setStatus(AnalysisJobStatus.SUCCEEDED);
        job.setFinishedAt(finishedAt);
        em.persist(job);
        return job;
    }

    private String storedResult(AnalysisJob job) {
        em.flush();
        em.clear();
        return em.find(AnalysisJob.class, job.getId()).getResultJson();
    }

    @Test
    @DisplayName("같은 상담의 지난 결과는 지우고 최신 것만 남긴다")
    void 지난_결과_정리() {
        AnalysisJob old1 = job("{\"summary\":\"1차 정미래\"}", LocalDateTime.now().minusHours(3));
        AnalysisJob old2 = job("{\"summary\":\"2차 정미래\"}", LocalDateTime.now().minusHours(2));
        AnalysisJob latest = job("{\"summary\":\"3차 정미래\"}", LocalDateTime.now());
        em.flush();

        int cleared = analysisJobRepository.clearSupersededResults(consultation.getId(), latest.getId());

        assertThat(cleared).isEqualTo(2);
        assertThat(storedResult(old1)).isNull();
        assertThat(storedResult(old2)).isNull();
        assertThat(storedResult(latest)).contains("3차");
    }

    @Test
    @DisplayName("행 자체는 남는다 — 언제 몇 번 분석했는지는 추적할 수 있어야 한다")
    void 행은_남긴다() {
        AnalysisJob old = job("{\"summary\":\"정미래\"}", LocalDateTime.now().minusHours(1));
        AnalysisJob latest = job("{\"summary\":\"정미래\"}", LocalDateTime.now());
        em.flush();

        analysisJobRepository.clearSupersededResults(consultation.getId(), latest.getId());
        em.flush();
        em.clear();

        AnalysisJob reloaded = em.find(AnalysisJob.class, old.getId());
        assertThat(reloaded).isNotNull();
        assertThat(reloaded.getStatus()).isEqualTo(AnalysisJobStatus.SUCCEEDED);
        assertThat(reloaded.getFinishedAt()).isNotNull();
        assertThat(reloaded.getRequestedByEmail()).isEqualTo("tester@test.test");
    }

    @Test
    @DisplayName("보관기간이 지난 결과는 최신이라도 지운다")
    void 보관기간_경과() {
        AnalysisJob stale = job("{\"summary\":\"정미래\"}", LocalDateTime.now().minusDays(8));
        AnalysisJob fresh = job("{\"summary\":\"정미래\"}", LocalDateTime.now().minusDays(1));
        em.flush();

        int cleared = analysisJobRepository.clearResultsFinishedBefore(LocalDateTime.now().minusDays(7));

        assertThat(cleared).isGreaterThanOrEqualTo(1);
        assertThat(storedResult(stale)).isNull();
        assertThat(storedResult(fresh)).isNotNull();
    }

    @Test
    @DisplayName("아직 안 끝난 작업은 건드리지 않는다")
    void 진행중은_보존() {
        AnalysisJob running = new AnalysisJob(consultation, "tester@test.test");
        running.setStatus(AnalysisJobStatus.RUNNING);
        em.persist(running);
        AnalysisJob done = job("{\"summary\":\"정미래\"}", LocalDateTime.now());
        em.flush();

        // 진행 중인 작업은 finished_at이 없어서 보관기간 규칙에 아예 걸리지 않는다.
        analysisJobRepository.clearResultsFinishedBefore(LocalDateTime.now().minusDays(7));

        assertThat(storedResult(done)).isNotNull();
        assertThat(em.find(AnalysisJob.class, running.getId()).getStatus())
                .isEqualTo(AnalysisJobStatus.RUNNING);
    }
}
