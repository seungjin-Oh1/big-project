package com.aivle.bigproject.storage;

import java.time.LocalDateTime;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface IssuedUploadKeyRepository extends JpaRepository<IssuedUploadKey, Long> {

    Optional<IssuedUploadKey> findByStorageKey(String storageKey);

    // 오래된 발급 기록 정리용. 업로드하고 상담을 만들기까지의 간격을 넉넉히 넘기면 지운다.
    long deleteByIssuedAtBefore(LocalDateTime threshold);
}
