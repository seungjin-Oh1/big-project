package com.aivle.bigproject.audio.dto;

// POST /api/audio/in-person-calls 응답. 프론트는 이 callId로 /ws/audio/operator에 붙는다
// (전화 상담과 같은 엔드포인트 — AudioSessionController 참고).
public record InPersonCallResponse(String callId) {
}
