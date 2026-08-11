package com.aivle.bigproject.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
// Spring Boot 4에서 패키지가 옮겨졌다. 예전 이름(org.springframework.boot.test.autoconfigure.web.servlet)은
// 이제 존재하지 않아 컴파일 자체가 안 된다.
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

// /api/users 계열의 접근 규칙.
//
// 이 테스트가 있는 이유는 실제로 사고가 났기 때문이다. 응답(UserResponse)에 연락처·소속이
// 추가되면서 목록을 관리자 전용으로 좁혔는데, 프론트가 상담을 만들 때 넣을 userId를
// 알아내려고 바로 그 목록을 부르고 있었다. 상담원은 첫 요청에서 403을 맞았고, 화면은
// 로컬에만 저장한 뒤 "저장 완료"라고 표시했다 — 저장된 것처럼 보이지만 서버에는 없고,
// 분석을 시작할 때가 되어서야 "Core API에 저장되지 않은 상담입니다"로 드러났다.
//
// 그래서 두 가지를 함께 고정한다.
//   1. 남의 정보(목록·단건)는 관리자만 본다
//   2. 본인 조회(/api/users/me)는 누구나 된다 — 이게 막히면 상담 생성이 통째로 죽는다
//
// 규칙 순서에 민감하다. /api/users/me 규칙이 /api/users/* 아래로 내려가면 me도 관리자
// 전용이 되어 같은 사고가 반복된다.
// RANDOM_PORT로 진짜 톰캣을 띄운다. 기본값(MOCK)으로는 컨텍스트가 뜨지 않는다 —
// WebSocketConfig의 ServerContainer 빈이 실제 서블릿 컨테이너를 요구하기 때문이다
// (BigprojectApplicationTests도 같은 이유로 RANDOM_PORT를 쓴다).
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
class UserEndpointAccessTest {

    @Autowired
    private MockMvc mockMvc;

    // 인가 규칙만 본다. 통과한 뒤 컨트롤러가 무엇을 돌려주는지(200/404)는 여기 관심사가 아니다 —
    // 가짜 로그인 계정은 DB에 없으므로 조회가 404로 끝나는 게 정상이다. 403만 아니면 규칙은 통과다.
    private void assertNotForbidden(String path, String role) throws Exception {
        int status = mockMvc.perform(get(path).with(user("someone@test.test").roles(role)))
                .andReturn().getResponse().getStatus();
        assertThat(status).as("%s (%s) 는 인가에서 막히면 안 된다", path, role).isNotEqualTo(403);
    }

    private void assertForbidden(String path, String role) throws Exception {
        mockMvc.perform(get(path).with(user("someone@test.test").roles(role)))
                .andExpect(status().isForbidden());
    }

    @Test
    @DisplayName("본인 조회는 상담원·변호사도 된다 (상담 생성이 여기에 걸려 있다)")
    void meIsOpenToEveryLoggedInUser() throws Exception {
        assertNotForbidden("/api/users/me", "CONSULTANT");
        assertNotForbidden("/api/users/me", "LAWYER");
        assertNotForbidden("/api/users/me", "ADMIN");
    }

    @Test
    @DisplayName("전체 목록은 관리자만 — 응답에 전 직원의 연락처·소속이 들어 있다")
    void listIsAdminOnly() throws Exception {
        assertForbidden("/api/users", "CONSULTANT");
        assertForbidden("/api/users", "LAWYER");
        assertNotForbidden("/api/users", "ADMIN");
    }

    @Test
    @DisplayName("단건 조회도 관리자만 — id만 바꿔 부르면 목록을 막은 의미가 없다")
    void findByIdIsAdminOnly() throws Exception {
        assertForbidden("/api/users/1", "CONSULTANT");
        assertForbidden("/api/users/1", "LAWYER");
    }

    @Test
    @DisplayName("승인 대기 목록은 관리자만")
    void pendingIsAdminOnly() throws Exception {
        assertForbidden("/api/users/pending", "CONSULTANT");
        assertNotForbidden("/api/users/pending", "ADMIN");
    }

    @Test
    @DisplayName("로그인하지 않으면 본인 조회도 안 된다")
    void meRequiresLogin() throws Exception {
        mockMvc.perform(get("/api/users/me")).andExpect(status().isForbidden());
    }
}
