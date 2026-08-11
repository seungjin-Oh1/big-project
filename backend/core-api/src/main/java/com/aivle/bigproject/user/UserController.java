package com.aivle.bigproject.user;

import com.aivle.bigproject.user.dto.UserRequest;
import com.aivle.bigproject.user.dto.UserResponse;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

// HTTP 요청을 받아서 UserService에 그대로 위임하는 계층.
// 여기엔 업무 로직을 넣지 않고, "요청을 받아서 → 서비스 호출 → 응답 반환"만 함.
@RestController
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    // POST /api/users — 상담원 생성
    @PostMapping("/api/users")
    @ResponseStatus(HttpStatus.CREATED) // 201 Created
    public UserResponse create(@RequestBody UserRequest request) {
        return userService.create(request);
    }

    // GET /api/users — 전체 목록
    @GetMapping("/api/users")
    public List<UserResponse> findAll() {
        return userService.findAll();
    }

    // GET /api/users/me — 로그인한 본인. 목록과 달리 누구나 부를 수 있다(자기 것만 나온다).
    // 상담을 만들 때 필요한 userId를 여기서 얻는다 — 예전처럼 전체 목록을 받아 이메일로
    // 찾을 필요가 없다(UserService.getByEmail 주석 참고).
    //
    // 이 매핑이 아래 /api/users/{id}보다 먼저 잡힌다. 스프링은 경로 변수보다 고정 문자열을
    // 우선하므로 "me"가 id로 해석되지 않는다.
    @GetMapping("/api/users/me")
    public UserResponse findMe(Authentication authentication) {
        // JwtAuthenticationFilter가 principal 이름에 이메일을 넣는다.
        return userService.getByEmail(authentication.getName());
    }

    // GET /api/users/{id} — 단건 조회, 없으면 UserService에서 404 던짐 (ADMIN 전용, SecurityConfig 참고)
    @GetMapping("/api/users/{id}")
    public UserResponse findById(@PathVariable Long id) {
        return userService.get(id);
    }

    // GET /api/users/pending — 관리자 승인 대기 목록 (ADMIN 전용, SecurityConfig 참고)
    @GetMapping("/api/users/pending")
    public List<UserResponse> findPending() {
        return userService.findPending();
    }

    // POST /api/users/{id}/approve — 가입 승인 (ADMIN 전용)
    @PostMapping("/api/users/{id}/approve")
    public UserResponse approve(@PathVariable Long id) {
        return userService.approve(id);
    }

    // POST /api/users/{id}/reject — 가입 거절 (ADMIN 전용)
    @PostMapping("/api/users/{id}/reject")
    public UserResponse reject(@PathVariable Long id) {
        return userService.reject(id);
    }
}
