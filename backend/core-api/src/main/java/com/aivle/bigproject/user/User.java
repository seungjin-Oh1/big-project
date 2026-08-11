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

    // 비밀번호를 마지막으로 바꾼 시각. 유효기간 판단에 쓴다
    // ("개인정보의 기술적·관리적 보호조치 기준" 제4조 접근통제 — 비밀번호 유효기간 설정).
    //
    // 이 기능이 생기기 전에 만들어진 계정은 값이 비어 있다. 그때는 만료로 보지 않고,
    // 다음 로그인 때 현재 시각으로 채워 거기서부터 기간을 센다(AuthService.login).
    // 소급해서 만료 처리하면 팀원 전원이 한꺼번에 로그인 못 하게 된다.
    @Column(name = "password_changed_at")
    private LocalDateTime passwordChangedAt;

    // ── 소속·연락처 ──
    //
    // 가입 화면은 이 셋을 필수로 받고 동의표에도 "연락처, 소속(지부·부서)"을 수집 항목으로
    // 적어 두는데, 예전에는 서버로 아예 보내지 않아 브라우저 localStorage(registeredUsers)에만
    // 남았다. 그래서 ①가입한 그 브라우저에서만 보이고 ②관리자가 다른 PC에서 승인 심사를 할 때
    // 소속이 '-'로 비었으며 ③동의까지 받은 항목을 정작 보관하지 않는 상태였다.
    //
    // 소속·지부는 그 자체로 개인을 특정하지 않고(이름·이메일은 이미 암호화되어 있다) 관리자
    // 화면에서 지부별로 묶어 보는 데 쓰므로 평문으로 둔다.
    @Column(length = 200)
    private String organization;

    @Column(length = 100)
    private String branch;

    // 연락처는 그 자체가 개인정보라 이름·이메일과 같은 규칙으로 암호화한다
    // (보호조치 기준 제6조). 암호문이 평문보다 길어져 length를 넉넉히 잡는다.
    @Convert(converter = CryptoConverter.class)
    @Column(length = 500)
    private String phone;

    // 가입 승인 상태. ADMIN은 가입 즉시 APPROVED, CONSULTANT/LAWYER는 PENDING으로
    // 시작해 관리자가 승인/거절해야 함 (AuthService.login()에서 이 값을 검사).
    // 필드 기본값 PENDING은 UserService.create()(core-api 자체 조회용 계정 생성 등
    // 로그인과 무관한 경로)에서도 안전한 기본값이라 그대로 둠.
    @Enumerated(EnumType.STRING)
    @Column(name = "approval_status", nullable = false)
    private ApprovalStatus approvalStatus = ApprovalStatus.PENDING;

    // 개인정보 수집·이용에 동의한 시각 (개인정보 보호법 제15조 제2항).
    //
    // 화면에서 동의를 받는 것만으로는 부족하다 — 분쟁이 생기면 "동의를 받았다"는 증빙이
    // 있어야 한다. 동의 없이 가입할 수 없으므로 신규 가입은 항상 값이 채워지고,
    // 이 컬럼이 비어 있는 계정은 이 기능이 생기기 전에 만들어진 것이다(소급 기록은 하지 않는다 —
    // 받지 않은 동의를 받은 것처럼 남기면 증빙이 아니라 위조가 된다).
    @Column(name = "privacy_agreed_at")
    private LocalDateTime privacyAgreedAt;

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
