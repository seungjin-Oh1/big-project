package com.aivle.bigproject.audit.dto;

import com.aivle.bigproject.audit.AuditAction;
import com.aivle.bigproject.audit.AuditLog;
import java.time.LocalDateTime;

public record AuditLogResponse(
        Long id,
        String actorEmail,
        AuditAction action,
        String targetType,
        Long targetId,
        String detail,
        LocalDateTime createdAt
) {
    public static AuditLogResponse from(AuditLog log) {
        return new AuditLogResponse(
                log.getId(),
                log.getActorEmail(),
                log.getAction(),
                log.getTargetType(),
                log.getTargetId(),
                log.getDetail(),
                log.getCreatedAt()
        );
    }
}
