package com.aivle.bigproject.audio;

import com.aivle.bigproject.common.exception.AudioGatewayException;
import java.io.IOException;
import java.net.URI;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.WebSocketClient;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;
import org.springframework.web.socket.handler.WebSocketSessionDecorator;

// 대면 상담 녹음을 "통화"로 흉내 낸다. 실제 전화는 외부 SIP 게이트웨이가 /ws/audio/external로
// 걸어 들어와 CallRegistry에 외부 레그로 등록되지만(ExternalCallWebSocketHandler), 대면 녹음은
// 상대가 먼저 걸어올 이유가 없다 — 그래서 core-api 자신이 그 외부 게이트웨이(app.audio.
// in-person-gateway-ws-url)로 걸어 나가, 그 아웃바운드 연결을 똑같이 외부 레그로 등록한다.
// 등록되고 나면 그 뒤로는 OperatorWebSocketHandler·CallRegistry가 전화와 완전히 동일하게
// 취급한다 — 브라우저(useInPersonRecording.js)가 보내는 마이크 바이트는 그대로 게이트웨이로,
// 게이트웨이가 보내는 결과(JSON 텍스트 프레임)는 그대로 브라우저로 중계된다.
@Component
class InPersonCallInitiator {

    private static final Logger log = LoggerFactory.getLogger(InPersonCallInitiator.class);
    private static final long CONNECT_TIMEOUT_SECONDS = 10;

    private final CallRegistry callRegistry;
    private final WebSocketClient webSocketClient = new StandardWebSocketClient();
    private final String gatewayWsUrl;

    InPersonCallInitiator(CallRegistry callRegistry,
                          @Value("${app.audio.in-person-gateway-ws-url}") String gatewayWsUrl) {
        this.callRegistry = callRegistry;
        this.gatewayWsUrl = gatewayWsUrl;
    }

    // 새 callId로 "통화"를 열고, 외부 게이트웨이 연결을 외부 레그로 등록해둔다.
    // 반환한 뒤 프론트가 이 callId로 /ws/audio/operator에 붙으면 곧바로 오디오가 흐른다.
    String start() {
        if (gatewayWsUrl == null || gatewayWsUrl.isBlank()) {
            throw new AudioGatewayException("대면 녹음 게이트웨이 주소가 설정되지 않았습니다"
                    + "(IN_PERSON_AUDIO_GATEWAY_WS_URL 환경변수를 확인하세요)");
        }

        String callId = "inperson-" + UUID.randomUUID();
        RelayToOperatorHandler handler = new RelayToOperatorHandler(callId);
        WebSocketSession session;
        try {
            session = webSocketClient.execute(handler, null, URI.create(gatewayWsUrl))
                    .get(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (Exception e) {
            throw new AudioGatewayException("외부 오디오 게이트웨이 연결에 실패했습니다: " + e.getMessage(), e);
        }
        log.info("in-person gateway connected: callId={} url={}", callId, gatewayWsUrl);
        // CallRegistry에는 원본 대신 이 로깅 래퍼를 등록한다 — relayToExternal이 부르는
        // sendMessage()가 이 래퍼를 거치므로, 오퍼레이터(브라우저)에서 온 오디오/텍스트가
        // 게이트웨이로 나갈 때마다(=core-api가 "보낼" 때마다) 로그가 남는다. 받는 쪽은
        // RelayToOperatorHandler가 이미 같은 목적으로 존재하므로 거기에 로그를 더한다.
        WebSocketSession loggingSession = new LoggingWebSocketSession(session, callId);
        if (!callRegistry.registerExternalCall(callId, loggingSession)) {
            // UUID 충돌은 사실상 불가능하지만, 그래도 방금 연 연결은 정리한다.
            closeQuietly(session);
            throw new AudioGatewayException("녹음 세션을 등록하지 못했습니다(callId 충돌): " + callId);
        }
        log.info("in-person call registered: callId={}", callId);
        return callId;
    }

    private static void closeQuietly(WebSocketSession session) {
        try {
            if (session.isOpen()) {
                session.close(CloseStatus.NORMAL);
            }
        } catch (Exception e) {
            log.warn("failed to close in-person gateway session={}", session.getId(), e);
        }
    }

    // core-api -> 외부 게이트웨이 방향(오퍼레이터가 보낸 걸 그대로 내보내는 쪽)을 로깅하기 위한
    // 래퍼. CallRegistry.relayToExternal은 세션 종류(진짜 SIP 외부 레그인지, 이 게이트웨이인지)를
    // 모르고 그냥 sendMessage()만 부르므로, 로그를 CallRegistry 쪽에 넣으면 전화 통화까지 다
    // 찍힌다 — 그래서 여기, 이 게이트웨이 세션에만 로그가 남도록 얇게 감싼다.
    private static final class LoggingWebSocketSession extends WebSocketSessionDecorator {

        private final String callId;

        LoggingWebSocketSession(WebSocketSession delegate, String callId) {
            super(delegate);
            this.callId = callId;
        }

        @Override
        public void sendMessage(WebSocketMessage<?> message) throws IOException {
            if (message instanceof BinaryMessage binary) {
                log.info("in-person gateway <- send binary: callId={} bytes={}", callId, binary.getPayloadLength());
            } else if (message instanceof TextMessage text) {
                log.info("in-person gateway <- send text: callId={} payload={}", callId, text.getPayload());
            }
            super.sendMessage(message);
        }
    }

    // 외부 게이트웨이가 보내는 프레임을 그대로 오퍼레이터(브라우저)에게 돌려주는 핸들러.
    // ExternalCallWebSocketHandler와 대칭이다 — 저쪽은 core-api가 인바운드로 받는 서버 핸들러이고,
    // 이쪽은 core-api가 아웃바운드로 붙인 클라이언트 세션의 핸들러라는 점만 다르다.
    private class RelayToOperatorHandler extends AbstractWebSocketHandler {

        private final String callId;

        RelayToOperatorHandler(String callId) {
            this.callId = callId;
        }

        @Override
        protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
            log.info("in-person gateway -> recv binary: callId={} bytes={}", callId, message.getPayloadLength());
            callRegistry.relayToOperator(callId, message);
        }

        @Override
        protected void handleTextMessage(WebSocketSession session, TextMessage message) {
            log.info("in-person gateway -> recv text: callId={} payload={}", callId, message.getPayload());
            callRegistry.relayToOperator(callId, message);
        }

        @Override
        public void handleTransportError(WebSocketSession session, Throwable exception) {
            log.warn("in-person gateway transport error: callId={} session={}", callId, session.getId(), exception);
        }

        @Override
        public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
            callRegistry.removeExternalCall(callId, session);
            log.info("in-person gateway connection closed: callId={} session={} status={}",
                    callId, session.getId(), status);
        }
    }
}
