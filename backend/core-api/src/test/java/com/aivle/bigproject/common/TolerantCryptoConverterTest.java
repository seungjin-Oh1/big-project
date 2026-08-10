package com.aivle.bigproject.common;

import static org.assertj.core.api.Assertions.assertThat;

import com.aivle.bigproject.consultation.Consultation;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

@DisplayName("상담 원문 저장 암호화")
class TolerantCryptoConverterTest {

    private static final String PLAIN = "주소는 인천광역시 남동구 구월로 245이고 연락처는 010-2345-6789입니다";

    @Test
    @DisplayName("암호화하면 원문이 남지 않고, 풀면 그대로 돌아온다")
    void 왕복() {
        String stored = TolerantCryptoConverter.encrypt(PLAIN);

        assertThat(stored).isNotEqualTo(PLAIN);
        assertThat(stored).doesNotContain("인천광역시", "010-2345-6789");
        assertThat(TolerantCryptoConverter.decrypt(stored)).isEqualTo(PLAIN);
    }

    @Test
    @DisplayName("암호화 이전에 저장된 평문은 그대로 읽힌다")
    void 평문_호환() {
        // 이게 안 되면 팀원 로컬 DB의 기존 행을 여는 순간 상담 조회가 죽는다.
        assertThat(TolerantCryptoConverter.decrypt(PLAIN)).isEqualTo(PLAIN);
        assertThat(TolerantCryptoConverter.isEncrypted(PLAIN)).isFalse();
    }

    @Test
    @DisplayName("우연히 Base64처럼 생긴 평문도 평문으로 읽는다")
    void base64처럼_생긴_평문() {
        // GCM 인증 태그가 안 맞으면 복호화가 실패한다 — 그 실패를 평문 신호로 쓴다.
        for (String value : List.of("abcd", "TestValue1234", "aGVsbG8gd29ybGQ=")) {
            assertThat(TolerantCryptoConverter.decrypt(value)).isEqualTo(value);
            assertThat(TolerantCryptoConverter.isEncrypted(value)).isFalse();
        }
    }

    @Test
    @DisplayName("이미 암호문인 값은 암호문으로 알아본다 — 두 번 암호화하지 않으려고")
    void 암호문_판별() {
        assertThat(TolerantCryptoConverter.isEncrypted(TolerantCryptoConverter.encrypt(PLAIN))).isTrue();
    }

    @Test
    @DisplayName("null과 빈 문자열은 건드리지 않는다")
    void 빈값() {
        assertThat(TolerantCryptoConverter.encrypt(null)).isNull();
        assertThat(TolerantCryptoConverter.decrypt(null)).isNull();
        assertThat(TolerantCryptoConverter.encrypt("")).isEmpty();
        assertThat(TolerantCryptoConverter.isEncrypted(null)).isFalse();
    }

    @Test
    @DisplayName("채널별 원문 배열은 원소마다 암호화되고, getter가 풀어서 준다")
    void 배열_왕복() {
        Consultation consultation = new Consultation();
        consultation.addInpersonInputText(PLAIN);

        // getter는 평문을 준다 — 화면·분석·마스킹이 쓰는 값이 그대로 유지되어야 한다.
        assertThat(consultation.getInpersonInputTexts()).containsExactly(PLAIN);

        // 저장되는 값(필드)은 암호문이다. getter가 아니라 저장 형태를 확인해야 의미가 있다.
        String stored = storedInpersonText(consultation);
        assertThat(stored).doesNotContain("인천광역시");
        assertThat(TolerantCryptoConverter.decrypt(stored)).isEqualTo(PLAIN);
    }

    @Test
    @DisplayName("주민등록번호는 암호화가 아니라 지운다 — 풀어도 나오지 않는다")
    void 주민번호는_암호화하지_않고_지운다() {
        Consultation consultation = new Consultation();
        consultation.addInpersonInputText("제 주민등록번호는 890412-2345678입니다");

        assertThat(consultation.getInpersonInputTexts().get(0))
                .doesNotContain("890412-2345678")
                .contains(ResidentNumbers.PLACEHOLDER);
    }

    @SuppressWarnings("unchecked")
    private static String storedInpersonText(Consultation consultation) {
        try {
            var field = Consultation.class.getDeclaredField("inpersonInputTexts");
            field.setAccessible(true);
            return ((List<String>) field.get(consultation)).get(0);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }
}
