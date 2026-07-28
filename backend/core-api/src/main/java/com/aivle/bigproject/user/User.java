package com.aivle.bigproject.user;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.EntityListeners;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.LocalDateTime;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

// 상담원(사용자) 계정. Consultation이 이 엔티티를 FK로 참조한다.
@Entity
// "user"는 PostgreSQL 예약어라 테이블명으로 못 써서 users로 지정
@Table(name = "users")
@Getter
@Setter
@NoArgsConstructor // JPA는 파라미터 없는 생성자가 필수라서 Lombok으로 자동 생성
@EntityListeners(AuditingEntityListener.class) // createdAt/updatedAt 자동 기록 활성화
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY) // DB가 auto-increment로 값 채움
    private Long id;

    // 암호화하면 평문보다 훨씬 길어져서(Base64(IV+암호문+태그)) length를 넉넉하게 잡음
    @Convert(converter = CryptoConverter.class)
    @Column(nullable = false, length = 500)
    private String name;

    @Enumerated(EnumType.STRING) // enum을 숫자(0,1..)가 아니라 "CONSULTANT" 같은 문자열로 저장
    @Column(nullable = false)
    private UserRole role;

    @Convert(converter = CryptoConverter.class)
    @Column(nullable = false, unique = true, length = 500)
    private String email;

    // 비밀번호 해시 (BCrypt). AuthService.register()에서 채워짐.
    @Column(name = "password_hash")
    private String passwordHash;

    // 가입 승인 상태. ADMIN은 가입 즉시 APPROVED, CONSULTANT/LAWYER는 PENDING으로
    // 시작해 관리자가 승인/거절해야 함 (AuthService.login()에서 이 값을 검사).
    // 필드 기본값 PENDING은 UserService.create()(core-api 자체 조회용 계정 생성 등
    // 로그인과 무관한 경로)에서도 안전한 기본값이라 그대로 둠.
    @Enumerated(EnumType.STRING)
    @Column(name = "approval_status", nullable = false)
    private ApprovalStatus approvalStatus = ApprovalStatus.PENDING;

    @CreatedDate
    @Column(nullable = false, updatable = false) // 생성 시 한 번만 기록, 이후 수정 불가
    private LocalDateTime createdAt;

    @LastModifiedDate
    @Column(nullable = false)
    private LocalDateTime updatedAt;

    // 생성 시 필요한 필드만 받는 생성자 (id/시간은 자동으로 채워짐)
    public User(String name, UserRole role, String email) {
        this.name = name;
        this.role = role;
        this.email = email;
    }
}
