package com.aivle.bigproject.document;

import com.aivle.bigproject.analysis.AiAnalysis;
import com.aivle.bigproject.analysis.AiAnalysisRepository;
import com.aivle.bigproject.audit.AuditAction;
import com.aivle.bigproject.audit.AuditLogService;
import com.aivle.bigproject.common.exception.ConflictException;
import com.aivle.bigproject.common.exception.NotFoundException;
import com.aivle.bigproject.consultation.Consultation;
import com.aivle.bigproject.consultation.ConsultationService;
import com.aivle.bigproject.document.dto.ApproveRequest;
import com.aivle.bigproject.document.dto.GenerateDraftRequest;
import com.aivle.bigproject.document.dto.GeneratedDocumentResponse;
import com.aivle.bigproject.document.dto.RecommendFormsResponse;
import com.aivle.bigproject.document.dto.RecommendedFormDto;
import com.aivle.bigproject.document.dto.RequestRevisionRequest;
import com.aivle.bigproject.user.User;
import com.aivle.bigproject.user.UserRepository;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Service
@Transactional(readOnly = true)
public class GeneratedDocumentService {

    private final GeneratedDocumentRepository generatedDocumentRepository;
    private final AiAnalysisRepository aiAnalysisRepository;
    private final ConsultationService consultationService;
    private final UserRepository userRepository;
    private final AiApiClient aiApiClient;
    private final ObjectMapper objectMapper;
    private final AuditLogService auditLogService; // SEC-01-01-01: 서식 초안 검토승인/반려 기록용

    public GeneratedDocumentService(GeneratedDocumentRepository generatedDocumentRepository,
                                     AiAnalysisRepository aiAnalysisRepository,
                                     ConsultationService consultationService,
                                     UserRepository userRepository,
                                     AiApiClient aiApiClient,
                                     ObjectMapper objectMapper,
                                     AuditLogService auditLogService) {
        this.generatedDocumentRepository = generatedDocumentRepository;
        this.aiAnalysisRepository = aiAnalysisRepository;
        this.consultationService = consultationService;
        this.userRepository = userRepository;
        this.aiApiClient = aiApiClient;
        this.objectMapper = objectMapper;
        this.auditLogService = auditLogService;
    }

    // 추천 목록은 DB에 저장하지 않는다 — ai-api를 그때그때 호출해서 응답만 그대로 돌려줌
    public RecommendFormsResponse recommendForms(Long consultationId, Long analysisId) {
        AiAnalysis analysis = findAnalysis(consultationId, analysisId);
        JsonNode result = aiApiClient.recommendForms(
                analysis.getCaseType(), analysis.getCaseSubtype(), analysis.getSummary(),
                parseJson(analysis.getExtractedJson()));

        List<RecommendedFormDto> recommendations = new ArrayList<>();
        for (JsonNode r : result.path("recommendations")) {
            recommendations.add(new RecommendedFormDto(
                    r.path("rank").isMissingNode() ? null : r.path("rank").intValue(),
                    r.path("form_name").isMissingNode() ? null : r.path("form_name").stringValue(),
                    r.path("reason").isMissingNode() ? null : r.path("reason").stringValue()
            ));
        }
        Integer candidatesCount = result.path("candidates_count").isMissingNode()
                ? null : result.path("candidates_count").intValue();
        String reasonIfEmpty = result.path("reason_if_empty").isMissingNode()
                ? null : result.path("reason_if_empty").stringValue();
        return new RecommendFormsResponse(recommendations, candidatesCount, reasonIfEmpty);
    }

    // 상담원이 고른 서식으로 실제 초안을 생성하고, 그 결과만 DB에 저장(HITL — 여기까지는
    // "검토 대기" 상태). 아직 변호사에게 제출된 게 아니라 DRAFTED로만 시작 —
    // submitForReview()를 호출해야 변호사 검토 큐에 들어간다.
    @Transactional
    public GeneratedDocumentResponse generateDraft(Long consultationId, Long analysisId, GenerateDraftRequest request) {
        AiAnalysis analysis = findAnalysis(consultationId, analysisId);
        Consultation consultation = consultationService.findById(consultationId);

        JsonNode result = callAiApiDraft(request.formName(), analysis);

        GeneratedDocument document = new GeneratedDocument(
                consultation,
                request.formName(),
                null,
                result.path("file").isMissingNode() ? null : result.path("file").stringValue(),
                result.toString(),
                DocumentReviewStatus.DRAFTED
        );
        return toResponse(generatedDocumentRepository.save(document));
    }

