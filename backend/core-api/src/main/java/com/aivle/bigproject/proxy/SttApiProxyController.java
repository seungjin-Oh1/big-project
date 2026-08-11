package com.aivle.bigproject.proxy;

import com.aivle.bigproject.common.exception.BadRequestException;
import com.aivle.bigproject.storage.UploadFilePolicy;
import java.util.Set;
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

    private final RestClient restClient;

    public SttApiProxyController(RestClient sttTranscribeRestClient) {
        this.restClient = sttTranscribeRestClient;
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

        try {
            return restClient.post()
                    .uri("/transcribe")
                    .contentType(MediaType.MULTIPART_FORM_DATA)
                    .body(parts)
                    // 상태코드와 본문을 있는 그대로 넘긴다. stt-mask-api는 실패를
                    // {"error": ...} 본문에 담아 주는데(main.py transcribe_audio),
                    // 그걸 삼키면 화면에 "변환 실패"만 뜨고 이유가 사라진다.
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
    }
}
