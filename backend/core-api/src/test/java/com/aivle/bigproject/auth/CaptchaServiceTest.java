package com.aivle.bigproject.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Base64;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

// 캡차 ("개인정보의 기술적·관리적 보호조치 기준" 제4조 접근통제 — 캡챠 적용).
//
// 여기서 지키려는 것은 "그림이 예쁘게 나오는가"가 아니라 다음 세 가지다.
//   1. 답을 응답에 실어 보내지 않는가 (실으면 캡차가 아니다)
//   2. 한 번 쓴 캡차를 다시 쓸 수 없는가 (재사용되면 자동 시도를 못 막는다)
//   3. 틀린 답으로 같은 문제를 반복해서 찍어볼 수 없는가
class CaptchaServiceTest {

    private final CaptchaService captchaService = new CaptchaService();

    @Test
    @DisplayName("발급하면 PNG 그림이 나오고, 응답에는 답이 들어 있지 않다")
    void issuesPngWithoutLeakingAnswer() {
        CaptchaService.Challenge challenge = captchaService.issue();

        assertThat(challenge.captchaId()).isNotBlank();
        assertThat(challenge.imageBase64()).startsWith("data:image/png;base64,");

        byte[] png = Base64.getDecoder().decode(challenge.imageBase64().split(",", 2)[1]);
        // PNG 시그니처
        assertThat(png).startsWith(new byte[] {(byte) 0x89, 'P', 'N', 'G'});

        // 답이 응답 어디에도 평문으로 섞여 있으면 안 된다.
        String answer = captchaService.peekAnswerForTest(challenge.captchaId()).orElseThrow();
        assertThat(challenge.captchaId()).doesNotContain(answer);
        assertThat(challenge.imageBase64()).doesNotContain(answer);
    }

    @Test
    @DisplayName("정답이면 통과하고, 대소문자는 가리지 않는다")
    void acceptsCorrectAnswerIgnoringCase() {
        CaptchaService.Challenge challenge = captchaService.issue();
        String answer = captchaService.peekAnswerForTest(challenge.captchaId()).orElseThrow();

        assertThat(captchaService.verify(challenge.captchaId(), answer.toLowerCase())).isTrue();
    }

    @Test
    @DisplayName("한 번 맞히면 그 캡차는 없어진다 — 같은 답으로 두 번 통과할 수 없다")
    void correctAnswerIsSingleUse() {
        CaptchaService.Challenge challenge = captchaService.issue();
        String answer = captchaService.peekAnswerForTest(challenge.captchaId()).orElseThrow();

        assertThat(captchaService.verify(challenge.captchaId(), answer)).isTrue();
        assertThat(captchaService.verify(challenge.captchaId(), answer)).isFalse();
    }

    @Test
    @DisplayName("틀려도 그 캡차는 없어진다 — 같은 그림에 답을 반복해서 찍어볼 수 없다")
    void wrongAnswerAlsoConsumesChallenge() {
        CaptchaService.Challenge challenge = captchaService.issue();
        String answer = captchaService.peekAnswerForTest(challenge.captchaId()).orElseThrow();

        assertThat(captchaService.verify(challenge.captchaId(), "틀린답")).isFalse();
        // 방금 틀렸으니 정답을 넣어도 이 캡차는 이미 폐기됐다.
        assertThat(captchaService.verify(challenge.captchaId(), answer)).isFalse();
    }

    @Test
    @DisplayName("없는 캡차나 빈 값은 통과하지 않는다")
    void rejectsUnknownOrEmpty() {
        assertThat(captchaService.verify("존재하지-않는-id", "ABCDE")).isFalse();
        assertThat(captchaService.verify(null, "ABCDE")).isFalse();

        CaptchaService.Challenge challenge = captchaService.issue();
        assertThat(captchaService.verify(challenge.captchaId(), null)).isFalse();
    }

    @Test
    @DisplayName("사람이 헷갈리는 글자(0/O, 1/I)는 쓰지 않는다")
    void avoidsAmbiguousCharacters() {
        // 대문자 L은 뺄 필요가 없다. 헷갈리는 짝은 소문자 l과 숫자 1인데, 이 캡차는
        // 대문자만 그리고 1은 이미 빠져 있다. 읽을 수 있는 글자를 괜히 줄이면
        // 같은 길이에서 경우의 수만 작아진다.
        //
        // 한 번은 우연히 안 나올 수 있으므로 여러 번 뽑아 본다.
        for (int i = 0; i < 50; i++) {
            CaptchaService.Challenge challenge = captchaService.issue();
            String answer = captchaService.peekAnswerForTest(challenge.captchaId()).orElseThrow();
            assertThat(answer).doesNotContainAnyWhitespaces();
            assertThat(answer.chars()).noneMatch(c -> c == '0' || c == 'O' || c == '1' || c == 'I');
        }
    }
}
