package com.aivle.bigproject.proxy;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpMethod;

// ai-api 프록시의 화이트리스트.
//
// 여기가 이 클래스의 존재 이유다. ai-api에는 인증이 없고, 배포에서는 VPC 안에 숨긴다.
// 그러면 ai-api에 닿는 유일한 통로가 이 프록시이므로, 이 목록이 곧 외부에 열린 면적이다.
// 목록을 넓히는 실수(접두어 비교로 바꾼다든지)를 테스트로 잡는다.
class AiApiProxyControllerTest {

    @ParameterizedTest
    @ValueSource(strings = {
            "/statutes/search", "/statutes/recommend", "/statutes/full-text",
            "/precedents/search", "/precedents/recommend", "/precedents/full-text",
            "/consultations/search", "/consultations/recommend", "/consultations/full-text",
            "/forms/revisions/acknowledge"
    })
    @DisplayName("화면이 쓰는 POST 경로는 통과한다")
    void allowsFrontendPostPaths(String path) {
        assertThat(AiApiProxyController.isAllowed(HttpMethod.POST, path)).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {"/health", "/forms/revisions"})
    @DisplayName("화면이 쓰는 GET 경로는 통과한다")
    void allowsFrontendGetPaths(String path) {
        assertThat(AiApiProxyController.isAllowed(HttpMethod.GET, path)).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {
            // core-api가 직접 오케스트레이션하는 경로 — 브라우저가 건너뛰고 부르면 안 된다.
            "/consult/analyze",
            "/forms/draft",
            "/forms/recommend",
            // FastAPI가 기본으로 여는 문서·스키마. ai-api의 엔드포인트 전체가 드러난다.
            "/docs",
            "/openapi.json",
            // 접두어만 맞는 값. Set.contains가 아니라 startsWith로 바꾸면 여기서 걸린다.
            "/statutes/search/extra",
            "/statutes",
            "/health/../docs",
            "",
            "/"
    })
    @DisplayName("목록에 없는 경로는 GET·POST 모두 막힌다")
    void rejectsEverythingElse(String path) {
        assertThat(AiApiProxyController.isAllowed(HttpMethod.GET, path)).isFalse();
        assertThat(AiApiProxyController.isAllowed(HttpMethod.POST, path)).isFalse();
    }

    @Test
    @DisplayName("GET 전용과 POST 전용이 서로 넘나들지 않는다")
    void methodsDoNotLeakIntoEachOther() {
        // /health는 GET만 — POST로 열려 있을 이유가 없다.
        assertThat(AiApiProxyController.isAllowed(HttpMethod.POST, "/health")).isFalse();
        // acknowledge는 기준 스냅샷을 갈아엎는 쓰기 동작이라 GET으로 불릴 수 없어야 한다.
        assertThat(AiApiProxyController.isAllowed(HttpMethod.GET, "/forms/revisions/acknowledge")).isFalse();
    }

    @Test
    @DisplayName("PUT·DELETE 같은 다른 메서드는 무엇이든 막힌다")
    void rejectsOtherMethods() {
        assertThat(AiApiProxyController.isAllowed(HttpMethod.PUT, "/statutes/search")).isFalse();
        assertThat(AiApiProxyController.isAllowed(HttpMethod.DELETE, "/health")).isFalse();
        assertThat(AiApiProxyController.isAllowed(HttpMethod.PATCH, "/health")).isFalse();
    }

    @Test
    @DisplayName("/api/ai 뒤쪽만 잘라 ai-api 경로로 쓴다")
    void stripsOwnPrefix() {
        assertThat(AiApiProxyController.pathAfterPrefix("/api/ai/statutes/search")).isEqualTo("/statutes/search");
        assertThat(AiApiProxyController.pathAfterPrefix("/api/ai/health")).isEqualTo("/health");
        // 접두어만 있는 요청. 빈 문자열로 두면 ai-api 루트를 부르게 되므로 "/"로 만들어
        // 화이트리스트에서 걸리게 한다.
        assertThat(AiApiProxyController.pathAfterPrefix("/api/ai")).isEqualTo("/");
    }
}
