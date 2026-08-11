package com.aivle.bigproject.auth.dto;

import com.aivle.bigproject.user.UserRole;

// privacyAgreed는 개인정보 수집·이용 동의 여부다(개인정보 보호법 제15조 제2항).
// 화면에서 이미 동의 없이는 가입 버튼이 눌리지 않지만, /api/auth/register를 직접 부르면
// 그 검사를 지나칠 수 있어 서버에서도 확인한다.
// organization(소속기관/부서)·branch(지부)·phone(연락처)은 가입 화면이 필수로 받고 동의표에도
// 수집 항목으로 적어 두는 값이다. 예전에는 이 DTO에 없어서 서버까지 오지도 않았다 —
// 동의만 받고 보관하지 않는 상태였다(User 엔티티 주석 참고).
public record RegisterRequest(String name, UserRole role, String email, String password,
                              Boolean privacyAgreed,
                              String organization, String branch, String phone) {
}
