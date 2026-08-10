package com.aivle.bigproject.analysis.job;

import com.aivle.bigproject.analysis.dto.AiAnalysisResponse;
import com.aivle.bigproject.analysis.job.dto.AnalysisJobResponse;
import com.aivle.bigproject.common.exception.NotFoundException;
import com.aivle.bigproject.consultation.Consultation;
import com.aivle.bigproject.consultation.ConsultationService;
import java.time.LocalDateTime;
import java.util.EnumSet;
import java.util.Optional;
import java.util.Set;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Service
@Transactional(readOnly = true)
public class AnalysisJobService {

    // 아직 끝나지 않은 상태들. "이 상담에 이미 돌고 있는 분석이 있나"를 판단하는 기준.
    private static final Set<AnalysisJobStatus> ACTIVE =
            EnumSet.of(AnalysisJobStatus.PENDING, AnalysisJobStatus.RUNNING);

    // 실패 사유를 통째로 담으면 스택트레이스가 섞인 긴 문자열이 들어올 수 있어 잘라 둔다.
    // 화면에 그대로 보여줄 값이라 길어봐야 읽지 못한다.
    private static final int MAX_ERROR_LENGTH = 1000;

    private final AnalysisJobRepository analysisJobRepository;
    private final ConsultationService consultationService; // 대상 상담이 실제 있는지 확인용
    private final ObjectMapper objectMapper; // 결과 DTO <-> result_json 텍스트 변환
    private final ApplicationEventPublisher eventPublisher;

    public AnalysisJobService(AnalysisJobRepository analysisJobRepository,
                              ConsultationService consultationService,
                              ObjectMapper objectMapper,
                              ApplicationEventPublisher eventPublisher) {
        this.analysisJobRepository = analysisJobRepository;
        this.consultationService = consultationService;
        this.objectMapper = objectMapper;
        this.eventPublisher = eventPublisher;
    }

    // "분석 시작"이 부르는 지점. 작업만 만들어 두고 바로 돌려준다 — 실제 실행은
    // AnalysisJobRunner가 커밋 이후에 백그라운드로 가져간다.
    //
    // 이미 돌고 있는 작업이 있으면 새로 만들지 않고 그것을 돌려준다. 버튼 disabled만으로는
    // 막을 수 없는 경우가 있어서다 — 화면을 새로고침하면 버튼이 다시 눌리고, 그때마다 작업이
    // 쌓이면 같은 상담을 ai-api가 여러 번 분석하게 된다(느리고 비싸다).
    @Transactional
    public AnalysisJobResponse submit(Long consultationId) {
        Consultation consultation = consultationService.findById(consultationId); // 없는 상담이면 404
        Optional<AnalysisJob> running =
                analysisJobRepository.findFirstByConsultationIdAndStatusInOrderByIdDesc(consultationId, ACTIVE);
        if (running.isPresent()) {
            return toResponse(running.get());
        }
        AnalysisJob job = analysisJobRepository.save(new AnalysisJob(consultation, currentActorEmail()));
        eventPublisher.publishEvent(new AnalysisJobSubmittedEvent(job.getId()));
        return toResponse(job);
    }

    public AnalysisJobResponse get(Long jobId) {
        return toResponse(findById(jobId));
    }

    // 새로고침한 화면이 진행 중이던 작업에 다시 붙기 위한 조회. 없으면 비어 있다.
    public Optional<AnalysisJobResponse> findActive(Long consultationId) {
        consultationService.findById(consultationId); // 없는 상담이면 404
        return analysisJobRepository.findFirstByConsultationIdAndStatusInOrderByIdDesc(consultationId, ACTIVE)
                .map(this::toResponse);
    }

    // ── 아래 세 개는 백그라운드 러너가 부른다 ──────────────────────────────
    //
    // 각각을 따로 떼어 짧은 트랜잭션으로 만든 이유: 가운데 ai-api 호출이 몇 분 걸리는데,
    // 그 시간 동안 트랜잭션을 열어 두면 DB 커넥션 하나가 계속 묶인다. 분석이 몇 건만 겹쳐도
    // 커넥션 풀이 바닥나 앱 전체가 멈춘다.

