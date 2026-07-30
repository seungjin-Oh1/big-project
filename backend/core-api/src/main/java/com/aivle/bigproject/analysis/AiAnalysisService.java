package com.aivle.bigproject.analysis;

import com.aivle.bigproject.analysis.client.ConsultAiApiClient;
import com.aivle.bigproject.analysis.client.ConsultAnalyzeApiResponse;
import com.aivle.bigproject.analysis.client.RawInputRequest;
import com.aivle.bigproject.analysis.dto.AiAnalysisRequest;
import com.aivle.bigproject.analysis.dto.AiAnalysisResponse;
import com.aivle.bigproject.attachment.Attachment;
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
import java.time.LocalDateTime;
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
    private final ConsultAiApiClient aiApiClient; // ai-api POST /consult/analyze 호출용
    private final AuditLogService auditLogService; // SEC-01-01-01: AI 분석 실행/결과수정/검토승인·반려 기록용

    public AiAnalysisService(AiAnalysisRepository aiAnalysisRepository,
                              ConsultationService consultationService,
                              ObjectMapper objectMapper,
                              ConsultAiApiClient aiApiClient,
                              UserRepository userRepository,
                              AuditLogService auditLogService) {
        this.aiAnalysisRepository = aiAnalysisRepository;
        this.consultationService = consultationService;
        this.userRepository = userRepository;
        this.objectMapper = objectMapper;
        this.aiApiClient = aiApiClient;
        this.auditLogService = auditLogService;
    }

    // 상담 텍스트 + 첨부파일(S3 key)을 ai-api에 보내 실제 분석 파이프라인(/consult/analyze)을 돌리고,
    // 그 결과를 새 AiAnalysis row로 저장한다. "분석 시작" 버튼이 호출하는 진입점.
    @Transactional
    public AiAnalysisResponse analyze(Long consultationId) {
        Consultation consultation = consultationService.findById(consultationId);
        consultation.setStatus(ConsultationStatus.ANALYZING);

        RawInputRequest request = buildRawInput(consultation);
        ConsultAnalyzeApiResponse aiResponse = aiApiClient.analyzeConsult(request);

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

        // extracted_json은 계약서 정의대로 analysis 층의 당사자·금액·날짜를 담는다.
        // 여기까지 그래프의 case_analysis(긴급도 비율·분류근거)가 들어가 있었는데,
        // 서식 초안 생성이 이 필드를 [추출정보]로 받아 빈칸을 채우기 때문에
        // (ai/forms/drafter.py) 채울 재료가 하나도 없는 상태였다.
        //
        // 구조화 분석이 실패(503 등)하면 null이 되고, 그때는 초안 자동채움만 안 될 뿐
        // 판정 결과는 그대로 저장된다.
        String extractedJson = toJsonText(aiResponse.consultExtracted());

        AiAnalysis analysis = new AiAnalysis(consultation, summary, caseType, caseSubtype, urgencyLevel, eligible,
                extractedJson, aiResponse.missingItems().toString(), checklist.toString(),
                null, timelineJson, null, null, aiResponse.rawInput().toString());
        // 생성자 인자가 이미 14개라 순서 실수가 나기 쉬워서 setter로 넣는다.
        // 값이 없으면(예전 응답 형식) null로 남고, 화면은 등급만 쓰면 된다.
        analysis.setUrgencyScore(readDouble(caseAnalysis, "case_emergency_ratio"));
        // 화면 기본 표시용. 구조화 분석이 실패하면 둘 다 null로 남고, 그때 화면은
        // 전체 요약(summary)을 그대로 보여주면 된다 — 없는 값을 만들어 넣지 않는다.
        analysis.setSummaryHeadline(aiResponse.consultSummaryHeadline());
        analysis.setSummaryKeywordsJson(toJsonText(aiResponse.consultSummaryKeywords()));

        AiAnalysis saved = aiAnalysisRepository.save(analysis);
        consultation.setStatus(ConsultationStatus.COMPLETED);
        auditLogService.record(AuditAction.AI_ANALYSIS_EXECUTE, "AI_ANALYSIS", saved.getId(),
                "consultationId=" + consultationId);
        return toResponse(saved);
    }

    // Consultation -> ai-api RawInput 변환. title/inputText는 그대로, 첨부파일은 storageKey(S3 key) 목록으로.
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
                consultation.getInputText(),
                fileLinks,
                consultDay
        ));
    }

    // ai-api analysis 층이 만든 상담 요약을 우선 쓰고, 없으면 기존 조합 문자열로 폴백한다.
    // 폴백을 남겨두는 이유: 구조화 분석은 모델 과부하(503) 등으로 실패할 수 있는데,
    // 그때 요약이 통째로 비는 것보다 판정 결과라도 보이는 편이 낫기 때문.
    // 숫자가 아니거나 없으면 null. asDouble()은 없을 때 0.0을 돌려줘서,
    // "점수 없음"과 "긴급도 0점"이 구분되지 않는다.
    private Double readDouble(JsonNode node, String field) {
        JsonNode value = node.path(field);
        return value.isNumber() ? value.doubleValue() : null;
    }

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
                toJsonText(request.recommendationJson()),
                toJsonText(request.timelineJson()),
                toJsonText(request.clusterResultJson()),
                request.estimatedTime(),
                toJsonText(request.rawInputJson())
        );
        // 생성자 인자가 이미 14개라 더 늘리지 않고 setter로 넣는다 (analyze 경로와 같은 방식).
        analysis.setSummaryHeadline(request.summaryHeadline());
        analysis.setSummaryKeywordsJson(toJsonText(request.summaryKeywordsJson()));
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
        if (request.summaryHeadline() != null) {
            analysis.setSummaryHeadline(request.summaryHeadline());
        }
        if (request.summaryKeywordsJson() != null) {
            analysis.setSummaryKeywordsJson(toJsonText(request.summaryKeywordsJson()));
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

    // 엔티티 -> 응답 DTO. DTO 변환을 컨트롤러가 아니라 여기(서비스, 트랜잭션 안)에서 하는 이유는
    // Consultation 쪽과 동일 — consultation은 지연 로딩이라 트랜잭션 밖에서 접근하면 에러 남.
    private AiAnalysisResponse toResponse(AiAnalysis a) {
        User reviewer = a.getReviewer();
        return new AiAnalysisResponse(
                a.getId(),
                a.getConsultation().getId(),
                a.getSummary(),
                a.getSummaryHeadline(),
                parseJson(a.getSummaryKeywordsJson()),
                a.getCaseType(),
                a.getCaseSubtype(),
                a.getUrgencyLevel(),
                a.getUrgencyScore(),
                a.getEligibility(),
                parseJson(a.getExtractedJson()),
                parseJson(a.getMissingInfoJson()),
                parseJson(a.getChecklistJson()),
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
