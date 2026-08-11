package com.aivle.bigproject.auth.dto;

// captchaId·captchaAnswer는 실패가 몇 번 쌓인 뒤부터만 필요하다
// (LoginAttemptTracker.captchaRequired). 평소에는 비어서 온다.
public record LoginRequest(String email, String password, String captchaId, String captchaAnswer) {
}
