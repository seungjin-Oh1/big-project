package com.aivle.bigproject.audio.client;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import tools.jackson.databind.JsonNode;

// stt-mask-api(FastAPI)의 POST /redact를 호출하는 좁은 책임의 클라이언트.
//
// 대면 상담 실시간 녹음의 STT+마스킹은 core-api를 거치지 않는다 — useInPersonRecording.js가
// /ws/audio/operator로 붙어 전화 상담과 같은 CallRegistry 중계 경로를 타고, "외부 레그"로
// core-api가 외부 오디오 게이트웨이에 걸어 나가 붙는다(InPersonCallInitiator, app.audio.
// in-person-gateway-ws-url). 이 클라이언트가 남아 있는 이유는 그것과 무관한 별개 용도 하나
// 때문이다 — 상담원이 메모칸에 직접 적거나 붙여넣은 글자를 가리는 것(ConsultationService,
// AiAnalysisService).
@Component
public class InPersonSttMaskClient {

    private static final Logger log = LoggerFactory.getLogger(InPersonSttMaskClient.class);

    private final RestClient sttMaskApiRestClient;

    public InPersonSttMaskClient(RestClient sttMaskApiRestClient) {
        this.sttMaskApiRestClient = sttMaskApiRestClient;
    }

    // 이미 글자로 있는 상담 내용을 가린다(stt-mask-api POST /redact).
    //
    // 마스킹본은 지금까지 실시간 녹음 경로에서만 만들어졌다. 상담원이 메모칸에 직접
    // 적거나 붙여넣은 내용은 가림을 거칠 데가 없어서, 상담 30건 중 28건이 마스킹본
    // 0건이었다. 그러면 ai-api로 보내는 anonymized_text가 비고, 화면의 '개인정보 가림'
    // 미리보기도 영영 비어 있다.
    //
    // 가림에 실패해도 예외를 올리지 않는다. 상담 저장이 마스킹 서버 사정으로 막히면
    // 상담원이 적어 둔 내용을 잃는다 — 가림은 부가 기능이고 원문 보존이 우선이다.
    // 실패하면 빈 문자열을 돌려주고, 그건 '아직 가리지 못했다'와 같은 상태다.
    public String redactText(String text) {
        if (text == null || text.isBlank()) {
            return "";
        }
        try {
            JsonNode response = sttMaskApiRestClient.post()
                    .uri("/redact")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(Map.of("text", text))
                    .retrieve()
                    .body(JsonNode.class);
            if (response != null && response.path("redacted_text").isTextual()) {
                return response.path("redacted_text").asText();
            }
            log.warn("stt-mask-api /redact가 예상과 다른 응답을 반환했습니다: {}", response);
        } catch (RestClientException e) {
            log.warn("stt-mask-api /redact 호출 실패, 가림 없이 진행합니다: {}", e.getMessage());
        }
        return "";
    }
}
