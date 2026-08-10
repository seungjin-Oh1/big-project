package com.aivle.bigproject.consultation;

import com.aivle.bigproject.analysis.AiAnalysis;
import com.aivle.bigproject.analysis.AiAnalysisRepository;
import com.aivle.bigproject.audio.client.InPersonSttMaskClient;
import com.aivle.bigproject.analysis.job.AnalysisJobRepository;
import com.aivle.bigproject.attachment.Attachment;
import com.aivle.bigproject.audit.AuditAction;
import com.aivle.bigproject.audit.AuditLogService;
import com.aivle.bigproject.common.exception.NotFoundException;
import com.aivle.bigproject.consultation.dto.ConsultationRequest;
import com.aivle.bigproject.consultation.dto.ConsultationResponse;
import com.aivle.bigproject.consultation.dto.TranscriptSaveRequest;
import com.aivle.bigproject.storage.S3FileStorageService;
import com.aivle.bigproject.document.GeneratedDocumentRepository;
import com.aivle.bigproject.user.User;
import com.aivle.bigproject.user.UserRepository;
import com.aivle.bigproject.user.UserRole;
import com.aivle.bigproject.user.UserService;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.springframework.security.core.Authentication;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class ConsultationService {

    private final ConsultationRepository consultationRepository;
    private final S3FileStorageService s3FileStorageService; // 삭제 시 첨부파일을 S3에서도 지우기 위해 필요
    private final UserService userService; // userId로 실제 User가 있는지 확인하기 위해 필요
    private final AiAnalysisRepository aiAnalysisRepository; // 삭제 시 딸린 분석 결과도 같이 지우기 위해 필요
    private final GeneratedDocumentRepository generatedDocumentRepository; // 삭제 시 딸린 생성 초안도 같이 지우기 위해 필요
    private final AnalysisJobRepository analysisJobRepository; // 삭제 시 딸린 분석 작업 기록도 같이 지우기 위해 필요
    private final AuditLogService auditLogService; // SEC-01-01-01: 상담 조회를 감사 로그에 남기기 위해 필요
    private final UserRepository userRepository; // 목록 조회 시 로그인한 사용자를 email로 찾기 위해 필요
    private final ObjectMapper objectMapper; // extracted_json(jsonb를 담은 String)에서 키를 지우는 데 필요
    private final InPersonSttMaskClient sttMaskClient; // 수기로 적은 메모도 개인정보를 가리기 위해 필요

    // 분석이 서식 작성용으로 뽑아 두는 키들. 계약서(contracts/README_ai_analysis_contract.md)의
    // extracted_json 안에 들어가며, 이름·금액·날짜와 달리 동의를 받아야 다룰 수 있는 항목이다.
    private static final List<String> DRAFT_CONTACT_KEYS = List.of("주소", "전화번호", "개인정보동의");

    public ConsultationService(ConsultationRepository consultationRepository,
                                S3FileStorageService s3FileStorageService,
                                UserService userService,
                                AiAnalysisRepository aiAnalysisRepository,
                                GeneratedDocumentRepository generatedDocumentRepository,
                                AnalysisJobRepository analysisJobRepository,
                                AuditLogService auditLogService,
                                UserRepository userRepository,
                                ObjectMapper objectMapper,
                                InPersonSttMaskClient sttMaskClient) {
        this.consultationRepository = consultationRepository;
        this.s3FileStorageService = s3FileStorageService;
        this.userService = userService;
        this.aiAnalysisRepository = aiAnalysisRepository;
        this.generatedDocumentRepository = generatedDocumentRepository;
        this.analysisJobRepository = analysisJobRepository;
        this.auditLogService = auditLogService;
        this.userRepository = userRepository;
        this.objectMapper = objectMapper;
        this.sttMaskClient = sttMaskClient;
    }

    @Transactional
    public ConsultationResponse create(ConsultationRequest request) {
        // userId가 실제로 존재하는 User인지 먼저 확인 (없으면 UserService가 404를 던짐)
        User user = userService.findById(request.userId());
        Consultation saved = consultationRepository.save(
                new Consultation(user, request.title(), request.clientName(), request.inputText(), request.opponentName(),
                        request.category(), request.type(), request.legalAidType(), request.eligibilityEvidenceSubmitted()));
        // 동의를 먼저 기록하고 그다음에 주소·전화번호를 넣는다. 순서가 바뀌면
        // applyDraftContactInfo가 아직 동의를 못 보고 값을 버린다.
        applyPrivacyFields(saved, request);
        // 프론트가 S3에 이미 올려둔 첨부파일들을 여기서 등록. fileKey가 없는(로컬 폴백) 항목은 건너뜀 —
        // 서버에 실체가 없는 파일을 DB에만 기록해봐야 다운로드/분석 둘 다 불가능하기 때문.
        // cascade=ALL이라 saved.getAttachments()에 추가만 하면 flush 시 같이 insert됨.
        if (request.attachments() != null) {
            String bucket = s3FileStorageService.getBucket();
            for (ConsultationRequest.AttachmentRegistration item : request.attachments()) {
                if (item.fileKey() == null || item.fileKey().isBlank()) {
                    continue;
                }
                saved.getAttachments().add(new Attachment(saved, item.fileName(), item.fileType(),
                        item.fileUrl(), bucket, item.fileKey(), item.contentType()));
            }
        }
        // cascade로 추가된 Attachment는 flush 전까진 id(IDENTITY)/uploadedAt(@CreatedDate)이 비어있음 —
        // DTO 변환 전에 명시적으로 flush해서 실제 INSERT를 실행시켜야 응답에 값이 채워짐.
        consultationRepository.flush();
        // 여기서 바로 DTO로 변환 — 트랜잭션이 열려있는 동안 처리해야
        // ConsultationResponse.from()이 attachments(LAZY)를 문제없이 읽을 수 있음
        return ConsultationResponse.from(saved);
    }

    // 상담원은 자기가 담당한 상담만 본다.
    //
    // 예전에는 누가 로그인했든 전체 목록을 그대로 돌려줘서, 상담원 계정마다 다른 상담을
    // 봐야 하는데 모두가 같은 목록을 보고 있었다. 남의 상담 내용(이름·연락처·사건 내용)까지
    // 다 보이던 상태다.
    //
    // 변호사·관리자는 전체를 본다 — 변호사는 자기가 담당하지 않은 상담을 검토해야 하고,
    // 관리자는 운영 현황을 봐야 한다.
    //
    // 이 엔드포인트는 SecurityConfig에서 이미 인증을 요구하므로(토큰 없이 호출하면 403)
    // 아래 orElseGet은 실제로는 변호사·관리자만 탄다. 인증이 없는 경우까지 열어둔 것은
    // 나중에 접근 정책이 바뀌어 익명 호출이 들어와도 NPE로 터지지 않게 하기 위한 기본값이다.
    public List<ConsultationResponse> findAll() {
        List<Consultation> consultations = currentUser()
                .filter(user -> user.getRole() == UserRole.CONSULTANT)
                .map(user -> consultationRepository.findByUserId(user.getId()))
                .orElseGet(consultationRepository::findAll);
        return consultations.stream()
                .map(ConsultationResponse::from)
                .toList();
    }

    // 로그인한 사용자. 인증이 없거나(익명 요청) 계정을 찾을 수 없으면 비어 있다.
    private Optional<User> currentUser() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated()) {
            return Optional.empty();
        }
        return userRepository.findByEmail(authentication.getName());
    }

    // 컨트롤러가 쓰는 조회용 — 엔티티 대신 바로 응답 DTO를 반환
    @Transactional
    public ConsultationResponse get(Long id) {
        Consultation consultation = findById(id);
        auditLogService.record(AuditAction.CONSULTATION_VIEW, "CONSULTATION", id, null);
        return ConsultationResponse.from(consultation);
    }

    // 이건 엔티티(Consultation) 자체를 반환하는 내부용 메서드.
    // AttachmentService가 "파일 업로드 대상 상담이 실제로 있는지" 확인하고
    // 그 엔티티를 FK로 연결할 때 사용함. 반드시 트랜잭션 안에서 호출해야 함.
    public Consultation findById(Long id) {
        return consultationRepository.findById(id)
                .orElseThrow(() -> new NotFoundException("상담을 찾을 수 없습니다: " + id));
    }

    // 부분 수정: request에서 null이 아닌 필드만 반영. 즉 status만 보내면 title/inputText는 그대로 유지됨.
    // userId(담당자 재배정)는 이 메서드에서 다루지 않음 — 아직 미구현 범위.
    @Transactional
    public ConsultationResponse update(Long id, ConsultationRequest request) {
        Consultation consultation = findById(id);
        if (request.title() != null) {
            consultation.setTitle(request.title());
        }
        if (request.clientName() != null) {
            consultation.setClientName(request.clientName());
        }
        if (request.inputText() != null) {
            consultation.setInputText(request.inputText());
        }
        if (request.opponentName() != null) {
            consultation.setOpponentName(request.opponentName());
        }
        if (request.status() != null) {
            consultation.setStatus(request.status());
        }
        if (request.category() != null) {
            consultation.setCategory(request.category());
        }
        if (request.type() != null) {
            consultation.setType(request.type());
        }
        if (request.legalAidType() != null) {
            consultation.setLegalAidType(request.legalAidType());
        }
        if (request.eligibilityEvidenceSubmitted() != null) {
            consultation.setEligibilityEvidenceSubmitted(request.eligibilityEvidenceSubmitted());
        }
        applyPrivacyFields(consultation, request);
        // consultation은 이미 영속 상태(DB와 연결된 상태)라 setter만 호출해도
        // 트랜잭션이 끝날 때 JPA가 알아서 UPDATE 쿼리를 날림 (별도 save() 호출 불필요)
        return ConsultationResponse.from(consultation);
    }

    /** 서식 작성용 개인정보(주소·전화번호)와 그 동의를 반영한다. 생성·수정이 같은 규칙을
     *  써야 해서 한 곳에 둔다 — 한쪽만 고치면 "등록할 땐 저장되는데 수정하면 지워지는"
     *  식으로 어긋난다.
     *
     *  동의를 먼저 반영하고 값을 넣는다. 동의가 내려가면(잘못 체크했다가 해제) 이미 저장된
     *  주소·전화번호도 함께 지워진다 — 동의를 철회했는데 값이 남아 있으면 그때부터는
     *  근거 없이 보관하는 것이 된다(개인정보 보호법 제37조 처리정지 요구권).
     *
     *  update는 부분 수정이라 필드가 없으면 건드리지 않는 것이 원칙인데, 동의만은 예외로
     *  둘 수 없다 — privacyConsent가 null로 올 때 "동의를 안 보냈다"와 "동의를 뺐다"를
     *  구분할 수 없기 때문이다. 그래서 화면이 이 셋을 항상 함께 보내도록 하고, 여기서는
     *  privacyConsent가 명시적으로 올 때만 동의 상태를 바꾼다. */
    private void applyPrivacyFields(Consultation consultation, ConsultationRequest request) {
        boolean revoked = false;
        if (request.privacyConsent() != null) {
            revoked = consultation.applyPrivacyConsent(request.privacyConsent(), request.privacyConsentSource());
        }
        if (request.clientAddress() != null || request.clientPhone() != null
                || request.privacyConsent() != null) {
            consultation.applyDraftContactInfo(request.clientAddress(), request.clientPhone());
        }
        if (revoked) {
            scrubDraftContactFromAnalyses(consultation);
        }
    }

    // 동의를 철회했을 때 분석이 extracted_json에 뽑아 둔 주소·전화번호를 지운다.
    //
    // 같은 값이 두 곳에 생긴다. consultation.client_address는 암호화되고 동의를 내리면
    // 지워지는데, extracted_json 쪽은 평문이고 아무도 안 지웠다 — 내담자가 동의를
    // 철회해도 주소가 그대로 남았다(개인정보 보호법 제37조 삭제 요구권).
    //
    // 동의가 살아 있는 동안은 지우지 않는다. 보관 근거가 있어 지울 이유가 없고,
    // extracted_json은 'AI가 무엇을 뽑았는지'의 기록이라 사후에 손대면 저장된 분석이
    // 실제 응답과 달라진다(AI 응답 검증이 이 값을 본다).
    //
    // 상담 원문(input_text, *_input_texts)은 건드리지 않는다. 거기 주소가 들어 있는 건
    // 내담자가 상담 중에 말했기 때문이지 우리가 서식용으로 수집해서가 아니다. 상담 기록
    // 자체라 보관 근거가 다르고, 지우면 상담이 어떻게 진행됐는지가 사라진다.
    // (그 컬럼의 평문 저장 문제는 Consultation.inputText의 TODO(규제)로 따로 남아 있다.)
    private void scrubDraftContactFromAnalyses(Consultation consultation) {
        if (consultation.getId() == null) {
            return;
        }
        for (AiAnalysis analysis : aiAnalysisRepository.findByConsultationId(consultation.getId())) {
            String json = analysis.getExtractedJson();
            if (json == null || json.isBlank()) {
                continue;
            }
            try {
                JsonNode node = objectMapper.readTree(json);
                if (!(node instanceof ObjectNode object)) {
                    continue;
                }
                boolean changed = false;
                for (String key : DRAFT_CONTACT_KEYS) {
                    changed |= object.remove(key) != null;
                }
                if (changed) {
                    analysis.setExtractedJson(objectMapper.writeValueAsString(object));
                }
            } catch (JacksonException e) {
                // 모양이 예상과 다르면 그냥 둔다. 분석 결과를 깨뜨리는 쪽이 더 나쁘다.
            }
        }
    }

    // "상담 저장" 버튼 전용: 실시간 상담(전화/대면) 채널별 현재 메모를 Consultation에 반영한다.
    // "분석 내용 저장"(AiAnalysisService.create/update)은 ai_analysis 테이블만 건드리고
    // Consultation은 전혀 건드리지 않는다 — 상담 원문 저장은 이 메서드가 전담한다(사용자 확인,
    // 2026-08-04: "분석 내용 저장에서는 db의 ai_analysis에만 데이터 저장을 원함").
    //
    // inputText(AI 분석 입력용 단일 값)는 두 채널을 합쳐서 갱신하고, call_input_texts/
    // inperson_input_texts(_masked)에는 채널별로 각자 스냅샷을 append한다.
    @Transactional
    public ConsultationResponse saveTranscript(Long id, TranscriptSaveRequest request) {
        Consultation consultation = findById(id);
        // 가림본은 저장하지 않는다. 원본이 그대로 남아 있는 한 가림본을 함께 두어도
        // 유출 대비가 되지 않고 보관하는 개인정보만 두 배가 된다. 가림이 필요한 곳은
        // 두 군데뿐이고 둘 다 '그때 가려서 쓰고 버리는' 방식으로 바꿨다 —
        // 검색 질의(AiAnalysisService.buildCombinedAnonymizedText)와
        // 화면 미리보기(GET .../masked-transcript).
        consultation.addCallInputText(request.callInputText());
        consultation.addInpersonInputText(request.inpersonInputText());

        List<String> parts = new ArrayList<>();
        if (request.callInputText() != null && !request.callInputText().isBlank()) {
            parts.add(request.callInputText());
        }
        if (request.inpersonInputText() != null && !request.inpersonInputText().isBlank()) {
            parts.add(request.inpersonInputText());
        }
        if (!parts.isEmpty()) {
            consultation.setInputText(String.join("\n\n", parts));
        }
        return ConsultationResponse.from(consultation);
    }

    // 화면의 '개인정보 가림 결과' 카드가 열릴 때만 부른다. 저장된 가림본을 읽는 게
    // 아니라 이 자리에서 가려서 돌려주고 버린다 — 그래야 DB에 원본 한 벌만 남는다.
    @Transactional(readOnly = true)
    public String maskedTranscript(Long id) {
        Consultation consultation = findById(id);
        List<String> parts = new ArrayList<>();
        addLatest(parts, consultation.getCallInputTexts());
        addLatest(parts, consultation.getInpersonInputTexts());
        if (parts.isEmpty()) {
            return "";
        }
        return sttMaskClient.redactText(String.join("\n\n", parts));
    }

    private void addLatest(List<String> parts, List<String> history) {
        if (history != null && !history.isEmpty()) {
            String latest = history.get(history.size() - 1);
            if (latest != null && !latest.isBlank()) {
                parts.add(latest);
            }
        }
    }

    @Transactional
    public void delete(Long id) {
        Consultation consultation = findById(id);
        // 첨부파일 DB row는 cascade 설정으로 자동 삭제되지만, S3에 저장된 실제 파일은
        // JPA가 모르는 영역이라 여기서 직접 하나씩 지워줘야 함
        for (Attachment attachment : consultation.getAttachments()) {
            if (attachment.getStorageKey() != null) {
                s3FileStorageService.delete(attachment.getStorageKey());
            }
        }
        // AiAnalysis/GeneratedDocument는 둘 다 Consultation이 컬렉션으로 들고 있지 않아서
        // (단방향 FK) cascade가 안 걸림 — 여기서 먼저 지워줘야 consultation 삭제 시
        // FK 제약조건 위반이 안 남
        aiAnalysisRepository.deleteByConsultationId(id);
        generatedDocumentRepository.deleteByConsultationId(id);
        analysisJobRepository.deleteByConsultationId(id);
        consultationRepository.delete(consultation);
    }
}
