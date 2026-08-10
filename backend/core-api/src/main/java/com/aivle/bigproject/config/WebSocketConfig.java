package com.aivle.bigproject.config;

import com.aivle.bigproject.audio.AudioStreamHandshakeInterceptor;
import com.aivle.bigproject.audio.ExternalCallAuthInterceptor;
import com.aivle.bigproject.audio.ExternalCallWebSocketHandler;
import com.aivle.bigproject.audio.OperatorWebSocketHandler;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final ExternalCallWebSocketHandler externalCallWebSocketHandler;
    private final ExternalCallAuthInterceptor externalCallAuthInterceptor;
    private final OperatorWebSocketHandler operatorWebSocketHandler;
    private final AudioStreamHandshakeInterceptor audioStreamHandshakeInterceptor;
    // app.cors.allowed-origins(콤마 구분)를 WebConfig의 REST CORS 설정과 공유한다.
    private final String[] allowedOrigins;

    public WebSocketConfig(ExternalCallWebSocketHandler externalCallWebSocketHandler,
                           ExternalCallAuthInterceptor externalCallAuthInterceptor,
                           OperatorWebSocketHandler operatorWebSocketHandler,
                           AudioStreamHandshakeInterceptor audioStreamHandshakeInterceptor,
                           @Value("${app.cors.allowed-origins:http://localhost:5173}") String allowedOrigins) {
        this.externalCallWebSocketHandler = externalCallWebSocketHandler;
        this.externalCallAuthInterceptor = externalCallAuthInterceptor;
        this.operatorWebSocketHandler = operatorWebSocketHandler;
        this.audioStreamHandshakeInterceptor = audioStreamHandshakeInterceptor;
        this.allowedOrigins = allowedOrigins.split("\\s*,\\s*");
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // 필터 체인은 /ws/audio/**를 permitAll로 통과시키고, 인증은 각 핸드셰이크 인터셉터가 맡는다
        // (브라우저의 new WebSocket()에는 Authorization 헤더를 넣을 수 없어서 필터 체인만으로는
        // 막을 방법이 없다 — 막으면 브라우저가 붙을 방법이 아예 사라진다).

        // 외부 서버(전화/SIP 게이트웨이 등)가 통화 오디오를 흘려보내는 레그. 서버 대 서버 연결이라
        // 헤더를 자유롭게 붙일 수 있으므로 공유 비밀키로 인증한다.
        //
        // 대면 상담 녹음(InPersonCallInitiator)은 이 인바운드 엔드포인트를 타지 않는다 — core-api
        // 자신이 외부 오디오 게이트웨이(app.audio.in-person-gateway-ws-url)로 걸어 나가는
        // 아웃바운드 연결을 만들어 CallRegistry에 직접 등록한다. 다만 등록되고 나면 CallRegistry
        // 입장에서는 똑같은 "외부 레그"라 아래 오퍼레이터 레그가 통화든 녹음이든 구분 없이 중계된다.
        registry.addHandler(externalCallWebSocketHandler, "/ws/audio/external")
                .addInterceptors(externalCallAuthInterceptor);

        // 브라우저(오퍼레이터)가 특정 통화를 골라 붙는 레그. 1회성 티켓으로 인증한다.
        // 전화 상담뿐 아니라 대면 상담 녹음(useInPersonRecording.js)도 같은 엔드포인트를 쓴다 —
        // 오디오를 어디로 보내고 결과를 어떻게 되돌려받는지는 CallRegistry가 callId로 중계할 뿐,
        // 통화인지 녹음인지 구분하지 않는다.
        registry.addHandler(operatorWebSocketHandler, "/ws/audio/operator")
                .addInterceptors(audioStreamHandshakeInterceptor)
                .setAllowedOrigins(allowedOrigins);
    }

    // Tomcat(WebSocket 컨테이너)의 바이너리 메시지 버퍼 기본값은 8KB다. 전화 상담은 4096
    // 샘플짜리 μ-law 프레임(4KB)만 보내서 문제가 없었지만, 대면 상담 녹음은 5초마다 16kHz mono
    // 32비트 float PCM 조각(약 320KB, useInPersonRecording.js)을 그대로 보내서 기본값을 넘기면
    // Tomcat이 "No async message support and buffer too small"로 소켓을 정책 위반(1009) 종료시킨다.
    // supportsPartialMessages()로 조각내 받는 대신, 5초 오디오가 넉넉히 들어갈 만큼 버퍼를 키운다.
    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxBinaryMessageBufferSize(2 * 1024 * 1024);
        container.setMaxTextMessageBufferSize(64 * 1024);
        return container;
    }
}
