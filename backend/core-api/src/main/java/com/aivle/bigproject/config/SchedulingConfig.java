package com.aivle.bigproject.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

// @Scheduled를 켠다. 지금 쓰는 곳은 분석 결과 본문 정리 한 곳뿐이다(AnalysisJobRetention).
//
// AsyncConfig와 따로 두는 이유: @EnableAsync는 요청을 처리하는 길이고 이건 시간이 되면
// 저절로 도는 길이라, 한쪽을 끄고 싶을 때 다른 쪽까지 건드리게 되지 않도록 나눈다.
@Configuration
@EnableScheduling
public class SchedulingConfig {
}
