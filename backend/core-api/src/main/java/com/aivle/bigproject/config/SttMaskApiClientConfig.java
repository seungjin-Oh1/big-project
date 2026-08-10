package com.aivle.bigproject.config;

import java.net.http.HttpClient;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.http.converter.json.JacksonJsonHttpMessageConverter;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

// core-api가 stt-mask-api(FastAPI, POST /redact)를 서버 간으로 호출할 때 쓰는 RestClient 빈.
// 대면 상담 실시간 녹음의 STT는 이 RestClient를 거치지 않는다(InPersonCallInitiator가 별도의
// 외부 오디오 게이트웨이에 WebSocket으로 붙는다, app.audio.in-person-gateway-ws-url) — 여기
// 남은 유일한 용도는 상담원이 메모칸에 직접 적은 글자를 가리는 InPersonSttMaskClient.redactText다.
//
// ai-api와 같은 uvicorn 기반 서버라 AiApiClientConfig와 같은 이유로 HTTP/1.1을 강제한다
// (JDK HttpClient 기본값인 HTTP/2의 "Upgrade: h2c" 협상 헤더를 uvicorn이 처리하지 못해
// body를 못 읽고 실패하는 문제 — AiApiClientConfig 주석 참고).
//
// 요청·응답 모두 JSON({"text":...} / {"text":..., "redacted_text":...})이라 AiApiClientConfig와
// 똑같이 이 프로젝트의 Jackson 3(tools.jackson) 컨버터를 직접 등록해야 한다 — 안 하면 기본
// 컨버터 목록엔 Jackson 3용 JSON 리더가 없어 응답을 못 읽는다(같은 원인, AiApiClientConfig 주석 참고).
@Configuration
public class SttMaskApiClientConfig {

    @Bean
    public RestClient sttMaskApiRestClient(JsonMapper jsonMapper,
                                            @Value("${app.stt-mask-api.base-url}") String baseUrl) {
        HttpClient httpClient = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(httpClient);
        // 텍스트 가림 하나뿐이라 짧게 잡아도 되지만, 로컬 CPU 환경 편차를 감안해 여유를 둔다.
        requestFactory.setReadTimeout(Duration.ofSeconds(60));

        return RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(requestFactory)
                .messageConverters(converters -> converters.add(0, new JacksonJsonHttpMessageConverter(jsonMapper)))
                .build();
    }
}
