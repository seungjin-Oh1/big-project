package com.aivle.bigproject.auth;

import com.aivle.bigproject.auth.dto.AuthResponse;
import com.aivle.bigproject.auth.dto.ChangePasswordRequest;
import com.aivle.bigproject.auth.dto.LoginRequest;
import com.aivle.bigproject.auth.dto.RegisterRequest;
import com.aivle.bigproject.common.exception.BadRequestException;
import com.aivle.bigproject.common.exception.ConflictException;
import com.aivle.bigproject.common.exception.ForbiddenException;
import com.aivle.bigproject.common.exception.UnauthorizedException;
import com.aivle.bigproject.security.JwtService;
import com.aivle.bigproject.user.ApprovalStatus;
import com.aivle.bigproject.user.User;
import com.aivle.bigproject.user.UserRepository;
import java.time.LocalDateTime;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class AuthService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final LoginAttemptTracker loginAttemptTracker;

    private final CaptchaService captchaService;

    public AuthService(UserRepository userRepository, PasswordEncoder passwordEncoder, JwtService jwtService,
                        LoginAttemptTracker loginAttemptTracker, CaptchaService captchaService) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.loginAttemptTracker = loginAttemptTracker;
        this.captchaService = captchaService;
    }

    // 이 이메일로 로그인하려면 캡차가 필요한지. 화면이 로그인 실패 후 캡차를 띄울지 판단한다.
    public boolean captchaRequired(String email) {
        return loginAttemptTracker.captchaRequired(email);
    }

    @Transactional
    public AuthResponse register(RegisterRequest request) {
        validatePasswordRule(request.password(), request.email());
        // 개인정보 수집·이용에 동의해야 가입할 수 있다(개인정보 보호법 제15조 제2항).
        // 화면에서도 막고 있지만 이 엔드포인트를 직접 부르면 그 검사를 지나칠 수 있어 여기서도 본다.
        if (!Boolean.TRUE.equals(request.privacyAgreed())) {
            throw new BadRequestException("개인정보 수집·이용 동의가 필요합니다.");
        }
        userRepository.findByEmail(request.email()).ifPresent(existing -> {
            throw new ConflictException("이미 가입된 이메일입니다: " + request.email());
        });
        User user = new User(request.name(), request.role(), request.email());
        user.setPasswordHash(passwordEncoder.encode(request.password()));
        // 동의표에 적어 둔 수집 항목(연락처, 소속(지부·부서))을 실제로 보관한다.
        // 예전에는 화면이 받기만 하고 서버로 보내지 않아 브라우저에만 남았다.
        user.setOrganization(blankToNull(request.organization()));
        user.setBranch(blankToNull(request.branch()));
        user.setPhone(blankToNull(request.phone()));
        // 동의한 사실을 시각과 함께 남긴다 — 분쟁이 생기면 이게 증빙이 된다.
        user.setPrivacyAgreedAt(LocalDateTime.now());
        // 역할과 무관하게 관리자 승인 전까지 로그인 불가(login() 참고).
        //
        // 예전에는 ADMIN만 가입 즉시 APPROVED였다. 그런데 role은 요청 본문에 실려 오는 값이고
        // 이 엔드포인트는 SecurityConfig에서 permitAll이다 — 즉 아무나
        //   POST /api/auth/register {"role":"ADMIN", ...}
        // 한 번으로 그 자리에서 유효한 관리자 토큰을 받아 갔다. 가입 승인·감사 로그 조회·운영
        // 통계가 전부 열리므로, 관리자 승인 체계 자체가 성립하지 않던 상태다.
        //
        // 첫 관리자는 가입이 아니라 MasterAccountInitializer(app.master-account.admin.*)가 만든다.
        // 그 계정으로 로그인해 이후 관리자 신청을 승인하면 된다.
        user.setApprovalStatus(ApprovalStatus.PENDING);
        User saved = userRepository.save(user);
        // PENDING 상태에서 토큰을 바로 내주면 login()의 승인 대기 차단을 그대로 우회할 수 있다
        // (JwtAuthenticationFilter는 토큰만 보고 요청마다 승인 상태를 다시 확인하지 않음) —
        // 승인되기 전까지는 token을 null로 돌려주고, 승인 후 /login으로만 토큰을 받게 한다.
        if (saved.getApprovalStatus() != ApprovalStatus.APPROVED) {
            return new AuthResponse(null, saved.getId(), saved.getName(), saved.getRole(), saved.getEmail(), false);
        }
        return toAuthResponse(saved, false);
    }

    @Transactional
    public AuthResponse login(LoginRequest request) {
        // 비밀번호를 무제한으로 넣어볼 수 없게 실패 횟수를 세어 잠시 막는다(LoginAttemptTracker).
        // 비밀번호 검사보다 먼저 봐야 잠긴 동안의 시도가 아예 처리되지 않는다.
        long lockedSeconds = loginAttemptTracker.lockedSecondsRemaining(request.email());
        if (lockedSeconds > 0) {
            throw new ForbiddenException(
                    "로그인 시도가 너무 많습니다. %d분 %d초 후에 다시 시도해주세요."
                            .formatted(lockedSeconds / 60, lockedSeconds % 60));
        }

        // 실패가 몇 번 쌓이면 캡차를 요구한다(보호조치 기준 제4조 접근통제).
        // 비밀번호 검사보다 먼저 본다 — 캡차를 못 풀면 비밀번호를 맞혔는지조차 알려주지 않는다.
        //
        // 캡차 실패도 실패로 센다. 안 그러면 캡차를 아무렇게나 넣어 잠금 시계를 피하면서
        // 비밀번호 시도만 계속할 수 있다.
        if (loginAttemptTracker.captchaRequired(request.email())
                && !captchaService.verify(request.captchaId(), request.captchaAnswer())) {
            loginAttemptTracker.recordFailure(request.email());
            throw new CaptchaRequiredException("자동 입력 방지 문자를 다시 확인해주세요.");
        }

        // 없는 이메일도 실패로 세고 같은 메시지를 준다 — 응답이 다르면 어떤 이메일이
        // 가입돼 있는지 알아낼 수 있다.
        User user = userRepository.findByEmail(request.email()).orElse(null);
        if (user == null || user.getPasswordHash() == null || !matchesPassword(request.password(), user)) {
            loginAttemptTracker.recordFailure(request.email());
            throw new UnauthorizedException("이메일 또는 비밀번호가 올바르지 않습니다.");
        }

        // 승인 대기·거절은 비밀번호가 맞은 경우다. 본인이 맞으므로 실패로 세지 않는다 —
        // 승인만 기다리는 사람이 여러 번 눌렀다고 잠기면 안 된다.
        if (user.getApprovalStatus() == ApprovalStatus.PENDING) {
            throw new ForbiddenException("관리자 승인 대기 중인 계정입니다.");
        }
        if (user.getApprovalStatus() == ApprovalStatus.REJECTED) {
            throw new ForbiddenException("가입이 거절된 계정입니다.");
        }

        loginAttemptTracker.recordSuccess(request.email());
        return toAuthResponse(user, isPasswordExpired(user));
    }

    // ── 비밀번호 유효기간 ──
    //
    // "개인정보의 기술적·관리적 보호조치 기준" 제4조가 요구하는 접근통제 항목이다.
    //
    // 만료돼도 로그인을 막지 않는다. 상담 도중에 갑자기 못 들어가는 쪽이 더 큰 사고이고,
    // 화면이 이 값을 보고 비밀번호 변경으로 안내한다(App.jsx).
    //
    // 이 기능 이전 계정은 passwordChangedAt이 비어 있다. 그런 계정을 만료로 보면 팀원
    // 전원이 한꺼번에 안내를 받게 되므로, 만료로 치지 않고 지금 시각으로 채워 거기서부터 센다.
    private static final int PASSWORD_MAX_AGE_DAYS = 90;

    private boolean isPasswordExpired(User user) {
        if (user.getPasswordChangedAt() == null) {
            user.setPasswordChangedAt(LocalDateTime.now());
            return false;
        }
        return user.getPasswordChangedAt().plusDays(PASSWORD_MAX_AGE_DAYS).isBefore(LocalDateTime.now());
    }

    // 로그인한 본인의 비밀번호를 바꾼다.
    //
    // 현재 비밀번호를 함께 받는 이유: 로그인한 화면을 잠깐 두고 자리를 비운 사이 남이
    // 비밀번호를 바꿔 계정을 가져가는 것을 막기 위함이다(보호조치 기준 제5조).
    //
    // 같은 비밀번호로 바꾸는 것도 막는다. 화면에는 "변경되었습니다"가 뜨는데 실제로는
    // 아무것도 안 바뀌면, 상담원은 바꾼 줄 알고 넘어간다 — 주기적 변경을 요구하는
    // 운영 규칙이 그 자리에서 무의미해진다.
    @Transactional
    public void changePassword(String email, ChangePasswordRequest request) {
        User user = userRepository.findByEmail(email)
                .orElseThrow(() -> new UnauthorizedException("로그인이 필요합니다."));

        if (request.currentPassword() == null || !matchesPassword(request.currentPassword(), user)) {
            throw new UnauthorizedException("현재 비밀번호가 올바르지 않습니다.");
        }
        if (request.newPassword() != null && matchesPassword(request.newPassword(), user)) {
            throw new ConflictException("지금 쓰고 있는 비밀번호와 같습니다. 다른 비밀번호를 입력해주세요.");
        }
        validatePasswordRule(request.newPassword(), email);

        user.setPasswordHash(passwordEncoder.encode(request.newPassword()));
        // 유효기간을 여기서부터 다시 센다. 이걸 안 찍으면 비밀번호를 바꿔도 계속
        // "바꿔야 한다"는 안내가 뜬다.
        user.setPasswordChangedAt(LocalDateTime.now());
    }

    // ── 비밀번호 작성규칙 ──
    //
    // "개인정보의 기술적·관리적 보호조치 기준" 제4조 ⑧항:
    //   1. 영문·숫자·특수문자 중 2종류 이상 조합 시 최소 10자리 이상,
    //      3종류 이상 조합 시 최소 8자리 이상
    //   2. 아이디와 비슷한 비밀번호는 사용하지 않을 것
    //
    // 회원가입 화면(auth.jsx validatePassword)에서도 같은 규칙을 안내하지만, 화면 검사만으로는
    // /api/auth/register를 직접 부르면 그냥 통과한다. 실제 차단은 여기가 담당한다.
    //
    // MasterAccountInitializer가 만드는 테스트 계정은 이 경로를 타지 않아 영향받지 않는다.
    private static final int MIN_LENGTH_TWO_KINDS = 10;
    private static final int MIN_LENGTH_THREE_KINDS = 8;

    private void validatePasswordRule(String password, String email) {
        if (password == null || password.isBlank()) {
            throw new BadRequestException("비밀번호를 입력해주세요.");
        }
        int kindCount = 0;
        if (password.matches(".*[A-Za-z].*")) kindCount++;
        if (password.matches(".*[0-9].*")) kindCount++;
        if (password.matches(".*[^A-Za-z0-9].*")) kindCount++;

        boolean longEnough = (kindCount >= 3 && password.length() >= MIN_LENGTH_THREE_KINDS)
                || (kindCount >= 2 && password.length() >= MIN_LENGTH_TWO_KINDS);
        if (!longEnough) {
            throw new BadRequestException(
                    "비밀번호는 영문·숫자·특수문자 중 2종류 이상 10자리, 또는 3종류를 모두 섞어 8자리 이상이어야 합니다.");
        }

        // 이메일 앞부분(아이디)을 그대로 넣은 비밀번호는 추측이 쉬워 규칙 2항에서 막는다.
        String localPart = email == null ? "" : email.split("@")[0].trim();
        if (localPart.length() >= 3 && password.toLowerCase().contains(localPart.toLowerCase())) {
            throw new BadRequestException("이메일 아이디가 그대로 들어간 비밀번호는 사용할 수 없습니다.");
        }
    }

    // 비밀번호는 저장된 BCrypt 해시로만 비교한다.
    //
    // 예전에는 이메일이 @test.test로 끝나면 평문 문자열 비교로 빠지는 분기가 있었다
    // (MasterAccountInitializer가 마스터 계정을 평문으로 저장했기 때문). 그건 두 가지가 문제였다 —
    // 보호조치 기준 제6조가 요구하는 일방향 암호화 저장이 아니고, 이메일 도메인만 맞추면
    // 어떤 계정이든 그 경로를 탈 수 있었다.
    //
    // 이제 마스터 계정도 BCrypt로 저장되고, 그전에 평문으로 들어간 행은 기동 시
    // MasterAccountInitializer.migrateLegacyPlainPassword가 같은 비밀번호 그대로 해시로 바꾼다.
    // 그래서 팀원 로컬 DB의 기존 마스터 계정도 쓰던 비밀번호로 그대로 로그인된다.
    private boolean matchesPassword(String rawPassword, User user) {
        return passwordEncoder.matches(rawPassword, user.getPasswordHash());
    }

    // 빈 문자열은 저장하지 않는다. 화면이 값을 안 받은 경우와 ''를 보낸 경우가 DB에서
    // 구분되지 않으면, 나중에 "소속이 비어 있는 계정"을 찾아 채우기가 어렵다.
    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    private AuthResponse toAuthResponse(User user, boolean passwordExpired) {
        return new AuthResponse(jwtService.generateToken(user), user.getId(), user.getName(),
                user.getRole(), user.getEmail(), passwordExpired);
    }
}
