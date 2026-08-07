package com.aivle.bigproject.audio;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

// 브라우저(오퍼레이터) 쪽에서 특정 통화에 붙는 레그.
// 연결 시점에 CallRegistry에 그 통화의 유일한 오퍼레이터로 등록을 시도하고, 실패하면
// (통화가 없거나 이미 다른 오퍼레이터가 붙어 있으면) 곧바로 연결을 끊는다.
// 붙고 나면 마이크 μ-law 바이트와 (있다면) JSON 텍스트 프레임을 그대로 외부 통화 레그로 중계한다.
@Component
public class OperatorWebSocketHandler extends AbstractWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(OperatorWebSocketHandler.class);

    private final CallRegistry callRegistry;

    public OperatorWebSocketHandler(CallRegistry callRegistry) {
        this.callRegistry = callRegistry;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        String callId = callId(session);
        String email = (String) session.getAttributes().get(AudioStreamHandshakeInterceptor.ATTR_EMAIL);
        if (!callRegistry.attachOperator(callId, session, email)) {
            log.warn("cannot attach operator, call missing or already claimed: callId={}", callId);
            session.close(CloseStatus.POLICY_VIOLATION.withReason("call not available"));
            return;
        }
        log.info("operator connected: callId={} email={} session={}", callId, email, session.getId());
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
        callRegistry.relayToExternal(callId(session), message);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        callRegistry.relayToExternal(callId(session), message);
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.warn("operator transport error: callId={} session={}", callId(session), session.getId(), exception);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String callId = callId(session);
        callRegistry.detachOperator(callId, session);
        log.info("operator disconnected: callId={} session={} status={}", callId, session.getId(), status);
    }

    private static String callId(WebSocketSession session) {
        return (String) session.getAttributes().get(WsRequestUtils.ATTR_CALL_ID);
    }
}
