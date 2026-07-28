package com.aivle.bigproject.audit;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalDateTime;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.List;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class AuditLogService {

    private final AuditLogRepository auditLogRepository;

    public AuditLogService(AuditLogRepository auditLogRepository) {
        this.auditLogRepository = auditLogRepository;
    }

    // SEC-01-01-01: 상담조회/AI분석실행/결과수정/검토승인/문서다운로드를 해시체인으로 기록.
    // synchronized인 이유: "마지막 로그의 hash를 읽고 그걸 이어붙여 다음 로그를 쓴다"는 두 단계가
    // 동시에 여러 요청에서 일어나면 같은 prevHash를 보고 분기(체인이 아니라 트리)가 생길 수 있음.
    // 인스턴스가 여러 대로 수평 확장되면 이 방식으론 부족하고 DB 행 잠금(SELECT ... FOR UPDATE)이 필요함 —
    // 지금 규모에선 단일 인스턴스 기준으로 충분함.
    @Transactional
    public synchronized void record(AuditAction action, String targetType, Long targetId, String detail) {
        String prevHash = auditLogRepository.findTopByOrderByIdDesc()
                .map(AuditLog::getHash)
                .orElse(null);
        String actorEmail = currentActorEmail();
        // Postgres timestamp 컬럼은 마이크로초까지만 저장하는데 LocalDateTime.now()는 그보다 더 미세한
        // 정밀도를 가질 수 있어(Windows 등), 저장 전에 미리 잘라내야 DB 왕복 후에도 해시가 재현됨 —
        // 안 그러면 verifyChain()이 실제로는 위조되지 않은 로그도 "깨졌다"고 오판함.
        LocalDateTime createdAt = LocalDateTime.now().truncatedTo(ChronoUnit.MICROS);
        String hash = computeHash(prevHash, actorEmail, action, targetType, targetId, detail, createdAt);
        auditLogRepository.save(new AuditLog(actorEmail, action, targetType, targetId, detail, createdAt, prevHash, hash));
    }

    public List<AuditLog> findAll() {
        return auditLogRepository.findAllByOrderByIdDesc();
    }

    // 전체 로그를 처음부터 순회하며 저장된 hash를 재계산해서 비교. 하나라도 다르면(수정/삭제/끼워넣기)
    // 그 지점 이후 hash가 전부 어긋나므로, 가장 먼저 어긋난 로그의 id를 그대로 "위조 시작 지점"으로 볼 수 있음.
    public ChainVerificationResult verifyChain() {
        List<AuditLog> logs = auditLogRepository.findAllByOrderByIdAsc();
        String expectedPrevHash = null;
        for (AuditLog log : logs) {
            if (!java.util.Objects.equals(log.getPrevHash(), expectedPrevHash)) {
                return new ChainVerificationResult(false, log.getId());
            }
            String recomputed = computeHash(log.getPrevHash(), log.getActorEmail(), log.getAction(),
                    log.getTargetType(), log.getTargetId(), log.getDetail(), log.getCreatedAt());
            if (!recomputed.equals(log.getHash())) {
                return new ChainVerificationResult(false, log.getId());
            }
            expectedPrevHash = log.getHash();
        }
        return new ChainVerificationResult(true, null);
    }

    public record ChainVerificationResult(boolean intact, Long brokenAtLogId) {}

    private String computeHash(String prevHash, String actorEmail, AuditAction action, String targetType,
                                Long targetId, String detail, LocalDateTime createdAt) {
        String payload = String.join("|",
                nullToEmpty(prevHash), nullToEmpty(actorEmail), action.name(), targetType,
                nullToEmpty(targetId == null ? null : targetId.toString()), nullToEmpty(detail), createdAt.toString());
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashBytes = digest.digest(payload.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hashBytes);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256을 사용할 수 없습니다", e);
        }
    }

    private String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    // 미인증 요청(SecurityConfig에서 아직 permitAll인 엔드포인트)에서는 인증 정보가 없거나
    // 익명(anonymousUser)이라 actorEmail을 null로 남긴다 — 나중에 인증이 전면 강제되면 항상 채워짐.
    private String currentActorEmail() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated()) {
            return null;
        }
        String name = authentication.getName();
        return "anonymousUser".equals(name) ? null : name;
    }
}
