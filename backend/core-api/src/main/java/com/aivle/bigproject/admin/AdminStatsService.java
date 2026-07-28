package com.aivle.bigproject.admin;

import com.aivle.bigproject.admin.dto.AdminStatsResponse;
import com.aivle.bigproject.admin.dto.AdminStatsResponse.AnalysisStatusBreakdown;
import com.aivle.bigproject.analysis.AiAnalysisRepository;
import com.aivle.bigproject.analysis.AnalysisReviewStatus;
import com.aivle.bigproject.consultation.ConsultationRepository;
import com.aivle.bigproject.user.ApprovalStatus;
import com.aivle.bigproject.user.UserRepository;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class AdminStatsService {

    private final ConsultationRepository consultationRepository;
    private final UserRepository userRepository;
    private final AiAnalysisRepository aiAnalysisRepository;

    public AdminStatsService(ConsultationRepository consultationRepository,
                              UserRepository userRepository,
                              AiAnalysisRepository aiAnalysisRepository) {
        this.consultationRepository = consultationRepository;
        this.userRepository = userRepository;
        this.aiAnalysisRepository = aiAnalysisRepository;
    }

    public AdminStatsResponse getStats() {
        long totalConsultations = consultationRepository.count();
        long activeUsers = userRepository.countByApprovalStatus(ApprovalStatus.APPROVED);
        long pendingUserApprovals = userRepository.countByApprovalStatus(ApprovalStatus.PENDING);

        long approved = aiAnalysisRepository.countByStatus(AnalysisReviewStatus.APPROVED);
        long rejected = aiAnalysisRepository.countByStatus(AnalysisReviewStatus.REVISION_REQUESTED);
        long drafted = aiAnalysisRepository.countByStatus(AnalysisReviewStatus.DRAFTED);
        long submitted = aiAnalysisRepository.countByStatus(AnalysisReviewStatus.SUBMITTED_FOR_REVIEW);
        long pending = drafted + submitted;
        long totalAnalyses = approved + rejected + pending;

        double analysisProcessingRate = totalAnalyses == 0
                ? 0.0
                : (double) (approved + rejected) / totalAnalyses;

        Map<String, Long> caseTypeStats = new LinkedHashMap<>();
        for (Object[] row : aiAnalysisRepository.countGroupedByCaseType()) {
            caseTypeStats.put((String) row[0], (Long) row[1]);
        }

        return new AdminStatsResponse(
                totalConsultations,
                activeUsers,
                analysisProcessingRate,
                pendingUserApprovals,
                caseTypeStats,
                new AnalysisStatusBreakdown(approved, rejected, pending)
        );
    }
}
