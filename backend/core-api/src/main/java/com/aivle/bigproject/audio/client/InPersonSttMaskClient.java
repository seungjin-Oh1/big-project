package com.aivle.bigproject.audio.client;

import com.aivle.bigproject.common.exception.SttMaskApiException;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

// stt-mask-api(FastAPI)의 POST /transcribe 하나만 호출하는 좁은 책임의 클라이언트.
// 대면 상담 실시간 녹음이 5초 단위로 보내는 오디오 조각(그 자체로 완결된 파일) 하나를
// 그대로 멀티파트로 넘기고, STT 원문 + 개인정보 마스킹본을 받아온다.
//
// 응답을 SttMaskApiResponse 같은 레코드로 바로 매핑하지 않고 JsonNode로 받는 이유:
// stt-mask-api 실패 응답이 성공 응답({"text":..., "redacted_text":...})과 모양이 다르고
// ({"error":...} 또는 FastAPI 검증 실패 시 {"detail":...}), 하나의 레코드 타입으로 받을 수 없어
// JsonNode로 우선 받고 형태를 본다.
//
// 500(등 에러 상태코드) 응답은 RestClient.retrieve()가 body()까지 가기 전에 예외로 던지므로,
// 실제 에러 본문({"error": "..."})은 그 예외(HttpStatusCodeException)의 응답 바디에서 따로
// 읽어야 한다 — 안 그러면 "500 Internal Server Error"라는 상태줄만 남고 진짜 원인(예: 오디오
// 디코딩 실패 사유)이 로그에서 사라진다.
@Component
public class InPersonSttMaskClient {

    private static final Logger log = LoggerFactory.getLogger(InPersonSttMaskClient.class);

    public record Result(String text, String maskedText) {
    }

    private final RestClient sttMaskApiRestClient;
    private final JsonMapper jsonMapper;

    public InPersonSttMaskClient(RestClient sttMaskApiRestClient, JsonMapper jsonMapper) {
        this.sttMaskApiRestClient = sttMaskApiRestClient;
        this.jsonMapper = jsonMapper;
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

    public Result transcribeAndMask(byte[] audioChunk, String fileName) {
        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("file", new ByteArrayResource(audioChunk) {
            @Override
            public String getFilename() {
                return fileName;
            }
        });

        JsonNode response;
        try {
            response = sttMaskApiRestClient.post()
                    .uri("/transcribe")
                    .contentType(MediaType.MULTIPART_FORM_DATA)
                    .body(body)
                    .retrieve()
                    .body(JsonNode.class);
        } catch (HttpStatusCodeException e) {
            throw new SttMaskApiException("stt-mask-api가 오류를 반환했습니다(" + e.getStatusCode() + "): "
                    + extractErrorDetail(e), e);
        } catch (RestClientException e) {
            throw new SttMaskApiException("stt-mask-api 호출에 실패했습니다: " + e.getMessage(), e);
        }

        if (response == null || !response.path("text").isTextual() || !response.path("redacted_text").isTextual()) {
            throw new SttMaskApiException("stt-mask-api가 예상과 다른 응답을 반환했습니다: " + response);
        }
        return new Result(response.path("text").asText(), response.path("redacted_text").asText());
    }

    private String extractErrorDetail(HttpStatusCodeException e) {
        String raw = e.getResponseBodyAsString();
        if (raw == null || raw.isBlank()) {
            return e.getMessage();
        }
        try {
            JsonNode body = jsonMapper.readTree(raw);
            if (body.path("error").isTextual()) {
                return body.path("error").asText();
            }
            if (body.path("detail").isTextual()) {
                return body.path("detail").asText();
            }
            return raw;
        } catch (RuntimeException parseError) {
            return raw;
        }
    }
}
