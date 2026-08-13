package com.aivle.bigproject.storage;

import org.springframework.core.io.Resource;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

// 테스트 끝나면 반드시 삭제할 것 — 실제 서비스 코드가 아님
//
// ── 2026-08-11 비활성화 ──────────────────────────────────────────────────
// @RestController와 @RequestMapping을 주석 처리해 엔드포인트 등록을 끊었다.
// 파일을 지우지 않은 이유는 이 파일이 내 것이 아니라서다 — 작성자(Fun1984)가
// 아직 쓰고 있을 수 있으니 되살릴 수 있게 코드는 남겨 둔다. 아래 두 줄의
// 주석만 풀면 그대로 돌아온다.
//
// 왜 끊었나: 인증 없이 S3에 올리고 내려받고 지우는 경로다. store(1L, file)은
// 상담 id를 1로 박아 두고 delete는 key만 주면 지운다. SecurityConfig가
// /test/**를 denyAll로 막고 있어 지금 뚫려 있지는 않지만, 그 한 줄이 언젠가
// 바뀌면 바로 열린다. 막는 곳이 한 군데뿐인 상태를 남겨 두지 않는다.
// 삭제 여부는 작성자 확인 후 결정한다.
// @RestController
// @RequestMapping("/test/s3")
public class S3TestController {

    private final S3FileStorageService s3FileStorageService;

    public S3TestController(S3FileStorageService s3FileStorageService) {
        this.s3FileStorageService = s3FileStorageService;
    }

    @PostMapping("/upload")
    public String upload(@RequestParam("file") MultipartFile file) {
        return s3FileStorageService.store(1L, file); // 반환된 key를 눈으로 확인
    }

    @GetMapping("/download")
    public ResponseEntity<Resource> download(@RequestParam String key) {
        Resource resource = s3FileStorageService.loadAsResource(key);
        return ResponseEntity.ok()
                .header("Content-Disposition", "attachment")
                .body(resource);
    }

    @GetMapping("/presigned-url")
    public String presignedUrl(@RequestParam String key) {
        return s3FileStorageService.getPresignedDownloadUrl(key, java.time.Duration.ofMinutes(10));
    }

    @DeleteMapping("/delete")
    public String delete(@RequestParam String key) {
        s3FileStorageService.delete(key);
        return "deleted: " + key;
    }
}