    // 상담원: 변호사에게 검토 요청. REVISION_REQUESTED 상태에서 다시 부르면(재제출)
    // 최신 상담 분석 내용으로 초안을 다시 생성해서 갈아끼우고 검토 이력(코멘트 등)을 비운다.
    @Transactional
    public GeneratedDocumentResponse submitForReview(Long consultationId, Long documentId) {
        GeneratedDocument document = findDocument(consultationId, documentId);
        if (document.getStatus() != DocumentReviewStatus.DRAFTED
                && document.getStatus() != DocumentReviewStatus.REVISION_REQUESTED) {
            throw new ConflictException("초안 생성 또는 반려 상태에서만 검토 요청할 수 있습니다. 현재 상태: " + document.getStatus());
        }

        boolean isResubmission = document.getStatus() == DocumentReviewStatus.REVISION_REQUESTED;
        if (isResubmission) {
            AiAnalysis analysis = findLatestAnalysis(consultationId);
            JsonNode result = callAiApiDraft(document.getFormName(), analysis);
            document.setDraftFilePath(result.path("file").isMissingNode() ? null : result.path("file").stringValue());
            document.setDraftResultJson(result.toString());
            document.setRevisionCount(document.getRevisionCount() + 1);
            document.setReviewer(null);
            document.setReviewNote(null);
            document.setRequestedMaterialsJson(null);
            document.setReviewedAt(null);
        }
        document.setStatus(DocumentReviewStatus.SUBMITTED_FOR_REVIEW);
        return toResponse(document);
    }

    // 변호사 전용(SecurityConfig에서 강제): 승인
    @Transactional
    public GeneratedDocumentResponse approve(Long consultationId, Long documentId, ApproveRequest request) {
        GeneratedDocument document = requireSubmitted(consultationId, documentId);
        document.setReviewer(currentUser());
        document.setReviewNote(request.note());
        document.setReviewedAt(LocalDateTime.now());
        document.setStatus(DocumentReviewStatus.APPROVED);
        auditLogService.record(AuditAction.REVIEW_APPROVE, "GENERATED_DOCUMENT", documentId, request.note());
        return toResponse(document);
    }

    // 변호사 전용(SecurityConfig에서 강제): 반려 + 추가자료 요청
    @Transactional
    public GeneratedDocumentResponse requestRevision(Long consultationId, Long documentId, RequestRevisionRequest request) {
        GeneratedDocument document = requireSubmitted(consultationId, documentId);
        document.setReviewer(currentUser());
        document.setReviewNote(request.note());
        document.setRequestedMaterialsJson(toJsonText(request.requestedMaterials()));
        document.setReviewedAt(LocalDateTime.now());
        document.setStatus(DocumentReviewStatus.REVISION_REQUESTED);
        auditLogService.record(AuditAction.REVIEW_REJECT, "GENERATED_DOCUMENT", documentId, request.note());
        return toResponse(document);
    }

    public List<GeneratedDocumentResponse> findAllByConsultation(Long consultationId) {
        consultationService.findById(consultationId);
        return generatedDocumentRepository.findByConsultationId(consultationId).stream()
                .map(this::toResponse)
                .toList();
    }

    private GeneratedDocument requireSubmitted(Long consultationId, Long documentId) {
        GeneratedDocument document = findDocument(consultationId, documentId);
        if (document.getStatus() != DocumentReviewStatus.SUBMITTED_FOR_REVIEW) {
            throw new ConflictException("검토 요청된 상태의 문서만 승인/반려할 수 있습니다. 현재 상태: " + document.getStatus());
        }
        return document;
    }

