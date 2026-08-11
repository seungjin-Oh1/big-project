package com.aivle.bigproject.storage;

import com.aivle.bigproject.common.exception.BadRequestException;
import com.aivle.bigproject.common.exception.UnauthorizedException;
import com.aivle.bigproject.user.User;
import com.aivle.bigproject.user.UserRepository;
import java.time.LocalDateTime;
import java.util.Optional;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

// "이 S3 key를 이 사람이 올린 게 맞는가"를 판단하는 자리.
//
// 파일 바이트는 브라우저가 presigned URL로 S3에 바로 올려서 서버를 지나지 않는다. 그래서
// 나중에 그 key를 상담에 등록할 때, 서버가 가진 정보만으로는 그게 이 사람이 방금 올린
// 파일인지 남의 파일인지 구분할 수 없었다. 실제로 두 곳이 열려 있었다:
//
//   POST /api/consultations/{id}/attachments/register   fileKey를 검사 없이 저장
//   POST /api/consultations (attachments[])             같은 모양으로 상담 생성 시에도
//   DELETE /api/attachments/unregistered?fileKey=...     DB에 없는 key면 무엇이든 삭제
//
// 등록만 되면 첨부 다운로드 경로(GET .../attachments/{id})로 그 오브젝트가 그대로 내려온다.
// 즉 버킷 안의 다른 파일을 자기 상담에 붙여서 받아 갈 수 있었다.
//
// 그래서 presigned URL을 내줄 때 key와 받아 간 사람을 남기고(record), 등록·삭제 시점에
// 그 기록과 대조한다(assertOwnedByCurrentUser).
@Service
public class UploadKeyOwnership {

    // 발급 기록을 남겨두는 기간. presigned URL 자체는 15분이면 만료되지만, 파일을 올려두고
    // 상담을 나중에 만드는 흐름이 있어서 등록까지의 간격을 넉넉히 잡는다.
    private static final int RETENTION_DAYS = 30;

    private final IssuedUploadKeyRepository issuedUploadKeyRepository;
    private final UserRepository userRepository;

    public UploadKeyOwnership(IssuedUploadKeyRepository issuedUploadKeyRepository,
                               UserRepository userRepository) {
        this.issuedUploadKeyRepository = issuedUploadKeyRepository;
        this.userRepository = userRepository;
    }

    // presigned URL을 내주는 순간 호출한다.
    @Transactional
    public void record(String storageKey) {
        User user = currentUser();
        // 같은 key가 두 번 채번될 일은 없지만(UUID), 있더라도 기록이 어긋나지 않게 덮어쓰지 않는다.
        if (issuedUploadKeyRepository.findByStorageKey(storageKey).isPresent()) {
            return;
        }
        issuedUploadKeyRepository.save(new IssuedUploadKey(storageKey, user.getId()));
    }

    // 등록·삭제 전에 호출한다. 내가 발급받은 key가 아니면 거부한다.
    //
    // 400으로 돌려주는 이유: 404/403으로 나누면 "그 key는 존재한다"거나 "남이 올린 것이다"
    // 같은 사실이 응답으로 구분돼 나간다. 어느 쪽이든 클라이언트가 할 일은 같다.
    @Transactional(readOnly = true)
    public void assertOwnedByCurrentUser(String storageKey) {
        if (storageKey == null || storageKey.isBlank()) {
            throw new BadRequestException("파일 키가 없습니다.");
        }
        User user = currentUser();
        Long ownerId = issuedUploadKeyRepository.findByStorageKey(storageKey)
                .map(IssuedUploadKey::getUserId)
                .orElse(null);
        if (ownerId == null || !ownerId.equals(user.getId())) {
            throw new BadRequestException("이 계정이 올린 파일이 아닙니다: " + storageKey);
        }
    }

    private User currentUser() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        Optional<User> user = authentication == null || !authentication.isAuthenticated()
                ? Optional.empty()
                : userRepository.findByEmail(authentication.getName());
        return user.orElseThrow(() -> new UnauthorizedException("로그인이 필요합니다."));
    }

    // 오래된 발급 기록을 걷어낸다. 지워도 이미 상담에 등록된 첨부(Attachment)는 영향받지 않는다 —
    // 이 테이블은 '등록해도 되는지'를 판단할 때만 보고, 등록이 끝난 뒤에는 쓰이지 않는다.
    @Scheduled(cron = "0 30 4 * * *")
    @Transactional
    public void purgeExpired() {
        issuedUploadKeyRepository.deleteByIssuedAtBefore(LocalDateTime.now().minusDays(RETENTION_DAYS));
    }
}