    // 작업을 집어 실행 상태로 바꾸고, 대상 상담 id를 돌려준다.
    // 이미 다른 스레드가 집어갔거나 없는 작업이면 비어 있는 값을 돌려준다 — 이벤트가 두 번
    // 전달되더라도 실제 분석은 한 번만 돌게 하는 장치다.
    @Transactional
    public Optional<Long> claim(Long jobId) {
        AnalysisJob job = analysisJobRepository.findById(jobId).orElse(null);
        if (job == null || job.getStatus() != AnalysisJobStatus.PENDING) {
            return Optional.empty();
        }
        job.setStatus(AnalysisJobStatus.RUNNING);
        job.setStartedAt(LocalDateTime.now());
        // 아직 아무도 상담 상태를 건드리지 않은 시점이라, 지금 값이 "분석 시작 전 상태"다.
        // 실패했을 때 여기로 되돌린다(markFailed 참고).
        job.setPreviousConsultationStatus(job.getConsultation().getStatus());
        return Optional.of(job.getConsultation().getId());
    }

    @Transactional
    public void markSucceeded(Long jobId, AiAnalysisResponse result) {
        AnalysisJob job = findById(jobId);
        job.setResultJson(objectMapper.writeValueAsString(result));
        job.setStatus(AnalysisJobStatus.SUCCEEDED);
        job.setFinishedAt(LocalDateTime.now());
        // 새 결과가 나온 지금이 지난 결과를 지울 자리다. 시작할 때 지우지 않는 이유는,
        // 새 분석이 실패하면 상담원에게 아무것도 안 남기 때문이다 — 새것이 생긴 뒤에 지운다.
        analysisJobRepository.clearSupersededResults(job.getConsultation().getId(), jobId);
    }

    @Transactional
    public void markFailed(Long jobId, String message) {
        AnalysisJob job = findById(jobId);
        job.setErrorMessage(truncate(message));
        job.setStatus(AnalysisJobStatus.FAILED);
        job.setFinishedAt(LocalDateTime.now());
        // 상담을 "분석 중"에 두고 끝내면 안 된다 — 아무도 분석하고 있지 않은데 목록에는
        // 계속 진행 중으로 보인다. claim()이 적어둔 원래 상태로 되돌린다.
        if (job.getPreviousConsultationStatus() != null) {
            job.getConsultation().setStatus(job.getPreviousConsultationStatus());
        }
    }

    private AnalysisJob findById(Long jobId) {
        return analysisJobRepository.findById(jobId)
                .orElseThrow(() -> new NotFoundException("분석 작업을 찾을 수 없습니다: " + jobId));
    }

    private String truncate(String message) {
        if (message == null) {
            return null;
        }
        return message.length() <= MAX_ERROR_LENGTH ? message : message.substring(0, MAX_ERROR_LENGTH);
    }

    // AuditLogService.currentActorEmail()과 같은 방식. 아직 인증이 없는 경로에서 불릴 수 있어
    // 없으면 null로 둔다.
    private String currentActorEmail() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated()) {
            return null;
        }
        String name = authentication.getName();
        return "anonymousUser".equals(name) ? null : name;
    }

    private AnalysisJobResponse toResponse(AnalysisJob job) {
        return new AnalysisJobResponse(
                job.getId(),
                job.getConsultation().getId(),
                job.getStatus(),
                parseJson(job.getResultJson()),
                job.getErrorMessage(),
                job.getCreatedAt(),
                job.getStartedAt(),
                job.getFinishedAt()
        );
    }

    private JsonNode parseJson(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            return objectMapper.readTree(raw);
        } catch (JacksonException e) {
            // 우리가 직렬화해 넣은 값이라 여기 걸리면 데이터 자체가 깨진 것이다.
            throw new IllegalStateException("저장된 분석 결과를 읽는 중 오류가 발생했습니다", e);
        }
    }
}
