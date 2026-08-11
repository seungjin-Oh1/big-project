package com.aivle.bigproject.auth;

// 캡차가 필요하거나 답이 틀렸을 때. 화면은 이 응답을 받으면 캡차를 새로 받아 보여준다.
//
// UnauthorizedException(401)과 구분하는 이유: 401은 "아이디·비밀번호가 틀렸다"는 뜻으로
// 화면이 그 문구를 그대로 보여주는데, 캡차 때문에 막힌 것을 그렇게 알리면 비밀번호가
// 맞는데도 틀렸다고 안내하게 된다.
public class CaptchaRequiredException extends RuntimeException {

    public CaptchaRequiredException(String message) {
        super(message);
    }
}
