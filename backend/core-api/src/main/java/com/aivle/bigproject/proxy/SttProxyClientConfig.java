package com.aivle.bigproject.proxy;

import java.net.http.HttpClient;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.http.converter.FormHttpMessageConverter;
import org.springframework.web.client.RestClient;

// 업로드한 음성파일을 stt-mask-api로 넘길 때 쓰는 RestClient.
//
// 기존 sttMaskApiRestClient를 그대로 못 쓰는 이유가 둘이다.
//   1) 읽기 제한이 60초다. 그쪽은 상담원이 손으로 적은 메모 한 줄을 가리는 용도라
//      충분하지만(SttMaskApiClientConfig 주석), 여기는 20~30분짜리 녹취를 Whisper로
//      돌린다 — CPU로 돌면 1분 오디오에 수십 초가 걸려 60초로는 늘 끊긴다.
//   2) 그쪽은 JSON 컨버터만 달려 있다. 여기는 multipart로 파일을 보내야 한다.
//
// HTTP/1.1 고정은 같은 이유다. JDK HttpClient 기본값(HTTP/2)이 평문 연결에도 "Upgrade: h2c"를
// 얹어 보내는데 uvicorn이 이를 처리하지 못해 본문을 못 읽는다(AiApiClientConfig 주석 참고).
@Configuration
public class SttProxyClientConfig {

    // 주소를 stt-mask-api와 분리한 이유 —
    //
    // 예전에는 전사(/transcribe)와 가림(/redact)이 stt-mask-api 한 서버에 같이 있어서
    // base-url 하나로 충분했다. 지금은 갈라졌다.
    //   전사  ai-api                (/stt/transcribe)  whisper가 이미 있고 외부 의존이 없다
    //   가림  stt-mask-api-modal    (/redact)          가림 모델이 그쪽에 있다
    // 한 프로퍼티를 계속 공유하면 둘 중 하나는 반드시 엉뚱한 서버를 가리킨다.
    @Bean
    public RestClient sttTranscribeRestClient(@Value("${app.stt-transcribe.base-url}") String baseUrl) {
        HttpClient httpClient = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(httpClient);
        // 프론트가 STT 요청을 10분에서 끊으므로(sttApiClient.js STT_TIMEOUT_MS) 그보다 넉넉히 둔다.
        // 여기가 먼저 끊기면 사용자에게는 '연결 실패'로 보여서 원인을 알 수 없다.
        requestFactory.setReadTimeout(Duration.ofMinutes(15));

        // FormHttpMessageConverter는 기본으로 byte[]·String·Resource를 파트로 쓸 수 있게
        // 붙어 나온다. MultipartFile.getResource()를 그대로 실으므로 이걸로 충분하다.
        return RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(requestFactory)
                .messageConverters(converters -> converters.add(0, new FormHttpMessageConverter()))
                .build();
    }
}
