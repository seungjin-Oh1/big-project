package com.aivle.bigproject.storage;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.LocalDateTime;
import lombok.Getter;
import lombok.NoArgsConstructor;

// presigned URL로 발급해 준 S3 key와 그걸 받아 간 사용자를 기록한다.
//
// 이게 없으면 "이 key를 이 사람이 올린 게 맞는가"를 확인할 방법이 없다. 실제로
// POST /api/consultations/{id}/attachments/register는 fileKey를 검사 없이 받아서 저장했고,
// DELETE /api/attachments/unregistered는 DB에 없는 key면 무엇이든 지웠다 — 버킷의 다른
// 오브젝트를 자기 상담에 붙여 내려받거나(첨부 다운로드 경로로 그대로 나간다) 지울 수 있었다.
//
// 메모리 대신 테이블에 두는 이유: 파일을 올려두고 상담을 나중에 만드는 흐름이 있어서
// 발급과 등록 사이에 재배포가 끼면 멀쩡한 업로드가 등록 거부된다.
//
// 사용자는 email이 아니라 id로 적는다. users.email은 암호화 컬럼인데 여기에 평문으로
// 다시 적으면 가려 둔 값이 이 테이블에서 새어 나간다.
@Entity
@Table(name = "issued_upload_key")
@Getter
@NoArgsConstructor
public class IssuedUploadKey {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    // S3 key. "consult-attachments/{UUID}__{파일명}" 형태라 길어질 수 있어 넉넉히 잡는다.
    @Column(name = "storage_key", nullable = false, unique = true, length = 1024)
    private String storageKey;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "issued_at", nullable = false)
    private LocalDateTime issuedAt;

    public IssuedUploadKey(String storageKey, Long userId) {
        this.storageKey = storageKey;
        this.userId = userId;
        this.issuedAt = LocalDateTime.now();
    }
}
