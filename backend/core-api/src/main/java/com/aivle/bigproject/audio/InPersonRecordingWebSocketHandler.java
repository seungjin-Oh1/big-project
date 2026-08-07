package com.aivle.bigproject.audio;

import com.aivle.bigproject.audio.client.InPersonSttMaskClient;
import com.aivle.bigproject.common.exception.SttMaskApiException;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;
import tools.jackson.databind.json.JsonMapper;

// 대면 상담 녹음(브라우저)의 /ws/audio/in-person 레그.
//
// 이쪽은 "녹음 종료" 신호({"type":"end"})를 같은 소켓으로 받아야 해서, 전화 상담 레그들과
// 마찬가지로 텍스트/바이너리를 모두 다루는 AbstractWebSocketHandler를 직접 상속한다.
//
// 브라우저가 MediaRecorder를 5초마다 stop→restart 해서 보내는 각 바이너리 프레임은 그 자체로
// 완결된 오디오 파일이다(useInPersonRecording.js 참고) — 그래서 여러 프레임을 이어붙이거나
// 버퍼링할 필요 없이, 받은 프레임 하나하나를 그대로 stt-mask-api에 넘기고 결과를 바로 돌려준다.
@Component
public class InPersonRecordingWebSocketHandler extends AbstractWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(InPersonRecordingWebSocketHandler.class);
    private static final String ATTR_CHUNK_INDEX = "inPersonChunkIndex";

    private final InPersonSttMaskClient sttMaskClient;
    private final JsonMapper jsonMapper;

    public InPersonRecordingWebSocketHandler(InPersonSttMaskClient sttMaskClient, JsonMapper jsonMapper) {
        this.sttMaskClient = sttMaskClient;
        this.jsonMapper = jsonMapper;
    }

    private record SegmentResultMessage(String type, int idx, String text, String maskedText) {
    }

    private record SegmentErrorMessage(String type, int idx, String error) {
    }

    private record DoneMessage(String type) {
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        session.getAttributes().put(ATTR_CHUNK_INDEX, new AtomicInteger(0));
        log.info("in-person recording connected: consultationId={} session={}",
                consultationId(session), session.getId());
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) throws Exception {
        AtomicInteger counter = (AtomicInteger) session.getAttributes().get(ATTR_CHUNK_INDEX);
        int idx = counter.getAndIncrement();
        // ByteBuffer.array()는 안 됨 — Tomcat이 세션마다 재사용하는 더 큰 내부 버퍼를 그대로
        // 돌려주므로(=maxBinaryMessageBufferSize 크기), remaining()을 무시하고 array() 전체를
        // 쓰면 실제 오디오 뒤에 남은 버퍼 쓰레기까지 같이 보내 stt-mask-api가 매번 디코딩에
        // 실패한다. remaining() 길이만큼만 정확히 복사해야 한다.
        ByteBuffer payload = message.getPayload();
        byte[] chunk = new byte[payload.remaining()];
        payload.get(chunk);
        try {
            InPersonSttMaskClient.Result result = sttMaskClient.transcribeAndMask(chunk, "chunk-" + idx + ".webm");
            sendJson(session, new SegmentResultMessage("segment_result", idx, result.text(), result.maskedText()));
        } catch (SttMaskApiException e) {
            log.warn("in-person chunk transcribe failed: consultationId={} idx={}", consultationId(session), idx, e);
            sendJson(session, new SegmentErrorMessage("segment_error", idx, e.getMessage()));
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        var payload = jsonMapper.readTree(message.getPayload());
        if ("end".equals(payload.path("type").asText(null))) {
            sendJson(session, new DoneMessage("done"));
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.warn("in-person recording transport error: consultationId={} session={}",
                consultationId(session), session.getId(), exception);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        log.info("in-person recording disconnected: consultationId={} session={} status={}",
                consultationId(session), session.getId(), status);
    }

    private void sendJson(WebSocketSession session, Object payload) throws java.io.IOException {
        if (session.isOpen()) {
            session.sendMessage(new TextMessage(jsonMapper.writeValueAsString(payload)));
        }
    }

    private static String consultationId(WebSocketSession session) {
        return (String) session.getAttributes().get(InPersonAudioHandshakeInterceptor.ATTR_CONSULTATION_ID);
    }
}
