package com.aivle.bigproject.security;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

// 개발용 기본 시크릿을 그대로 둔 채 배포되는 것을 기동 시점에 막는다.
//
// application.yaml의 시크릿에는 전부 기본값이 들어 있다. 8명이 각자 로컬에서 바로 띄울 수
// 있게 하려는 의도이고 그건 그대로 두는 게 맞지만, 그 값들이 레포에 적혀 있다는 게 문제다 —
// 코드를 본 사람이면 누구나 JWT를 위조하고(app.jwt.secret) 상담 원문을 복호화할 수 있다
// (PII_ENCRYPTION_KEY). 배포하고 나서 "환경변수 넣는 걸 잊었다"를 알아차릴 방법이 없었다.
//
// 그래서 프로파일로 가른다:
//   local(기본값)  기본 시크릿을 허용하고 경고만 남긴다 — 지금까지와 똑같이 동작한다
//   그 외          기본 시크릿이 하나라도 남아 있으면 기동을 거부한다
//
// application.yaml이 spring.profiles.active를 ${SPRING_PROFILES_ACTIVE:local}로 잡아두므로,
// 팀원이 ./gradlew bootRun을 하던 방식은 바뀌지 않는다. 배포에서 SPRING_PROFILES_ACTIVE를
// 다른 값으로 주는 순간 이 검사가 켜진다.
//
// 기동을 거부하는 쪽을 택한 이유: 경고만 남기면 로그에 묻힌다. 시크릿이 기본값인 채로
// 뜬 서버는 "일단 동작은 하는" 상태라 아무도 이상을 못 느끼고, 그게 가장 위험하다.
@Component
public class DevSecretGuard implements InitializingBean {

    private static final Logger log = LoggerFactory.getLogger(DevSecretGuard.class);

    // 이 프로파일에서만 기본 시크릿을 허용한다.
    private static final Set<String> DEV_PROFILES = Set.of("local", "test");

    // CryptoConverter는 Spring 프로퍼티가 아니라 환경변수를 직접 읽으므로 기본값을 여기 다시 적는다.
    // (CryptoConverter.DEV_DEFAULT_SECRET과 같은 값이어야 한다 — 한쪽만 바꾸면 검사가 헛돈다)
    private static final String PII_KEY_ENV = "PII_ENCRYPTION_KEY";
    private static final String PII_DEV_DEFAULT = "dev-only-pii-encryption-key-please-change-in-production";

    private final Environment environment;
    private final String jwtSecret;
    private final String audioExternalApiKey;
    private final String datasourcePassword;
    private final String talkerPassword;
    private final String lawyerPassword;
    private final String adminPassword;

    public DevSecretGuard(Environment environment,
                           @Value("${app.jwt.secret}") String jwtSecret,
                           @Value("${app.audio.external-api-key}") String audioExternalApiKey,
                           @Value("${spring.datasource.password}") String datasourcePassword,
                           @Value("${app.master-account.talker.password}") String talkerPassword,
                           @Value("${app.master-account.lawyer.password}") String lawyerPassword,
                           @Value("${app.master-account.admin.password}") String adminPassword) {
        this.environment = environment;
        this.jwtSecret = jwtSecret;
        this.audioExternalApiKey = audioExternalApiKey;
        this.datasourcePassword = datasourcePassword;
        this.talkerPassword = talkerPassword;
        this.lawyerPassword = lawyerPassword;
        this.adminPassword = adminPassword;
    }

    @Override
    public void afterPropertiesSet() {
        rejectLegacyPiiMigrationOutsideDev();

        List<String> unchanged = findUnchangedSecrets();
        if (unchanged.isEmpty()) {
            return;
        }

        if (isDevProfile()) {
            log.warn("개발용 기본 시크릿을 사용 중입니다 ({}). 배포 환경에서는 환경변수로 교체해야 합니다.",
                    String.join(", ", unchanged));
            return;
        }

        throw new IllegalStateException(
                "개발용 기본 시크릿이 남아 있어 기동을 중단합니다: %s. 각 항목을 환경변수로 교체하거나, 로컬 개발이라면 SPRING_PROFILES_ACTIVE=local로 실행하세요."
                        .formatted(String.join(", ", unchanged)));
    }

    // 평문 시절 데이터를 암호문으로 올리는 부팅 마이그레이션(ConsultationPiiEncryption)이
    // 켜진 채로 운영에 올라가는 것을 막는다.
    //
    // 그 마이그레이션은 "이미 암호문인 값"을 '지금 키로 복호화되는가'로 판단한다. 그래서
    // PII_ENCRYPTION_KEY를 잘못 넣으면 기존 암호문이 평문으로 분류되어 새 키로 한 번 더
    // 암호화되고, 원본은 복구할 수 없다. 상담 원문과 상대방 이름이 통째로 날아간다.
    //
    // 옛 로컬 DB를 올릴 때만 필요한 기능이라 새로 만든 운영 DB에서는 얻을 것이 없다.
    // 얻을 것이 없고 잃을 것만 있는 스위치는 그 환경에서 아예 못 켜게 한다.
    private void rejectLegacyPiiMigrationOutsideDev() {
        boolean enabled = environment.getProperty(
                "app.pii.encrypt-legacy-on-startup", Boolean.class, false);
        if (enabled && !isDevProfile()) {
            throw new IllegalStateException(
                    "app.pii.encrypt-legacy-on-startup은 로컬 전용입니다. 운영에서 켜면 "
                    + "PII_ENCRYPTION_KEY가 다를 때 기존 암호문을 이중 암호화해 복구할 수 없습니다. "
                    + "끄고 다시 실행하세요.");
        }
    }

    private boolean isDevProfile() {
        String[] active = environment.getActiveProfiles();
        // 프로파일이 아예 없으면 application.yaml의 기본값(local)이 적용되지 않은 것이므로
        // 안전한 쪽(운영으로 간주)으로 판단한다.
        if (active.length == 0) {
            return false;
        }
        for (String profile : active) {
            if (!DEV_PROFILES.contains(profile)) {
                return false;
            }
        }
        return true;
    }

    // 바뀌지 않은 항목의 "이름"만 모은다 — 값은 절대 로그나 예외 메시지에 담지 않는다.
    private List<String> findUnchangedSecrets() {
        List<String> unchanged = new ArrayList<>();
        addIfEquals(unchanged, "JWT_SECRET", jwtSecret,
                "dev-only-secret-key-please-change-in-production-32bytes-min");
        addIfEquals(unchanged, PII_KEY_ENV, System.getenv().getOrDefault(PII_KEY_ENV, PII_DEV_DEFAULT),
                PII_DEV_DEFAULT);
        addIfEquals(unchanged, "AUDIO_EXTERNAL_API_KEY", audioExternalApiKey,
                "dev-only-external-audio-key-change-me");
        addIfEquals(unchanged, "DB_PASSWORD", datasourcePassword, "postgres");
        addIfEquals(unchanged, "MASTER_TALKER_PASSWORD", talkerPassword, "test1234");
        addIfEquals(unchanged, "MASTER_LAWYER_PASSWORD", lawyerPassword, "test1234");
        addIfEquals(unchanged, "MASTER_ADMIN_PASSWORD", adminPassword, "test1234");
        return unchanged;
    }

    private void addIfEquals(List<String> target, String name, String actual, String devDefault) {
        if (devDefault.equals(actual)) {
            target.add(name);
        }
    }
}
