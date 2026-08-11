package com.aivle.bigproject.auth.dto;

import com.aivle.bigproject.user.UserRole;

// passwordExpired는 "비밀번호를 바꿔야 한다"는 신호다(보호조치 기준 제4조 — 비밀번호 유효기간).
// 로그인 자체를 막지는 않는다. 상담 중에 갑자기 못 들어가는 것이 더 큰 사고이고,
// 화면이 이 값을 보고 비밀번호 변경으로 안내한다.
public record AuthResponse(String token, Long userId, String name, UserRole role, String email,
                            boolean passwordExpired) {
}
