package com.aivle.bigproject.audit;

import com.aivle.bigproject.audit.AuditLogService.ChainVerificationResult;
import com.aivle.bigproject.audit.dto.AuditLogResponse;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AuditLogController {

    private final AuditLogService auditLogService;

    public AuditLogController(AuditLogService auditLogService) {
        this.auditLogService = auditLogService;
    }

    // GET /api/admin/audit-logs — 관리자 전용(SecurityConfig). 최신순.
    @GetMapping("/api/admin/audit-logs")
    public List<AuditLogResponse> findAll() {
        return auditLogService.findAll().stream()
                .map(AuditLogResponse::from)
                .toList();
    }

    // GET /api/admin/audit-logs/verify — 관리자 전용. 체인 전체를 재계산해서 위변조 여부 확인.
    @GetMapping("/api/admin/audit-logs/verify")
    public ChainVerificationResult verify() {
        return auditLogService.verifyChain();
    }
}