    // AiAnalysisService.findByIdForConsultation()과 같은 패턴: analysisId만 보고 찾지 않고
    // 그게 진짜 이 상담 소속인지까지 확인
    private AiAnalysis findAnalysis(Long consultationId, Long analysisId) {
        AiAnalysis analysis = aiAnalysisRepository.findById(analysisId)
                .orElseThrow(() -> new NotFoundException("분석 결과를 찾을 수 없습니다: " + analysisId));
        if (!analysis.getConsultation().getId().equals(consultationId)) {
            throw new NotFoundException("분석 결과를 찾을 수 없습니다: " + analysisId);
        }
        return analysis;
    }

    private GeneratedDocument findDocument(Long consultationId, Long documentId) {
        GeneratedDocument document = generatedDocumentRepository.findById(documentId)
                .orElseThrow(() -> new NotFoundException("생성된 서식을 찾을 수 없습니다: " + documentId));
        if (!document.getConsultation().getId().equals(consultationId)) {
            throw new NotFoundException("생성된 서식을 찾을 수 없습니다: " + documentId);
        }
        return document;
    }

    // 재제출 시점의 "최신" 분석 내용을 쓴다 — 상담원이 재제출 전에 기존
    // PUT /api/consultations/{id}/analyses/{analysisId}로 요약/추출정보를 보완해뒀을 것을 전제로 함.
    private AiAnalysis findLatestAnalysis(Long consultationId) {
        List<AiAnalysis> analyses = aiAnalysisRepository.findByConsultationId(consultationId);
        if (analyses.isEmpty()) {
            throw new NotFoundException("이 상담에 분석 결과가 없습니다: " + consultationId);
        }
        return analyses.get(analyses.size() - 1);
    }

    private JsonNode callAiApiDraft(String formName, AiAnalysis analysis) {
        JsonNode result = aiApiClient.generateDraft(formName, parseJson(analysis.getExtractedJson()), analysis.getSummary());
        JsonNode errorNode = result.path("error");
        if (!errorNode.isMissingNode() && !errorNode.isNull()) {
            throw new IllegalStateException("초안 생성 실패: " + errorNode.stringValue());
        }
        return result;
    }

    // JWT 필터(JwtAuthenticationFilter)가 SecurityContext에 넣어둔 email(subject)로
    // 실제 User 엔티티를 찾는다. approve/requestRevision은 인증된 요청에서만 호출되므로
    // (SecurityConfig에서 hasRole("LAWYER")로 이미 강제) 여기서 인증 자체를 재확인하진 않는다.
    private User currentUser() {
        String email = SecurityContextHolder.getContext().getAuthentication().getName();
        return userRepository.findByEmail(email)
                .orElseThrow(() -> new NotFoundException("로그인한 사용자를 찾을 수 없습니다: " + email));
    }

    private JsonNode parseJson(String raw) {
        if (raw == null) {
            return objectMapper.createObjectNode();
        }
        return objectMapper.readTree(raw);
    }

    private String toJsonText(List<String> values) {
        return values == null ? null : objectMapper.writeValueAsString(values);
    }

    private List<String> parseStringList(String raw) {
        if (raw == null) {
            return List.of();
        }
        JsonNode node = objectMapper.readTree(raw);
        List<String> values = new ArrayList<>();
        for (JsonNode item : node) {
            values.add(item.stringValue());
        }
        return values;
    }

    private GeneratedDocumentResponse toResponse(GeneratedDocument d) {
        User reviewer = d.getReviewer();
        return new GeneratedDocumentResponse(
                d.getId(),
                d.getConsultation().getId(),
                d.getFormName(),
                d.getRecommendationReason(),
                d.getDraftFilePath(),
                d.getStatus(),
                reviewer == null ? null : reviewer.getId(),
                reviewer == null ? null : reviewer.getName(),
                d.getReviewNote(),
                parseStringList(d.getRequestedMaterialsJson()),
                d.getReviewedAt(),
                d.getRevisionCount(),
                d.getCreatedAt()
        );
    }
}
