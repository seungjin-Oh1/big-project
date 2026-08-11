package com.aivle.bigproject.storage;

import com.aivle.bigproject.common.exception.BadRequestException;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

// 업로드 파일 검증 규칙 (시큐어코딩 가이드 "위험한 형식 파일 업로드").
//
// 실제 파일 바이트는 브라우저가 presigned URL로 S3에 직접 올려서 서버를 거치지 않는다.
// 그래서 스프링의 multipart 제한이 걸리지 않고, 서버가 개입할 수 있는 지점은
// presigned URL을 발급하는 순간뿐이다. 허용하지 않을 파일이면 그때 URL을 내주지 않는다.
//
// 여기서 막는 것과 못 막는 것을 구분해 둔다:
//   막는다    허용하지 않은 확장자, 확장자와 contentType이 어긋나는 요청,
//             경로 문자·개행이 섞인 파일명, 너무 큰 파일(클라이언트가 알려준 크기 기준)
//   못 막는다 실제 내용이 확장자와 다른 파일(예: .png인데 내용은 실행파일).
//             내용 검사는 바이트를 봐야 하는데 서버를 지나가지 않는다.
//             S3 이벤트로 업로드 후 검사하는 방식이 필요하며, 그건 별도 작업이다.
public final class UploadFilePolicy {

