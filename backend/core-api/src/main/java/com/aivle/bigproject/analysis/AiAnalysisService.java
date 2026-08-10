package com.aivle.bigproject.analysis;

import com.aivle.bigproject.analysis.client.ConsultAiApiClient;
import com.aivle.bigproject.analysis.client.ConsultAnalyzeApiResponse;
import com.aivle.bigproject.analysis.client.RawInputRequest;
import com.aivle.bigproject.analysis.dto.AiAnalysisRequest;
import com.aivle.bigproject.analysis.dto.AiAnalysisResponse;
import com.aivle.bigproject.attachment.Attachment;
import com.aivle.bigproject.audio.client.InPersonSttMaskClient;
import com.aivle.bigproject.audit.AuditAction;
import com.aivle.bigproject.audit.AuditLogService;
import com.aivle.bigproject.consultation.ConsultationStatus;
import java.time.format.DateTimeFormatter;
import com.aivle.bigproject.analysis.dto.AnalysisReviewRequest;
import com.aivle.bigproject.common.exception.ConflictException;
import com.aivle.bigproject.common.exception.NotFoundException;
import com.aivle.bigproject.consultation.Consultation;
import com.aivle.bigproject.consultation.ConsultationService;
import com.aivle.bigproject.user.User;
import com.aivle.bigproject.user.UserRepository;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class AiAnalysisService {

    private final AiAnalysisRepository aiAnalysisRepository;
    private final ConsultationService consultationService; // 대상 상담이 실제 있는지 확인용
    private final UserRepository userRepository;
    private final ObjectMapper objectMapper; // jsonb 컬럼(String)과 JsonNode를 서로 변환하는 데 사용
    private final InPersonSttMaskClient sttMaskClient; // 검색 질의용 익명화에 필요
    private final ConsultAiApiClient aiApiClient; // ai-api POST /consult/analyze 호출용
    private final AuditLogService auditLogService; // SEC-01-01-01: AI 분석 실행/결과수정/검토승인·반려 기록용

    public AiAnalysisService(AiAnalysisRepository aiAnalysisRepository,
                              ConsultationService consultationService,
                              ObjectMapper objectMapper,
                              ConsultAiApiClient aiApiClient,
                              UserRepository userRepository,
                              AuditLogService auditLogService,
                              InPersonSttMaskClient sttMaskClient) {
        this.aiAnalysisRepository = aiAnalysisRepository;
        this.consultationService = consultationService;
        this.userRepository = userRepository;
        this.objectMapper = objectMapper;
        this.aiApiClient = aiApiClient;
        this.auditLogService = auditLogService;
        this.sttMaskClient = sttMaskClient;
    }

    // 상담 텍스트 + 첨부파일(S3 key)을 ai-api에 보내 실제 분석 파이프라인(/consult/analyze)을 돌리고
    // 그 결과를 돌려준다. "분석 시작" 버튼이 호출하는 진입점.
    //
    // 여기서는 AiAnalysis row를 만들지 않는다. 예전엔 analyze()가 결과를 바로 저장해서, 상담원이
    // 화면만 보고 "분석 내용 저장"을 누르기 전인데도(심지어 재분석·구조대상 판정·누락자료 점검을
    // 누를 때마다) ai_analysis 테이블에 행이 쌓였다. 실제 저장은 상담원이 결과를 확인하고
    // "분석 내용 저장"을 눌렀을 때(create()/update()) 한 번만 일어나야 한다.
    // 지금은 비동기 방식(POST .../analyze-jobs)이 기본이고, 이 동기 엔드포인트는 전환 기간 동안만
    // 남겨 둔다. 프론트가 전부 옮겨간 뒤 컨트롤러와 함께 지운다.
    //
    // 아래 세 단계로 나눠 둔 이유는 비동기 쪽 때문이다. 가운데 ai-api 호출이 몇 분 걸리는데
    // 그동안 트랜잭션을 열어 두면 DB 커넥션 하나가 계속 묶인다. AnalysisJobRunner는 이 세 개를
    // 따로 부르기 때문에 앞뒤만 짧은 트랜잭션이고 가운데는 트랜잭션 밖이다.
    // 반면 여기(동기 경로)서는 셋이 한 트랜잭션 안에서 이어져 돌아 예전과 동작이 같다.
    @Transactional
    public AiAnalysisResponse analyze(Long consultationId) {
        RawInputRequest request = prepareRawInput(consultationId);
        ConsultAnalyzeApiResponse aiResponse = aiApiClient.analyzeConsult(request);
        return buildAnalysisResponse(consultationId, aiResponse);
    }

    // [1단계] 상담을 "분석 중"으로 바꾸고 ai-api에 보낼 입력을 만든다.
    @Transactional
    public RawInputRequest prepareRawInput(Long consultationId) {
        Consultation consultation = consultationService.findById(consultationId);
        consultation.setStatus(ConsultationStatus.ANALYZING);
        return buildRawInput(consultation);
    }

    // [3단계] ai-api 응답을 계약서 모양(AiAnalysisResponse)으로 옮기고 상담을 "완료"로 바꾼다.
    // (2단계는 aiApiClient.analyzeConsult() 호출 자체 — DB를 건드리지 않는다.)
    @Transactional
    public AiAnalysisResponse buildAnalysisResponse(Long consultationId, ConsultAnalyzeApiResponse aiResponse) {
        Consultation consultation = consultationService.findById(consultationId);

        JsonNode caseAnalysis = aiResponse.caseAnalysis();
        JsonNode checklist = aiResponse.reliefReviewChecklist();
        String graphCaseType = caseAnalysis.path("case_list").path(0).path("case_type").asText(null);
        String caseTypeReason = caseAnalysis.path("case_list").path(0).path("case_type_reason").asText(null);
        String urgencyLevel = caseAnalysis.path("case_emergency_level").asText(null);
        String eligible = checklist.path("eligibility").path("eligible").asText(null);

        // 계약서 필드는 ai-api analysis 층 결과를 우선 쓴다. 그 층이 AI_ANALYSIS를 채우려고
        // 만들어진 모델이라, 여기서 조합해 만들던 값보다 정확하다.
        // 사건유형도 analysis 층 값을 우선한다. 대상 사건 범위가 "서식이 실제로 있는
        // 대분류"(친족/상속/가사소송/가족관계등록)로 확정됐고, 그 목록이 analysis 층의
        // 분류체계와 같기 때문. 그래프의 8개 유형(임금체불·개인회생 등)은 해당 서식이
        // 없어서 초안 생성까지 이어지지 못한다.
        // 폴백을 두는 이유는 summary와 같다 — 구조화 분석이 실패(503 등)하면 사건유형이
        // 통째로 비는 것보다 그래프 값이라도 남는 편이 낫다.
        String caseType = firstNonBlank(aiResponse.consultCaseType(), graphCaseType);
        String summary = resolveSummary(aiResponse.consultSummary(),
                caseType, caseTypeReason, urgencyLevel, eligible);
        String caseSubtype = aiResponse.consultCaseSubtype();
        String timelineJson = toJsonText(aiResponse.consultTimeline());

        // extracted_json은 그래프 결과 위에 analysis 층 결과(당사자·금액·날짜·사건개요)를
        // 얹어서 담는다(buildExtractedJson). 교체가 아니라 병합이라 프론트가 읽던 키는
        // 그대로 남는다.
        // checklist_status_json은 분석 직후엔 채우지 않는다. 프론트가 checklist_json(4개 평가블록
        // 객체)에서 5개 체크박스 상태를 파생시켜 보여주고(mapCoreChecklist), 상담원이 "분석 내용
        // 저장"을 누를 때 그 시점의 체크 상태를 이 컬럼에 담아 보낸다.
        //
        // 반드시 new로 만든 객체여야 한다. 여기서 repository로 기존 행을 꺼내 오면, save()를
        // 부르지 않아도 트랜잭션이 끝날 때 변경분이 DB에 반영된다(JPA 변경감지). 그러면 위에
        // 적어둔 "analyze()는 DB를 건드리지 않는다"가 깨진다 — 상담원이 저장해 둔 분석을
        // 화면에서 고친 뒤 '구조대상 판정'이나 '누락자료 점검'을 누르면, 저장 버튼을 누르지도
        // 않았는데 그 행이 AI 값으로 되돌아간다.
        AiAnalysis analysis = new AiAnalysis(consultation, summary, caseType, caseSubtype, urgencyLevel, eligible,
                buildExtractedJson(caseAnalysis, aiResponse.consultExtracted(), aiResponse.outputValidation()),
                aiResponse.missingItems().toString(), checklist.toString(),
                null, null, timelineJson, null, null, aiResponse.rawInput().toString());

        consultation.setStatus(ConsultationStatus.COMPLETED);
        auditLogService.record(AuditAction.AI_ANALYSIS_EXECUTE, "AI_ANALYSIS", null,
                "consultationId=" + consultationId);
        return toResponse(analysis);
    }

    // Consultation -> ai-api RawInput 변환. 첨부파일은 storageKey(S3 key) 목록으로.
    // inputText는 "지금 라이브 메모"가 아니라 call_input_texts/inperson_input_texts 이력 전체를
    // 종합한 값을 쓴다 — "재분석 실행"이 직전 저장(inputText)만 보면 재녹음으로 지워진 이전
    // 세션 내용이 분석에서 빠지는 문제가 있어서(사용자 확인 후 결정, 2026-08-04). 재녹음을
    // 반복할수록 입력이 계속 커지는 트레이드오프는 감수하기로 함.
    private RawInputRequest buildRawInput(Consultation consultation) {
        List<String> fileLinks = consultation.getAttachments().stream()
                .map(Attachment::getStorageKey)
                .filter(key -> key != null && !key.isBlank())
                .toList();
        String consultDay = consultation.getCreatedAt() != null
                ? consultation.getCreatedAt().toLocalDate().format(DateTimeFormatter.ISO_LOCAL_DATE)
                : null;
        return new RawInputRequest(new RawInputRequest.RawInputContent(
                consultation.getTitle(),
                buildCombinedInputText(consultation),
                fileLinks,
                consultDay,
                buildCombinedAnonymizedText(consultation)
        ));
    }

    private String buildCombinedInputText(Consultation consultation) {
        String callText = String.join("\n\n", nullSafe(consultation.getCallInputTexts()));
        String inpersonText = String.join("\n\n", nullSafe(consultation.getInpersonInputTexts()));

        List<String> sections = new ArrayList<>();
        if (!callText.isBlank()) {
            sections.add("[전화상담]\n" + callText);
        }
        if (!inpersonText.isBlank()) {
            sections.add("[대면상담]\n" + inpersonText);
        }
        if (!sections.isEmpty()) {
            return String.join("\n\n", sections);
        }
        // 아직 "분석 내용 저장"을 한 번도 하지 않은 최초 "분석 시작"이면 채널별 이력 배열이
        // 비어 있다 — 이때는 현재 inputText(수기 입력 등)를 그대로 폴백으로 보낸다.
        return consultation.getInputText();
    }

    // 분석에 넘길 익명화 텍스트를 이 자리에서 만든다. 저장하지 않는다.
    //
    // 예전에는 저장할 때 가려서 call/inperson_input_texts_masked에 함께 넣어 두고
    // 여기서 그걸 읽었다. 그러면 같은 개인정보가 원본과 가림본 두 벌로 남는다 —
    // 원본이 그대로 있으니 유출 대비가 되지 않으면서 보관량만 늘었다.
    //
    // 가림은 '필요한 순간'에만 한다. 검색 질의로 쓸 때 그때 가려서 넘기고 버린다.
    // 그래야 RAG 설계 문서가 정한 경계(검색 질의는 anonymized_text만, 마스킹이
    // 없을 때 원문으로 폴백하지 않음)를 지키면서도 가림본을 저장하지 않을 수 있다.
    //
    // 가림에 실패하면 null을 돌려준다. ai-api는 익명화 텍스트가 없으면 검색을
    // 건너뛰므로(빈 배열), 원문이 검색으로 새는 일은 없다.
    private String buildCombinedAnonymizedText(Consultation consultation) {
        String raw = buildCombinedInputText(consultation);
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String masked = sttMaskClient.redactText(raw);
        return masked.isBlank() ? null : masked;
    }

    private static List<String> nullSafe(List<String> list) {
        return list == null ? List.of() : list;
    }

    // ai-api analysis 층이 만든 상담 요약을 우선 쓰고, 없으면 기존 조합 문자열로 폴백한다.
    // 폴백을 남겨두는 이유: 구조화 분석은 모델 과부하(503) 등으로 실패할 수 있는데,
    // 그때 요약이 통째로 비는 것보다 판정 결과라도 보이는 편이 낫기 때문.
    // 앞의 값이 비어 있으면 뒤의 값으로 넘어간다. analysis 층 결과를 우선하고
    // 그 층이 실패했을 때 그래프 값으로 폴백하는 데 쓴다.
    private String firstNonBlank(String preferred, String fallback) {
        return (preferred != null && !preferred.isBlank()) ? preferred : fallback;
    }

    private String resolveSummary(String consultSummary, String caseType, String caseTypeReason,
                                   String urgencyLevel, String eligible) {
        if (consultSummary != null && !consultSummary.isBlank()) {
            return consultSummary;
        }
        return buildSummary(caseType, caseTypeReason, urgencyLevel, eligible);
    }

    // consult_summary를 못 받았을 때 쓰는 폴백. 상담 내용 요약이 아니라
    // 핵심 판단 결과(사건유형/사유/긴급도/구조대상여부)를 엮은 한 줄이다.
    private String buildSummary(String caseType, String caseTypeReason, String urgencyLevel, String eligible) {
        StringBuilder sb = new StringBuilder();
        if (caseType != null) {
            sb.append("사건 유형: ").append(caseType);
            if (caseTypeReason != null) {
                sb.append(" (").append(caseTypeReason).append(")");
            }
        }
        if (urgencyLevel != null) {
            sb.append(sb.isEmpty() ? "" : " / ").append("긴급도: ").append(urgencyLevel);
        }
        if (eligible != null) {
            sb.append(sb.isEmpty() ? "" : " / ").append("법률구조 대상: ").append(eligible);
        }
        return sb.toString();
    }

    @Transactional
    public AiAnalysisResponse create(Long consultationId, AiAnalysisRequest request) {
        Consultation consultation = consultationService.findById(consultationId);
        AiAnalysis analysis = new AiAnalysis(
                consultation,
                request.summary(),
                request.caseType(),
                request.caseSubtype(),
                request.urgencyLevel(),
                request.eligibility(),
                toJsonText(request.extractedJson()),
                toJsonText(request.missingInfoJson()),
                toJsonText(request.checklistJson()),
                toJsonText(request.checklistStatusJson()),
                toJsonText(request.recommendationJson()),
                toJsonText(request.timelineJson()),
                toJsonText(request.clusterResultJson()),
                request.estimatedTime(),
                toJsonText(request.rawInputJson())
        );
        return toResponse(aiAnalysisRepository.save(analysis));
    }

    public List<AiAnalysisResponse> findAllByConsultation(Long consultationId) {
        consultationService.findById(consultationId); // 없는 상담이면 여기서 404
        return aiAnalysisRepository.findByConsultationId(consultationId).stream()
                .map(this::toResponse)
                .toList();
    }

    public AiAnalysisResponse get(Long consultationId, Long analysisId) {
        return toResponse(findByIdForConsultation(consultationId, analysisId));
    }

    // attachment 쪽과 같은 이유: analysisId만 보고 찾지 않고, 그게 진짜 이 상담 소속인지까지 확인
    private AiAnalysis findByIdForConsultation(Long consultationId, Long analysisId) {
        AiAnalysis analysis = aiAnalysisRepository.findById(analysisId)
                .orElseThrow(() -> new NotFoundException("분석 결과를 찾을 수 없습니다: " + analysisId));
        if (!analysis.getConsultation().getId().equals(consultationId)) {
            throw new NotFoundException("분석 결과를 찾을 수 없습니다: " + analysisId);
        }
        return analysis;
    }

    // Consultation.update()와 같은 방식: request에서 null이 아닌 필드만 반영 (부분 수정)
    @Transactional
    public AiAnalysisResponse update(Long consultationId, Long analysisId, AiAnalysisRequest request) {
        AiAnalysis analysis = findByIdForConsultation(consultationId, analysisId);
        if (request.summary() != null) {
            analysis.setSummary(request.summary());
        }
        if (request.caseType() != null) {
            analysis.setCaseType(request.caseType());
        }
        if (request.caseSubtype() != null) {
            analysis.setCaseSubtype(request.caseSubtype());
        }
        if (request.urgencyLevel() != null) {
            analysis.setUrgencyLevel(request.urgencyLevel());
        }
        if (request.eligibility() != null) {
            analysis.setEligibility(request.eligibility());
        }
        if (request.extractedJson() != null) {
            analysis.setExtractedJson(toJsonText(request.extractedJson()));
        }
        if (request.missingInfoJson() != null) {
            analysis.setMissingInfoJson(toJsonText(request.missingInfoJson()));
        }
        if (request.checklistJson() != null) {
            analysis.setChecklistJson(toJsonText(request.checklistJson()));
        }
        if (request.checklistStatusJson() != null) {
            analysis.setChecklistStatusJson(toJsonText(request.checklistStatusJson()));
        }
        if (request.recommendationJson() != null) {
            analysis.setRecommendationJson(toJsonText(request.recommendationJson()));
        }
        if (request.timelineJson() != null) {
            analysis.setTimelineJson(toJsonText(request.timelineJson()));
        }
        if (request.clusterResultJson() != null) {
            analysis.setClusterResultJson(toJsonText(request.clusterResultJson()));
        }
        if (request.estimatedTime() != null) {
            analysis.setEstimatedTime(request.estimatedTime());
        }
        if (request.rawInputJson() != null) {
            analysis.setRawInputJson(toJsonText(request.rawInputJson()));
        }
        auditLogService.record(AuditAction.AI_ANALYSIS_MODIFY, "AI_ANALYSIS", analysisId,
                "consultationId=" + consultationId);
        return toResponse(analysis);
    }

    @Transactional
    public void delete(Long consultationId, Long analysisId) {
        AiAnalysis analysis = findByIdForConsultation(consultationId, analysisId);
        aiAnalysisRepository.delete(analysis);
    }

    // 상담원: 수정 끝났으니 검토 요청. 문서 초안과 달리 재제출 시 AI를 다시 부르지 않는다 —
    // 상담원이 직접 고친 값(update()로 이미 반영됨)을 그대로 다시 검토 큐에 올릴 뿐.
    @Transactional
    public AiAnalysisResponse submitForReview(Long consultationId, Long analysisId) {
        AiAnalysis analysis = findByIdForConsultation(consultationId, analysisId);
        if (analysis.getStatus() != AnalysisReviewStatus.DRAFTED
                && analysis.getStatus() != AnalysisReviewStatus.REVISION_REQUESTED) {
            throw new ConflictException("작성 또는 반려 상태에서만 검토 요청할 수 있습니다. 현재 상태: " + analysis.getStatus());
        }
        analysis.setReviewer(null);
        analysis.setReviewNote(null);
        analysis.setReviewedAt(null);
        analysis.setStatus(AnalysisReviewStatus.SUBMITTED_FOR_REVIEW);
        return toResponse(analysis);
    }

    // 변호사 전용(SecurityConfig에서 강제): 승인
    @Transactional
    public AiAnalysisResponse approve(Long consultationId, Long analysisId, AnalysisReviewRequest request) {
        AiAnalysis analysis = requireSubmitted(consultationId, analysisId);
        analysis.setReviewer(currentUser());
        analysis.setReviewNote(request.note());
        analysis.setReviewedAt(LocalDateTime.now());
        analysis.setStatus(AnalysisReviewStatus.APPROVED);
        auditLogService.record(AuditAction.REVIEW_APPROVE, "AI_ANALYSIS", analysisId, request.note());
        return toResponse(analysis);
    }

    // 변호사 전용(SecurityConfig에서 강제): 반려
    @Transactional
    public AiAnalysisResponse requestRevision(Long consultationId, Long analysisId, AnalysisReviewRequest request) {
        AiAnalysis analysis = requireSubmitted(consultationId, analysisId);
        analysis.setReviewer(currentUser());
        analysis.setReviewNote(request.note());
        analysis.setReviewedAt(LocalDateTime.now());
        analysis.setStatus(AnalysisReviewStatus.REVISION_REQUESTED);
        auditLogService.record(AuditAction.REVIEW_REJECT, "AI_ANALYSIS", analysisId, request.note());
        return toResponse(analysis);
    }

    private AiAnalysis requireSubmitted(Long consultationId, Long analysisId) {
        AiAnalysis analysis = findByIdForConsultation(consultationId, analysisId);
        if (analysis.getStatus() != AnalysisReviewStatus.SUBMITTED_FOR_REVIEW) {
            throw new ConflictException("검토 요청된 상태의 분석만 승인/반려할 수 있습니다. 현재 상태: " + analysis.getStatus());
        }
        return analysis;
    }

    // GeneratedDocumentService.currentUser()와 같은 패턴: JwtAuthenticationFilter가 넣어둔
    // email(subject)로 실제 User를 찾음. approve/requestRevision은 SecurityConfig에서 이미
    // hasRole("LAWYER")로 막혀있어 여기서 인증 자체를 재확인하진 않는다.
    private User currentUser() {
        String email = SecurityContextHolder.getContext().getAuthentication().getName();
        return userRepository.findByEmail(email)
                .orElseThrow(() -> new NotFoundException("로그인한 사용자를 찾을 수 없습니다: " + email));
    }

    // 요청으로 받은 JsonNode -> DB(jsonb 컬럼)에 넣을 원본 JSON 텍스트
    private String toJsonText(JsonNode node) {
        return node == null ? null : node.toString();
    }

    // extracted_json에 담을 값을 만든다. 그래프 결과(case_analysis) 위에 analysis 층의
    // 구조화 결과(consult_extracted: 당사자·금액·날짜·사건개요)를 얹는다.
    //
    // 교체가 아니라 병합인 이유: 프론트가 이 필드에서 case_emergency_ratio와
    // case_list[0].case_type_reason을 읽고 있어(coreApiClientV2.js) 갈아끼우면 화면이 깨진다.
    // 두 층의 키가 겹치지 않으므로 함께 담아도 서로 방해하지 않는다.
    //
    // 이걸 안 담으면 서식 초안이 당사자를 못 받는다. 그러면 extracted_json에 남는 건
    // 사건분류와 STT 원문뿐이라, 초안 생성 LLM이 오타 섞인 대화록에서 이름을 눈치로
    // 뽑아 쓰게 된다 — 실제로 유언에 반대하는 형이 유언자 자리에 들어간 적이 있다.
    // analysis 층은 그 형을 '상대방(형)', 피상속인은 '미상'으로 정확히 구분해 준다.
    private String buildExtractedJson(
            JsonNode caseAnalysis,
            JsonNode consultExtracted,
            JsonNode outputValidation) {
        boolean hasStructured = consultExtracted != null && consultExtracted.isObject();
        if (!hasStructured) {
            // 구조화 분석이 실패(503 등)하면 그래프 결과만이라도 남긴다.
            ObjectNode fallback = objectMapper.createObjectNode();
            if (caseAnalysis != null && caseAnalysis.isObject()) {
                fallback.setAll((ObjectNode) caseAnalysis);
            }
            if (outputValidation != null && !outputValidation.isNull()) {
                fallback.set("output_validation", outputValidation);
            }
            return fallback.toString();
        }
        ObjectNode merged = objectMapper.createObjectNode();
        if (caseAnalysis != null && caseAnalysis.isObject()) {
            merged.setAll((ObjectNode) caseAnalysis);
        }
        merged.setAll((ObjectNode) consultExtracted);
        if (outputValidation != null && !outputValidation.isNull()) {
            merged.set("output_validation", outputValidation);
        }
        return merged.toString();
    }

    // 엔티티 -> 응답 DTO. DTO 변환을 컨트롤러가 아니라 여기(서비스, 트랜잭션 안)에서 하는 이유는
    // Consultation 쪽과 동일 — consultation은 지연 로딩이라 트랜잭션 밖에서 접근하면 에러 남.
    private AiAnalysisResponse toResponse(AiAnalysis a) {
        User reviewer = a.getReviewer();
        return new AiAnalysisResponse(
                a.getId(),
                a.getConsultation().getId(),
                a.getSummary(),
                a.getCaseType(),
                a.getCaseSubtype(),
                a.getUrgencyLevel(),
                a.getEligibility(),
                parseJson(a.getExtractedJson()),
                parseJson(a.getMissingInfoJson()),
                parseJson(a.getChecklistJson()),
                parseJson(a.getChecklistStatusJson()),
                parseJson(a.getRecommendationJson()),
                parseJson(a.getTimelineJson()),
                parseJson(a.getClusterResultJson()),
                a.getEstimatedTime(),
                parseJson(a.getRawInputJson()),
                a.getCreatedAt(),
                a.getStatus(),
                reviewer == null ? null : reviewer.getId(),
                reviewer == null ? null : reviewer.getName(),
                a.getReviewNote(),
                a.getReviewedAt()
        );
    }

    // DB에 저장된 원본 JSON 텍스트 -> 응답에 실릴 JsonNode로 파싱
    private JsonNode parseJson(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            return objectMapper.readTree(raw);
        } catch (JacksonException e) {
            // jsonb 컬럼엔 항상 유효한 JSON만 들어있어야 하므로, 여기 걸리면 데이터 자체의 문제
            // (참고: Jackson 3부터는 JsonProcessingException 같은 checked 예외가 없어지고
            //  JacksonException이 unchecked로 통일됨)
            throw new IllegalStateException("저장된 JSON 데이터를 읽는 중 오류가 발생했습니다", e);
        }
    }
}
