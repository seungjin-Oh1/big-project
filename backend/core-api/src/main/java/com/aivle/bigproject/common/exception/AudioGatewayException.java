package com.aivle.bigproject.common.exception;

// 대면 상담 녹음이 외부 오디오 게이트웨이(InPersonCallInitiator가 걸어 나가는 상대편)에
// 연결하지 못했을 때 던지는 예외. AiApiException과 같은 이유로 별도 타입을 둔다 —
// core-api 자체 문제가 아니라 의존하는 외부 시스템 문제라는 걸 구분하기 위해서.
public class AudioGatewayException extends RuntimeException {
    public AudioGatewayException(String message, Throwable cause) {
        super(message, cause);
    }

    public AudioGatewayException(String message) {
        super(message);
    }
}
