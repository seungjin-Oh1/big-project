package com.aivle.bigproject.auth;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.AffineTransform;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import javax.imageio.ImageIO;
import org.springframework.stereotype.Service;

// 로그인 캡차 ("개인정보의 기술적·관리적 보호조치 기준" 제4조 접근통제 — 캡챠 적용).
//
// 계정 잠금(LoginAttemptTracker)만으로는 부족한 부분을 메운다. 잠금은 한 계정을 여러 번
// 두드리는 것을 막지만, 아이디를 바꿔 가며 흔한 비밀번호 하나를 전 계정에 시도하는 방식
// (password spraying)은 계정별 실패 횟수가 쌓이지 않아 그대로 지나간다. 캡차는 요청 하나하나에
// 사람 손을 요구해서 그 속도를 떨어뜨린다.
//
// 만드는 방식: JDK에 들어 있는 것만 쓴다(java.awt + ImageIO). 외부 캡차 서비스를 붙이면
// 키 관리가 생기고, 무엇보다 로그인 화면이 외부 도메인에 의존하게 된다 — 그 도메인이 죽으면
// 아무도 로그인할 수 없다. 폐쇄망 배포도 어려워진다.
//
// 한계를 분명히 해 둔다: 글자를 비틀고 잡선을 긋는 정도라 전용 OCR을 막지는 못한다.
// 목적은 "사람이 아닌 것을 완전히 차단"이 아니라 "자동 대량 시도를 비싸게 만들기"다.
@Service
public class CaptchaService {

    // 발급 후 이 시간이 지나면 못 쓴다. 짧으면 천천히 입력하는 사람이 막히고,
    // 길면 미리 받아 둔 답을 재사용할 여지가 커진다.
    private static final Duration TTL = Duration.ofMinutes(5);

    // 사람이 헷갈리는 글자는 뺀다 — 0/O, 1/I/l. 틀려서 다시 푸는 일이 잦으면
    // 캡차가 보안이 아니라 사용성 문제로만 남는다.
    private static final String ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    private static final int LENGTH = 5;
    private static final int WIDTH = 160;
    private static final int HEIGHT = 56;

    private final SecureRandom random = new SecureRandom();
    private final Map<String, Issued> issued = new ConcurrentHashMap<>();

    public record Issued(String answer, Instant expiresAt) {}

    public record Challenge(String captchaId, String imageBase64) {}

    public Challenge issue() {
        purgeExpired();
        String answer = randomAnswer();
        String captchaId = UUID.randomUUID().toString();
        issued.put(captchaId, new Issued(answer, Instant.now().plus(TTL)));
        return new Challenge(captchaId, "data:image/png;base64," + Base64.getEncoder().encodeToString(render(answer)));
    }

    // 한 번 쓰면 없앤다. 남겨 두면 같은 답으로 여러 번 시도할 수 있어 캡차를 두는 의미가 없다.
    // 틀린 경우에도 없앤다 — 정답을 맞힐 때까지 같은 그림으로 반복해서 찍어볼 수 없게 한다.
    public boolean verify(String captchaId, String answer) {
        purgeExpired();
        if (captchaId == null || answer == null) {
            return false;
        }
        Issued entry = issued.remove(captchaId);
        if (entry == null || Instant.now().isAfter(entry.expiresAt())) {
            return false;
        }
        return entry.answer().equalsIgnoreCase(answer.trim());
    }

    private String randomAnswer() {
        StringBuilder sb = new StringBuilder(LENGTH);
        for (int i = 0; i < LENGTH; i++) {
            sb.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
        }
        return sb.toString();
    }

    private byte[] render(String text) {
        BufferedImage image = new BufferedImage(WIDTH, HEIGHT, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setColor(Color.WHITE);
            g.fillRect(0, 0, WIDTH, HEIGHT);

            // 글자마다 조금씩 기울이고 위아래로 흔든다. 일정한 위치에 곧게 찍으면
            // 잘라서 글자별로 대조하는 것만으로 쉽게 읽힌다.
            int x = 14;
            for (char c : text.toCharArray()) {
                AffineTransform saved = g.getTransform();
                double angle = (random.nextDouble() - 0.5) * 0.6;
                int y = 38 + random.nextInt(9) - 4;
                g.rotate(angle, x, y);
                g.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 30 + random.nextInt(6)));
                g.setColor(new Color(random.nextInt(110), random.nextInt(110), random.nextInt(110)));
                g.drawString(String.valueOf(c), x, y);
                g.setTransform(saved);
                x += 27;
            }

            // 잡선. 글자와 배경의 경계를 흐려 윤곽 추출을 방해한다.
            g.setStroke(new BasicStroke(1.5f));
            for (int i = 0; i < 6; i++) {
                g.setColor(new Color(random.nextInt(180) + 60, random.nextInt(180) + 60, random.nextInt(180) + 60));
                g.drawLine(random.nextInt(WIDTH), random.nextInt(HEIGHT), random.nextInt(WIDTH), random.nextInt(HEIGHT));
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ImageIO.write(image, "png", out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new UncheckedIOException("캡차 이미지를 만들지 못했습니다", e);
        } finally {
            g.dispose();
        }
    }

    // 만료된 것을 그때그때 걷어낸다. 별도 스케줄러를 두지 않는 이유는 캡차가 5분짜리라
    // 발급·검증이 일어날 때마다 정리해도 충분히 작게 유지되기 때문이다.
    private void purgeExpired() {
        Instant now = Instant.now();
        issued.entrySet().removeIf(entry -> now.isAfter(entry.getValue().expiresAt()));
    }

    Optional<String> peekAnswerForTest(String captchaId) {
        return Optional.ofNullable(issued.get(captchaId)).map(Issued::answer);
    }
}
