package com.aivle.bigproject.proxy;

import com.aivle.bigproject.audio.client.InPersonSttMaskClient;
import com.aivle.bigproject.common.exception.BadRequestException;
import com.aivle.bigproject.storage.UploadFilePolicy;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.multipart.MultipartFile;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

// 브라우저가 stt-mask-api를 직접 부르지 않고 core-api를 거치게 하는 통로.
//
// AiApiProxyController와 같은 이유다 — stt-mask-api에도 인증이 없다. 게다가 이쪽은
// GPU를 쓰는 Whisper라, 외부에 열려 있으면 아무나 음성 하나 던져서 인스턴스를 통째로
// 붙잡아 둘 수 있다. 배포에서는 VPC 안에서 core-api만 닿게 하고 nginx에는 열지 않는다.
//
// 대면 상담 실시간 녹음은 이 경로가 아니다(WebSocket /ws/audio/**). 여기는 상담원이
// 자료 화면에서 음성파일을 올렸을 때 텍스트로 바꾸는 한 건짜리 경로다
// (프론트 UploadWorkbench.uploadPendingFiles).
@RestController
@RequestMapping("/api/stt")
public class SttApiProxyController {

    private static final Logger log = LoggerFactory.getLogger(SttApiProxyController.class);

    private final RestClient restClient;
    private final InPersonSttMaskClient sttMaskClient;
    private final JsonMapper jsonMapper;

    public SttApiProxyController(RestClient sttTranscribeRestClient,
                                  InPersonSttMaskClient sttMaskClient,
                                  JsonMapper jsonMapper) {
        this.restClient = sttTranscribeRestClient;
        this.sttMaskClient = sttMaskClient;
        this.jsonMapper = jsonMapper;
    }

    // STT에 넣을 수 있는 오디오 컨테이너. 첨부파일 정책(UploadFilePolicy)과 목록이 다르다 —
    // 그쪽은 S3에 보관할 자료의 규칙이고, 여기는 Whisper에 넣을 수 있느냐의 문제다.
    // webm은 브라우저 녹음(MediaRecorder)이 만드는 형식이라 S3에는 안 올라가도 전사는 된다.
    private static final Set<String> ALLOWED_AUDIO_EXTENSIONS =
            Set.of("mp3", "wav", "m4a", "webm", "ogg", "flac");

    @PostMapping("/transcribe")
    public ResponseEntity<String> transcribe(@RequestPart("file") MultipartFile file) {
        // 예전에는 브라우저가 stt-mask-api로 곧장 보냈으니 아무 파일이나 통과했다.
        // 여기를 거치게 된 김에 확장자와 크기를 확인한다. 파일명 정리는 첨부파일과 같은
        // 함수를 쓴다(경로 문자·개행 제거) — 그대로 넘기면 multipart 헤더에 실린다.
        String safeName = UploadFilePolicy.sanitizeFileName(file.getOriginalFilename());
        String extension = UploadFilePolicy.extensionOf(safeName);
        if (!ALLOWED_AUDIO_EXTENSIONS.contains(extension)) {
            throw new BadRequestException(
                    "음성 변환을 지원하지 않는 형식입니다: " + (extension.isEmpty() ? "(확장자 없음)" : "." + extension));
        }
        if (file.getSize() > UploadFilePolicy.MAX_SIZE_BYTES) {
            throw new BadRequestException("파일이 너무 큽니다. %dMB까지 올릴 수 있습니다."
                    .formatted(UploadFilePolicy.MAX_SIZE_BYTES / 1024 / 1024));
        }

        MultiValueMap<String, Object> parts = new LinkedMultiValueMap<>();
        // getResource()는 파일명과 길이를 그대로 들고 있어서 파트가 스트리밍으로 나간다.
        // getBytes()로 받으면 녹취 한 건이 통째로 힙에 올라온다.
        parts.add("file", file.getResource());

        ResponseEntity<String> upstream;
        try {
            upstream = restClient.post()
                    .uri("/stt/transcribe")
                    .contentType(MediaType.MULTIPART_FORM_DATA)
                    .body(parts)
                    // 상태코드와 본문을 있는 그대로 받는다. ai-api는 실패를
                    // {"detail": ...}에 담아 주는데, 그걸 삼키면 화면에 "변환 실패"만
                    // 뜨고 이유가 사라진다.
                    .exchange((req, res) -> {
                        String body = new String(res.getBody().readAllBytes(),
                                java.nio.charset.StandardCharsets.UTF_8);
                        return ResponseEntity.status(res.getStatusCode())
                                .contentType(MediaType.APPLICATION_JSON)
                                .body(body);
                    });
        } catch (ResourceAccessException e) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"error\":\"STT 서버에 연결할 수 없습니다.\"}");
        }

        if (!upstream.getStatusCode().is2xxSuccessful()) {
            return upstream;
        }
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_JSON)
                .body(withRedactedText(upstream.getBody()));
    }

    // 전사 결과에 가림본을 붙여 돌려준다.
    //
    // 예전에는 stt-mask-api 한 곳이 전사와 가림을 함께 해서 응답에 redacted_text가
    // 들어 있었다. 전사를 ai-api로 옮기면서 그 서버는 원문만 돌려주는데, 프론트는
    // 여전히 redacted_text를 읽는다(sttApiClient.js). 그대로 두면 업로드한 파일의
    // '개인정보 가림' 미리보기가 조용히 빈칸이 된다 — 가려진 것처럼 보이는 빈칸이
    // 아니라 아예 없는 상태라, 화면만 봐서는 가림이 사라진 걸 알 수 없다.
    //
    // 그래서 여기서 가림 서버를 한 번 더 부른다. 실패해도 원문은 그대로 돌려준다
    // (redactText가 예외 대신 빈 문자열을 준다) — 가림 서버 사정으로 변환 결과를
    // 통째로 잃는 것이 더 나쁘다.
    private String withRedactedText(String body) {
        if (body == null || body.isBlank()) {
            return "{}";
        }
        try {
            JsonNode parsed = jsonMapper.readTree(body);
            if (!(parsed instanceof ObjectNode source)) {
                // 객체가 아니면 붙일 자리가 없다. 있는 그대로 넘긴다.
                return body;
            }
            String text = parsed.path("text").asString("");
            // 원래 응답의 다른 필드도 남긴다 — 나중에 ai-api가 뭘 더 붙이더라도
            // 여기서 조용히 잘려 나가지 않게.
            ObjectNode merged = jsonMapper.createObjectNode();
            merged.setAll(source);
            merged.put("redacted_text", sttMaskClient.redactText(text));
            return merged.toString();
        } catch (RuntimeException e) {
            log.warn("전사 응답에 가림본을 붙이지 못했습니다. 원문만 돌려줍니다: {}", e.getMessage());
            return body;
        }
    }
}
