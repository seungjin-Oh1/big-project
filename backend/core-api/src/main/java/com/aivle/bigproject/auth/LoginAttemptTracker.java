package com.aivle.bigproject.auth;

import java.time.Duration;
import java.time.Instant;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

// 로그인 실패 횟수를 세어 일정 횟수를 넘으면 잠시 막는다.
//
// 이게 없으면 비밀번호를 무제한으로 넣어볼 수 있다. 비밀번호 작성규칙(AuthService
// validatePasswordRule)이 있어도 시도 횟수에 제한이 없으면 시간만 들이면 뚫린다.
//
// 존재하지 않는 이메일도 똑같이 센다. 없는 계정만 빨리 통과시키면 응답 차이로 어떤
// 이메일이 가입돼 있는지 알아낼 수 있다(AuthService가 두 경우에 같은 메시지를 주는 것과 같은 이유).
//
// 이메일 기준으로 막기 때문에, 남의 이메일을 알면 일부러 틀려서 그 사람을 잠글 수 있다.
// 5분이라는 짧은 잠금과 성공 시 즉시 해제로 피해를 줄였지만 완전히 없앨 수는 없다.
// IP를 함께 보는 방식이 더 낫고, 프록시 뒤에서 실제 IP를 얻는 설정이 필요해 지금은 뺐다.
//
// 저장은 메모리다. AudioStreamTicketService·CallRegistry와 같은 이유로 지금은 서버가 한 대라
// 충분하고, 재시작하면 잠금이 풀리지만 5분짜리라 잃을 게 크지 않다. 여러 대로 늘리면
// 공유 저장소가 필요하다.
@Component
public class LoginAttemptTracker {

    static final int MAX_FAILURES = 5;
    // 이 횟수부터는 캡차를 요구한다. 잠금(5회)보다 앞에 두어야 의미가 있다 —
    // 잠긴 뒤에 캡차를 물어봐야 이미 요청은 다 지나간 뒤다.
    static final int CAPTCHA_AFTER_FAILURES = 3;
    static final Duration LOCK_DURATION = Duration.ofMinutes(5);
    // 마지막 실패 후 이 시간이 지나면 횟수를 처음부터 다시 센다. 어제 두 번 틀린 것이
    // 오늘 시도에 얹히면 정상 사용자가 억울하게 잠긴다.
    static final Duration FAILURE_WINDOW = Duration.ofMinutes(30);

    private record Attempt(int failures, Instant lastFailedAt, Instant lockedUntil) {
        boolean isLocked(Instant now) {
            return lockedUntil != null && now.isBefore(lockedUntil);
        }

        boolean isStale(Instant now) {
            return !isLocked(now) && lastFailedAt.plus(FAILURE_WINDOW).isBefore(now);
        }
    }

    private final Map<String, Attempt> attempts = new ConcurrentHashMap<>();

    // 잠겨 있으면 남은 시간(초), 아니면 0.
    public long lockedSecondsRemaining(String email) {
        Attempt attempt = attempts.get(key(email));
        if (attempt == null) {
            return 0;
        }
        Instant now = Instant.now();
        if (!attempt.isLocked(now)) {
            return 0;
        }
        return Math.max(1, Duration.between(now, attempt.lockedUntil()).toSeconds());
    }

    // 이 이메일로 로그인하려면 캡차를 풀어야 하는지.
    //
    // 처음부터 요구하지 않는 이유: 정상 사용자에게는 매번 성가신 절차이고, 그러면
    // 화면이 캡차를 우회하는 쪽으로 바뀌기 쉽다. 몇 번 틀린 뒤부터 요구하면
    // 정상 사용자는 거의 만나지 않고 자동 시도만 걸린다.
    public boolean captchaRequired(String email) {
        Attempt attempt = attempts.get(key(email));
        if (attempt == null) {
            return false;
        }
        Instant now = Instant.now();
        if (attempt.isStale(now)) {
            return false;
        }
        return attempt.failures() >= CAPTCHA_AFTER_FAILURES;
    }

    public void recordFailure(String email) {
        Instant now = Instant.now();
        purgeStale(now);
        attempts.compute(key(email), (ignored, previous) -> {
            // 오래된 실패는 이어 세지 않는다.
            int failures = (previous == null || previous.isStale(now)) ? 1 : previous.failures() + 1;
            Instant lockedUntil = failures >= MAX_FAILURES ? now.plus(LOCK_DURATION) : null;
            return new Attempt(failures, now, lockedUntil);
        });
    }

    // 로그인에 성공하면 기록을 지운다 — 정상 사용자가 다음에 한두 번 틀렸다고 바로 잠기면 안 된다.
    public void recordSuccess(String email) {
        attempts.remove(key(email));
    }

    // 실패 기록은 아무도 지우지 않으면 계속 쌓인다(없는 이메일로 시도해도 쌓인다).
    // 실패가 생길 때마다 만료된 것을 걷어낸다.
    private void purgeStale(Instant now) {
        attempts.entrySet().removeIf(entry -> entry.getValue().isStale(now));
    }

    // 대소문자만 바꿔 시도하면 횟수가 따로 세지므로 소문자로 맞춰 센다.
    private static String key(String email) {
        return email == null ? "" : email.trim().toLowerCase(Locale.ROOT);
    }
}
