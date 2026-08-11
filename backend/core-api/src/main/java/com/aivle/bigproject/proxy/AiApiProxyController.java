package com.aivle.bigproject.proxy;

import java.util.Set;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.servlet.HandlerMapping;
import jakarta.servlet.http.HttpServletRequest;
import tools.jackson.databind.JsonNode;

// 브라우저가 ai-api를 직접 부르지 않고 core-api를 거치게 하는 통로.
//
// 왜 필요한가:
//     프론트의 aiApiClient는 /ai-api로 법령·판례·상담사례 검색을 직접 불렀다. 로컬에서는
//     Vite 프록시가 8001로 넘겨줘서 잘 돌지만, 배포하면 저 경로를 nginx에도 뚫어야 한다.
//     그런데 ai-api에는 인증이 하나도 없다 — 열어 두는 순간 누구나 우리 RAG 색인 전체를
//     검색하고, LLM을 부르는 엔드포인트(/statutes/recommend 등)를 무제한으로 때릴 수 있다.
//     비용도 비용이지만, 상담 요약문을 그대로 본문에 실어 보내는 경로라 남이 부를 자리가 아니다.
//
//     그래서 ai-api는 VPC 안에서만 열고(보안그룹으로 core-api만 허용), 브라우저는 여기를
//     통해서만 닿게 한다. 이 컨트롤러는 SecurityConfig의 .anyRequest().authenticated()에
//     걸리므로 로그인한 사용자만 통과한다.
//
// 왜 전부 넘기지 않고 목록을 두는가:
//     경로를 그대로 이어 붙이는 프록시는 결국 ai-api 전체를 여는 것과 같다. ai-api에는
//     /consult/analyze처럼 core-api가 오케스트레이션해야 하는 무거운 경로와, 서식 초안
//     생성처럼 상담·권한 확인을 거쳐야 하는 경로가 함께 있다. 화면이 실제로 부르는 것만
//     적어 두고 나머지는 404로 막는다.
@RestController
@RequestMapping(AiApiProxyController.PREFIX)
public class AiApiProxyController {

    static final String PREFIX = "/api/ai";

    // 프론트 aiApiClient.js가 부르는 것과 정확히 같은 목록이어야 한다.
    // 여기 없는 경로는 아래에서 404가 된다.
    private static final Set<String> ALLOWED_GET = Set.of(
            "/health",
            "/forms/revisions"
    );

    private static final Set<String> ALLOWED_POST = Set.of(
            "/forms/revisions/acknowledge",
            "/statutes/search",
            "/statutes/recommend",
            "/statutes/full-text",
            "/precedents/search",
            "/precedents/recommend",
            "/precedents/full-text",
            "/consultations/search",
            "/consultations/recommend",
            "/consultations/full-text"
    );

    private final RestClient restClient;

    public AiApiProxyController(RestClient aiApiRestClient) {
        this.restClient = aiApiRestClient;
    }

    @GetMapping("/**")
    public ResponseEntity<String> proxyGet(HttpServletRequest request) {
        return forward(HttpMethod.GET, remainingPath(request), null);
    }

    // 본문은 JsonNode로 받아 그대로 넘긴다. ai-api의 요청 스키마가 계속 바뀌는 중이라
    // DTO로 받으면 필드가 하나 늘 때마다 core-api도 같이 고쳐야 한다. 프록시는 내용을
    // 알 필요가 없다.
    //
    // String으로 받으면 안 된다. 이 RestClient에는 JSON 컨버터가 달려 있어서(AiApiClientConfig)
    // String을 JSON '문자열 값'으로 한 번 더 감싸 보낸다 — ai-api가 본문을 통째로 따옴표에
    // 싸인 한 덩어리로 받아 422를 돌려준다.
    @PostMapping("/**")
    public ResponseEntity<String> proxyPost(HttpServletRequest request,
                                             @RequestBody(required = false) JsonNode body) {
        return forward(HttpMethod.POST, remainingPath(request), body);
    }

    private String remainingPath(HttpServletRequest request) {
        String full = (String) request.getAttribute(HandlerMapping.PATH_WITHIN_HANDLER_MAPPING_ATTRIBUTE);
        if (full == null) {
            full = request.getRequestURI();
        }
        return pathAfterPrefix(full);
    }

    // 테스트에서 직접 부를 수 있게 떼어 둔다. 여기가 틀리면 화이트리스트가 통째로 무의미해진다.
    static String pathAfterPrefix(String uri) {
        int at = uri.indexOf(PREFIX);
        if (at < 0) {
            return "";
        }
        String path = uri.substring(at + PREFIX.length());
        return path.isEmpty() ? "/" : path;
    }

    // 목록에 정확히 있는 것만 통과한다. 부분일치나 접두어 비교를 쓰지 않는 것이 핵심이다 —
    // startsWith로 검사하면 "/statutes/search" 를 허용한 것이 "/statutes/search/../../docs"
    // 같은 값까지 함께 열어 준다.
    static boolean isAllowed(HttpMethod method, String path) {
        if (HttpMethod.GET.equals(method)) {
            return ALLOWED_GET.contains(path);
        }
        if (HttpMethod.POST.equals(method)) {
            return ALLOWED_POST.contains(path);
        }
        return false;
    }

    private ResponseEntity<String> forward(HttpMethod method, String path, JsonNode body) {
        if (!isAllowed(method, path)) {
            // 없는 경로인지 막힌 경로인지 구분해 알려줄 이유가 없다. 목록에 없으면 없는 길이다.
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"message\":\"지원하지 않는 AI 경로입니다.\"}");
        }

        try {
            RestClient.RequestBodySpec spec = restClient.method(method).uri(path);
            if (body != null && !body.isNull()) {
                spec = spec.contentType(MediaType.APPLICATION_JSON).body(body);
            }
            // 상태코드와 본문을 있는 그대로 넘긴다. ai-api가 422로 알려주는 검증 오류를
            // core-api가 500으로 바꿔 버리면 화면이 원인을 표시할 수 없다.
            return spec.exchange((req, res) -> {
                String responseBody = new String(res.getBody().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                return ResponseEntity.status(res.getStatusCode())
                        .contentType(MediaType.APPLICATION_JSON)
                        .body(responseBody);
            });
        } catch (ResourceAccessException e) {
            // ai-api가 안 떠 있거나 응답이 없을 때. 프론트가 502를 '서버 연결 실패'로
            // 안내하도록 이미 되어 있다(aiApiClient.js requestJson 참고).
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body("{\"message\":\"AI API 서버에 연결할 수 없습니다.\"}");
        }
    }
}
