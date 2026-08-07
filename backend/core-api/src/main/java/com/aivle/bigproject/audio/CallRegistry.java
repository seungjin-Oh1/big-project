package com.aivle.bigproject.audio;

import com.aivle.bigproject.audio.dto.CallResponse;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

// 진행 중인 통화(외부 서버 레그 + 오퍼레이터 레그)를 관리하고 둘 사이에서 오디오 바이너리 프레임과
// (자막 등) JSON 텍스트 프레임을 그대로 중계하는 교환대(switchboard). 저장은 메모리다 —
// AudioStreamTicketService와 같은 이유로 지금은 서버가 한 대뿐이라 충분하다.
@Component
public class CallRegistry {

    private static final Logger log = LoggerFactory.getLogger(CallRegistry.class);

    // 실제 외부 통화 없이도 오퍼레이터 오디오 파이프라인(티켓 발급 → WS 연결 → 마이크 전송)을
    // 확인할 수 있도록 항상 열려 있는 디버그 전용 callId. 외부 레그가 없어서 relayToExternal이
    // 이 callId를 특별 취급해 오퍼레이터가 보낸 메시지를 그대로 되돌려 보낸다(서버 에코).
    public static final String DEBUG_LOOPBACK_CALL_ID = "debug-loopback";

    private final Map<String, Call> calls = new ConcurrentHashMap<>();

    public CallRegistry() {
        // externalSession 없이 등록해둔다 — registerExternalCall이 putIfAbsent라서 이후 이
        // callId로 진짜 외부 연결이 들어와도 거부되고, 이 항목은 항상 목록에 남는다.
        calls.put(DEBUG_LOOPBACK_CALL_ID, new Call(DEBUG_LOOPBACK_CALL_ID, null));
    }

    // 같은 callId로 이미 통화가 있으면 등록을 거부한다(중복 연결).
    boolean registerExternalCall(String callId, WebSocketSession externalSession) {
        Call call = new Call(callId, externalSession);
        return calls.putIfAbsent(callId, call) == null;
    }

    // 통화가 끝났으니 오퍼레이터가 붙어 있었다면 그쪽도 정리해서 끊어준다.
    //
    // session을 함께 받아 지금 등록된 세션이 맞는지 확인한다 — callId가 중복이라 등록이
    // 거부된 연결이 닫힐 때, 그 이벤트 때문에 원래(정상) 통화가 지워지는 걸 막기 위해서다.
    void removeExternalCall(String callId, WebSocketSession session) {
        Call call = calls.get(callId);
        if (call == null || call.externalSession() != session) {
            return;
        }
        calls.remove(callId, call);
        if (call.operatorSession() != null) {
            closeQuietly(call.operatorSession(), CloseStatus.NORMAL.withReason("call ended"));
        }
    }

    boolean attachOperator(String callId, WebSocketSession operatorSession, String operatorEmail) {
        Call call = calls.get(callId);
        return call != null && call.tryAttachOperator(operatorSession, operatorEmail);
    }

    void detachOperator(String callId, WebSocketSession operatorSession) {
        Call call = calls.get(callId);
        if (call != null) {
            call.detachOperator(operatorSession);
        }
    }

    // message는 오디오 BinaryMessage일 수도, 자막 등 JSON TextMessage일 수도 있다 — 어느 쪽이든
    // 내용을 들여다보지 않고 그대로 전달한다.
    void relayToOperator(String callId, WebSocketMessage<?> message) {
        Call call = calls.get(callId);
        if (call != null && call.operatorSession() != null) {
            sendQuietly(call.operatorSession(), message);
        }
    }

    void relayToExternal(String callId, WebSocketMessage<?> message) {
        if (DEBUG_LOOPBACK_CALL_ID.equals(callId)) {
            relayToOperator(callId, message);
            return;
        }
        Call call = calls.get(callId);
        if (call != null) {
            sendQuietly(call.externalSession(), message);
        }
    }

    public List<CallResponse> list() {
        return calls.values().stream()
                .map(call -> new CallResponse(
                        call.callId(),
                        call.operatorSession() != null ? "CONNECTED" : "WAITING",
                        call.connectedAt(),
                        call.operatorEmail()))
                .toList();
    }

    private static void sendQuietly(WebSocketSession session, WebSocketMessage<?> message) {
        try {
            if (session.isOpen()) {
                session.sendMessage(message);
            }
        } catch (IOException e) {
            log.warn("failed to relay message to session={}", session.getId(), e);
        }
    }

    private static void closeQuietly(WebSocketSession session, CloseStatus status) {
        try {
            if (session.isOpen()) {
                session.close(status);
            }
        } catch (IOException e) {
            log.warn("failed to close session={}", session.getId(), e);
        }
    }
}
