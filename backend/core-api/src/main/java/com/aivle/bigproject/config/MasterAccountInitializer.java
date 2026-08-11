package com.aivle.bigproject.config;

import com.aivle.bigproject.user.ApprovalStatus;
import com.aivle.bigproject.user.User;
import com.aivle.bigproject.user.UserRepository;
import com.aivle.bigproject.user.UserRole;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

// 회원가입 없이도 역할별(상담원/변호사/관리자) 마스터 계정으로 실제 로그인 플로우(/api/auth/login)를
// 그대로 태워볼 수 있도록, 앱 기동 시 계정이 없으면 생성한다. findByEmail로 매번 존재 여부를 확인하고
// 없을 때만 만들기 때문에 idempotent하고, DB를 리셋해도 다음 기동 시 자동 복구된다.
//
// 관리자 계정을 만드는 유일한 경로이기도 하다 — 가입(/api/auth/register)은 역할과 무관하게
// PENDING으로만 만들어지므로(AuthService.register), 첫 승인자는 여기서 나와야 한다.
// 배포 시에는 MASTER_ADMIN_EMAIL/PASSWORD를 실제 값으로 넣어야 한다(DevSecretGuard가 확인한다).
//
// 비밀번호는 BCrypt로 인코딩해서 저장한다. 예전에는 평문으로 넣고 AuthService.login()이
// @test.test 도메인이면 문자열 비교로 분기했는데, 그건 "복호화되지 않도록 일방향 암호화해
// 저장하라"는 보호조치 기준 제6조에 어긋나고, 도메인만 바꾸면 어떤 계정이든 평문 비교 경로를
// 탈 수 있어서 제거했다. 그전에 평문으로 저장된 행은 아래 migrateLegacyPlainPassword가
// 기동 시 같은 비밀번호 그대로 BCrypt로 바꿔준다(팀원 로컬 DB가 잠기지 않게).
@Component
public class MasterAccountInitializer implements CommandLineRunner {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;

    private final String talkerEmail;
    private final String talkerPassword;
    private final String talkerName;
    private final String lawyerEmail;
    private final String lawyerPassword;
    private final String lawyerName;
    private final String adminEmail;
    private final String adminPassword;
    private final String adminName;

    public MasterAccountInitializer(
            UserRepository userRepository,
            PasswordEncoder passwordEncoder,
            @Value("${app.master-account.talker.email}") String talkerEmail,
            @Value("${app.master-account.talker.password}") String talkerPassword,
            @Value("${app.master-account.talker.name}") String talkerName,
            @Value("${app.master-account.lawyer.email}") String lawyerEmail,
            @Value("${app.master-account.lawyer.password}") String lawyerPassword,
            @Value("${app.master-account.lawyer.name}") String lawyerName,
            @Value("${app.master-account.admin.email}") String adminEmail,
            @Value("${app.master-account.admin.password}") String adminPassword,
            @Value("${app.master-account.admin.name}") String adminName) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.talkerEmail = talkerEmail;
        this.talkerPassword = talkerPassword;
        this.talkerName = talkerName;
        this.lawyerEmail = lawyerEmail;
        this.lawyerPassword = lawyerPassword;
        this.lawyerName = lawyerName;
        this.adminEmail = adminEmail;
        this.adminPassword = adminPassword;
        this.adminName = adminName;
    }

    @Override
    @Transactional
    public void run(String... args) {
        createIfAbsent(talkerEmail, talkerPassword, talkerName, UserRole.CONSULTANT);
        createIfAbsent(lawyerEmail, lawyerPassword, lawyerName, UserRole.LAWYER);
        createIfAbsent(adminEmail, adminPassword, adminName, UserRole.ADMIN);
    }

    private void createIfAbsent(String email, String password, String name, UserRole role) {
        User existing = userRepository.findByEmail(email).orElse(null);
        if (existing != null) {
            migrateLegacyPlainPassword(existing);
            return;
        }
        User user = new User(name, role, email);
        user.setPasswordHash(passwordEncoder.encode(password));
        user.setApprovalStatus(ApprovalStatus.APPROVED);
        userRepository.save(user);
    }

    // 이 기능 이전에 만들어진 마스터 계정은 password_hash에 평문이 들어 있다. 저장된 그 값을
    // 그대로 BCrypt로 인코딩해 덮어쓴다 — 설정값(app.master-account.*.password)이 아니라
    // DB에 있는 값을 쓰는 이유는, 그동안 비밀번호를 바꿨다면 지금 쓰고 있는 쪽이 맞기 때문이다.
    //
    // 이미 BCrypt면 아무것도 하지 않으므로 기동을 여러 번 해도 결과가 같다.
    private void migrateLegacyPlainPassword(User user) {
        String stored = user.getPasswordHash();
        if (stored == null || stored.isBlank() || isBcryptHash(stored)) {
            return;
        }
        user.setPasswordHash(passwordEncoder.encode(stored));
        userRepository.save(user);
    }

    private boolean isBcryptHash(String stored) {
        return stored.startsWith("$2a$") || stored.startsWith("$2b$") || stored.startsWith("$2y$");
    }
}
