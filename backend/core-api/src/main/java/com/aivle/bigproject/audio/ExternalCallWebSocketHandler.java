package com.aivle.bigproject.audio;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

// 외부 서버(전화/SIP 게이트웨이 등) 쪽에서 붙는 통화 오디오 레그.
// 8비트 G.711 μ-law 바이트를 그대로 받아 CallRegistry를 통해 오퍼레이터 레그로 중계한다
// (오퍼레이터 쪽도 이미 μ-law로 보내므로 변환 없이 바이트 그대로 전달한다). 실시간 자막 등
// JSON 텍스트 프레임도 같은 방식으로 그대로 중계한다.
@Component
public class ExternalCallWebSocketHandler extends AbstractWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(ExternalCallWebSocketHandler.class);

    private final CallRegistry callRegistry;

    public ExternalCallWebSocketHandler(CallRegistry callRegistry) {
        this.callRegistry = callRegistry;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        String callId = callId(session);
        if (!callRegistry.registerExternalCall(callId, session)) {
            log.warn("duplicate callId, rejecting external connection: callId={}", callId);
            session.close(CloseStatus.POLICY_VIOLATION.withReason("call already exists"));
            return;
        }
        log.info("external call connected: callId={} session={}", callId, session.getId());
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
        callRegistry.relayToOperator(callId(session), message);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        callRegistry.relayToOperator(callId(session), message);
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.warn("external call transport error: callId={} session={}", callId(session), session.getId(), exception);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String callId = callId(session);
        callRegistry.removeExternalCall(callId, session);
        log.info("external call closed: callId={} session={} status={}", callId, session.getId(), status);
    }

    private static String callId(WebSocketSession session) {
        return (String) session.getAttributes().get(WsRequestUtils.ATTR_CALL_ID);
    }
}
