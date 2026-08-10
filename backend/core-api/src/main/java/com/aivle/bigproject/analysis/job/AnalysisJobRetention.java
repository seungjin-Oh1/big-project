package com.aivle.bigproject.analysis.job;

import java.time.LocalDateTime;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

// 분석 작업에 남은 결과 본문(result_json)을 정리한다.
//
// 지우는 규칙은 두 가지이고, 둘 다 "이 값을 읽을 사람이 더 없다"가 근거다.
//   1. 같은 상담의 지난 결과 — 화면은 최신 것만 본다. markSucceeded가 그때그때 지우고,
//      여기서는 이미 쌓여 있던 것을 소급해서 지운다.
//   2. 보관기간이 지난 결과 — 상담원이 보고도 "분석 내용 저장"을 누르지 않은 것들이다.
//      저장할 생각이었으면 그 자리에서 눌렀을 것이고, 필요하면 다시 분석하면 된다.
//
// 지우는 건 본문뿐이고 행은 남긴다 — 상태·시각·요청자는 개인정보가 아니며 실패 추적에 쓴다.
//
// 부팅할 때 한 번, 그 뒤로는 매일 새벽에 돈다. 부팅에서도 도는 이유는 오래 안 켜는
// 개발 환경 때문이다 — 스케줄만 두면 팀원 로컬에서는 사실상 한 번도 안 돈다.
@Component
class AnalysisJobRetention implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(AnalysisJobRetention.class);

    private final AnalysisJobRepository analysisJobRepository;

    // 기본 7일. 상담원이 분석해 놓고 다음 근무일에 이어서 보는 경우까지는 살려 둔다.
    @Value("${app.analysis-job.result-retention-days:7}")
    private long retentionDays;

    AnalysisJobRetention(AnalysisJobRepository analysisJobRepository) {
        this.analysisJobRepository = analysisJobRepository;
    }

    // @Transactional을 두 진입점에 각각 붙인다. 여기서 sweep()을 부르는 건 같은 객체 안의
    // 호출이라 프록시를 타지 않는다 — sweep()에 붙여 두면 트랜잭션이 안 열리고 @Modifying
    // 쿼리가 그대로 터진다. (게다가 트랜잭션 애너테이션은 public 메서드에만 걸린다.)
    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        sweep();
    }

    // 새벽 4시 30분. 상담 시간대를 피한다.
    @Scheduled(cron = "0 30 4 * * *")
    @Transactional
    public void daily() {
        sweep();
    }

    private void sweep() {
        int superseded = analysisJobRepository.clearAllSupersededResults();
        int expired = analysisJobRepository.clearResultsFinishedBefore(
                LocalDateTime.now().minusDays(retentionDays));
        if (superseded + expired > 0) {
            log.info("분석 결과 본문 정리: 지난 결과 {}건, 보관기간({}일) 경과 {}건",
                    superseded, retentionDays, expired);
        }
    }
}