    // 화면에서 실제로 받는 자료만 허용한다(workflows.jsx uploadCategoryAccept의 합집합).
    //   녹취록    mp3 wav m4a
    //   증빙자료  pdf hwp hwpx doc docx txt
    //   신분증    jpg jpeg png
    // 화면은 고른 자료 유형에 맞는 확장자만 받지만, 여기서는 유형을 알 수 없으므로
    // (업로드 요청에 자료 유형이 실리지 않는다) 세 유형의 합집합을 허용한다.
    // 여기 없는 확장자는 서식 분석에도 STT에도 쓰이지 않으므로 받을 이유가 없다.
    private static final Map<String, Set<String>> ALLOWED = Map.ofEntries(
            Map.entry("mp3", Set.of("audio/mpeg", "audio/mp3")),
            Map.entry("wav", Set.of("audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave")),
            Map.entry("m4a", Set.of("audio/mp4", "audio/m4a", "audio/x-m4a")),
            Map.entry("pdf", Set.of("application/pdf")),
            Map.entry("hwp", Set.of("application/x-hwp", "application/haansofthwp", "application/vnd.hancom.hwp")),
            // haansofthwpx는 한컴오피스가 깔린 Windows에서 브라우저가 .hwpx에 붙이는 값이다.
            // hwp 쪽에는 haansofthwp가 있는데 hwpx 쪽에만 빠져 있어서, 한컴오피스를 쓰는
            // 사람은 .hwpx를 아예 올릴 수 없었다("파일 확장자와 형식이 일치하지 않습니다").
            // 이 프로젝트가 다루는 서식이 전부 HWPX라 사실상 주 경로가 막혀 있던 셈이다.
            Map.entry("hwpx", Set.of("application/hwp+zip", "application/vnd.hancom.hwpx",
                    "application/haansofthwpx", "application/zip")),
            Map.entry("doc", Set.of("application/msword")),
            Map.entry("docx", Set.of("application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
            Map.entry("txt", Set.of("text/plain")),
            Map.entry("jpg", Set.of("image/jpeg")),
            Map.entry("jpeg", Set.of("image/jpeg")),
            Map.entry("png", Set.of("image/png"))
    );

    // 상담 녹취는 20~30분이 기본이라 넉넉히 잡는다. 그래도 상한은 둬야 한다 —
    // 없으면 한 번의 요청으로 버킷을 가득 채울 수 있다.
    public static final long MAX_SIZE_BYTES = 200L * 1024 * 1024; // 200MB

    // 파일명 길이 상한. S3 key 자체는 1024바이트까지지만, 앞에 UUID와 상담ID가 붙고
    // 한글은 UTF-8에서 3바이트를 쓰므로 여유를 두고 자른다.
    private static final int MAX_FILE_NAME_LENGTH = 150;

    // 경로를 벗어나거나 헤더를 조작할 수 있는 문자들. S3 key에 '/'가 들어가면 의도하지 않은
    // 위치에 오브젝트가 생기고, 개행이 들어가면 응답 헤더가 쪼개질 수 있다.
    private static final String UNSAFE_CHARS = "[\\\\/\\r\\n\\t\\u0000]";

    private UploadFilePolicy() {
    }

    // 브라우저가 알려준 크기. presigned 발급 요청에 크기가 없으면(구버전 프론트) null이 온다.
    public static void validate(String fileName, String contentType, Long sizeBytes) {
        String safeName = sanitizeFileName(fileName);
        String extension = extensionOf(safeName);

        Set<String> allowedContentTypes = ALLOWED.get(extension);
        if (allowedContentTypes == null) {
            throw new BadRequestException(
                    "허용하지 않는 파일 형식입니다: " + (extension.isEmpty() ? "(확장자 없음)" : "." + extension));
        }

        // contentType은 브라우저가 붙이는 값이라 신뢰할 수 없지만, 확장자와 어긋나면
        // 최소한 그 요청은 막는다. 값이 아예 없거나 일반적인 기본값이면 확장자를 따른다
        // (일부 브라우저는 hwp/hwpx에 빈 값이나 octet-stream을 보낸다).
        String normalizedContentType = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT).trim();
        int parameterIndex = normalizedContentType.indexOf(';'); // "text/plain; charset=utf-8"
        if (parameterIndex >= 0) {
            normalizedContentType = normalizedContentType.substring(0, parameterIndex).trim();
        }
        boolean unspecified = normalizedContentType.isEmpty()
                || normalizedContentType.equals("application/octet-stream");
        if (!unspecified && !allowedContentTypes.contains(normalizedContentType)) {
            throw new BadRequestException(
                    "파일 확장자와 형식이 일치하지 않습니다: ." + extension + " / " + contentType);
        }

        if (sizeBytes != null && sizeBytes > MAX_SIZE_BYTES) {
            throw new BadRequestException(
                    "파일이 너무 큽니다. %dMB까지 올릴 수 있습니다.".formatted(MAX_SIZE_BYTES / 1024 / 1024));
        }
    }

    // 저장에 쓸 안전한 파일명을 만든다. 경로 문자와 개행을 없애고, 앞뒤 점을 정리한다.
    // 원본 이름을 완전히 버리지는 않는다 — 상담원이 나중에 어떤 자료였는지 알아봐야 한다.
    public static String sanitizeFileName(String fileName) {
        String name = fileName == null ? "" : fileName.trim();
        // 경로가 통째로 들어오는 경우("C:\temp\a.pdf", "../../a.pdf")를 대비해 마지막 조각만 쓴다.
        int lastSeparator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (lastSeparator >= 0) {
            name = name.substring(lastSeparator + 1);
        }
        name = name.replaceAll(UNSAFE_CHARS, "");
        // 앞의 점은 숨김파일로 취급되거나 확장자 판별을 어긋나게 한다.
        while (name.startsWith(".")) {
            name = name.substring(1);
        }
        if (name.length() > MAX_FILE_NAME_LENGTH) {
            String extension = extensionOf(name);
            int keep = MAX_FILE_NAME_LENGTH - (extension.isEmpty() ? 0 : extension.length() + 1);
            name = name.substring(0, Math.max(keep, 1)) + (extension.isEmpty() ? "" : "." + extension);
        }
        if (name.isBlank()) {
            throw new BadRequestException("파일 이름이 올바르지 않습니다.");
        }
        return name;
    }

    // 마지막 점 뒤를 소문자로. 점이 없거나 마지막 문자가 점이면 빈 문자열.
    public static String extensionOf(String fileName) {
        if (fileName == null) {
            return "";
        }
        int dot = fileName.lastIndexOf('.');
        if (dot < 0 || dot == fileName.length() - 1) {
            return "";
        }
        return fileName.substring(dot + 1).toLowerCase(Locale.ROOT);
    }
}
