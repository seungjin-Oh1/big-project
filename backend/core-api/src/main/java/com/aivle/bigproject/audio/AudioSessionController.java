package com.aivle.bigproject.audio;

import com.aivle.bigproject.audio.dto.AudioStreamTicketResponse;
import com.aivle.bigproject.audio.dto.CallResponse;
import com.aivle.bigproject.audio.dto.InPersonCallResponse;
import java.util.List;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AudioSessionController {

    private final CallRegistry callRegistry;
    private final AudioStreamTicketService ticketService;
    private final InPersonCallInitiator inPersonCallInitiator;

    public AudioSessionController(CallRegistry callRegistry,
                                   AudioStreamTicketService ticketService,
                                   InPersonCallInitiator inPersonCallInitiator) {
        this.callRegistry = callRegistry;
        this.ticketService = ticketService;
        this.inPersonCallInitiator = inPersonCallInitiator;
    }

    // GET /api/audio/calls — 현재 연결된 통화 목록(WAITING: 오퍼레이터 대기 중, CONNECTED: 통화 중)
    @GetMapping("/api/audio/calls")
    public List<CallResponse> listCalls() {
        return callRegistry.list();
    }

    // POST /api/audio/tickets — 오디오 WebSocket에 붙을 때 쓸 1회성 티켓 발급.
    //
    // 이 요청 자체는 평범한 REST라 Authorization 헤더로 인증된다. 티켓이 필요한 이유는
    // 그다음 단계인 WebSocket 핸드셰이크 때문이다 — 브라우저의 new WebSocket()에는 헤더를
    // 넣을 수 없어서, 인증 정보를 주소에 실을 수밖에 없다. 24시간짜리 JWT를 주소에 그대로
    // 붙이면 접속 로그와 브라우저 히스토리에 남으므로, 30초 1회용 티켓으로 바꿔서 넘긴다.
    @PostMapping("/api/audio/tickets")
    public AudioStreamTicketResponse issueTicket(Authentication authentication) {
        String email = authentication.getName();
        String role = authentication.getAuthorities().stream()
                .map(authority -> authority.getAuthority().replaceFirst("^ROLE_", ""))
                .findFirst()
                .orElse(null);
        var ticket = ticketService.issue(email, role);
        return new AudioStreamTicketResponse(ticket.ticket(), ticket.expiresAt());
    }

    // POST /api/audio/in-person-calls — 대면 상담 녹음을 시작할 때 호출한다.
    //
    // 전화 상담은 외부 SIP 게이트웨이가 먼저 통화를 걸어와 CallRegistry에 등록되고, 상담원은
    // 그중 하나를 골라 /ws/audio/operator로 붙는다. 대면 녹음은 상대가 없어서 그 "외부 레그"
    // 등록을 여기서 대신 한다(InPersonCallInitiator가 app.audio.in-person-gateway-ws-url로
    // 걸어 나가 등록) — 돌려준 callId로 티켓을 받아(POST /api/audio/tickets) /ws/audio/operator에
    // 붙으면 전화 상담과 같은 경로로 오디오가 그 외부 게이트웨이까지 중계된다.
    @PostMapping("/api/audio/in-person-calls")
    public InPersonCallResponse startInPersonCall() {
        return new InPersonCallResponse(inPersonCallInitiator.start());
    }
}
