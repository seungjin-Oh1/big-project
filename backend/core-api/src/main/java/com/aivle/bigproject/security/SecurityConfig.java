package com.aivle.bigproject.security;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

    private final JwtAuthenticationFilter jwtAuthenticationFilter;

    public SecurityConfig(JwtAuthenticationFilter jwtAuthenticationFilter) {
        this.jwtAuthenticationFilter = jwtAuthenticationFilter;
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
                // JWT만 쓰는 무상태 REST API라 세션/CSRF 토큰이 필요 없음
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/api/auth/**").permitAll()
                        // 가입 승인/거절/대기목록은 관리자 권한 로직의 핵심이라 실제로 막아둔다.
                        // 토큰 없이 호출하면 인증 자체가 안 잡혀 401, LAWYER/CONSULTANT 토큰으로
                        // 호출하면 권한 부족으로 403이 난다.
                        .requestMatchers(HttpMethod.GET, "/api/users/pending").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.POST, "/api/users/*/approve").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.POST, "/api/users/*/reject").hasRole("ADMIN")
                        // 관리자 대시보드 통계도 관리자 전용.
                        .requestMatchers(HttpMethod.GET, "/api/admin/stats").hasRole("ADMIN")
                        // 감사 로그 조회/검증도 관리자 전용.
                        .requestMatchers(HttpMethod.GET, "/api/admin/audit-logs/**").hasRole("ADMIN")
                        // 서식 초안 승인/반려는 변호사 권한 로직의 핵심이라 실제로 막아둔다.
                        .requestMatchers(HttpMethod.POST, "/api/consultations/*/documents/*/approve").hasRole("LAWYER")
                        .requestMatchers(HttpMethod.POST, "/api/consultations/*/documents/*/request-revision").hasRole("LAWYER")
                        // AI 분석 결과 승인/반려도 마찬가지로 변호사 전용.
                        .requestMatchers(HttpMethod.POST, "/api/consultations/*/analyses/*/approve").hasRole("LAWYER")
                        .requestMatchers(HttpMethod.POST, "/api/consultations/*/analyses/*/request-revision").hasRole("LAWYER")
                        // TODO: 프론트엔드가 로그인 붙이고 토큰을 실제로 보내기 시작하면,
                        // 나머지 라인들도 .authenticated() 등으로 좁혀야 진짜 보호가 됨.
                        // 지금은 기존 화면(로그인 없이 상담 등록 등)이 안 깨지게 전부 permitAll로 둠.
                        .anyRequest().permitAll()
                )
                .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }
}
