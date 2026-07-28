package com.aivle.bigproject.audit;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import java.time.LocalDateTime;
import lombok.Getter;
import lombok.NoArgsConstructor;

// 감사 로그 1건. 수정용 setter를 두지 않는다 — insert-only(append-only)여야
// 해시체인 무결성 검증(AuditLogService.verifyChain)이 의미가 있기 때문.
@Entity
@Getter
@NoArgsConstructor
public class AuditLog {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    // 행위 주체. 아직 모든 엔드포인트가 인증을 강제하진 않아(SecurityConfig 참고) null일 수 있음.
    @Column(name = "actor_email")
    private String actorEmail;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private AuditAction action;

    @Column(name = "target_type", nullable = false)
    private String targetType;

    @Column(name = "target_id")
    private Long targetId;

    @Column(columnDefinition = "TEXT")
    private String detail;

    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;

    // 직전 로그의 hash. 첫 로그는 null(제네시스).
    @Column(name = "prev_hash", length = 64)
    private String prevHash;

    // SHA-256(prevHash + actorEmail + action + targetType + targetId + detail + createdAt)
    @Column(nullable = false, length = 64)
    private String hash;

    public AuditLog(String actorEmail, AuditAction action, String targetType, Long targetId, String detail,
                     LocalDateTime createdAt, String prevHash, String hash) {
        this.actorEmail = actorEmail;
        this.action = action;
        this.targetType = targetType;
        this.targetId = targetId;
        this.detail = detail;
        this.createdAt = createdAt;
        this.prevHash = prevHash;
        this.hash = hash;
    }
}
