package com.aivle.bigproject.consultation;

import static org.assertj.core.api.Assertions.assertThat;

import com.aivle.bigproject.common.ResidentNumbers;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

// 상담 원문에 주민등록번호가 남지 않는지 고정한다.
//
// 개인정보 보호법 제24조의2는 주민등록번호를 '동의를 받아도' 법령 근거가 있어야
// 처리할 수 있게 하고 있어, 이 시스템은 아예 보관하지 않기로 했다. 그런데 상담 원문은
// 상담자가 말한 것이 그대로 들어오는 자리라 정책이 여기서 뚫렸다(실측: 상담 55의
// input_text에 890412-2345678이 평문으로 있었다).
//
// 저장 경로가 다섯 군데라 서비스에서 각각 처리하면 한 곳만 빠뜨려도 구멍이 난다.
// 엔티티가 유일한 관문이므로 여기서 확인한다.
class ConsultationResidentNumberTest {

    private static final String RRN = "890412-2345678";
    private static final String ADDRESS = "인천광역시 남동구 구월로 245 한빛아파트 101동 803호";
    private static final String PHONE = "010-4821-7395";

    private Consultation consultation() {
        return new Consultation(null, "실시간 상담", "정미래", null, "한도현",
                null, null, null, false);
    }

    @Test
    @DisplayName("생성자로 들어온 원문에서 주민등록번호를 지운다")
    void scrubsOnConstruction() {
        Consultation consultation = new Consultation(null, "실시간 상담", "정미래",
                "주민등록번호는 " + RRN + "입니다", "한도현", null, null, null, false);

        assertThat(consultation.getInputText()).doesNotContain(RRN);
        assertThat(consultation.getInputText()).contains(ResidentNumbers.PLACEHOLDER);
    }

    @Test
    @DisplayName("setInputText로 들어와도 지운다")
    void scrubsOnSetter() {
        Consultation consultation = consultation();
        consultation.setInputText("제 번호는 " + RRN + "이에요");

        assertThat(consultation.getInputText()).doesNotContain(RRN);
    }

    @Test
    @DisplayName("전화·대면 원문 이력에서도 지운다")
    void scrubsOnTranscriptHistory() {
        Consultation consultation = consultation();
        consultation.addCallInputText("전화로 불러준 " + RRN);
        consultation.addInpersonInputText("대면에서 말한 " + RRN);

        assertThat(consultation.getCallInputTexts().get(0)).doesNotContain(RRN);
        assertThat(consultation.getInpersonInputTexts().get(0)).doesNotContain(RRN);
    }

    @Test
    @DisplayName("주소·전화번호는 남긴다")
    void keepsAddressAndPhone() {
        // 동의를 받아 저장하는 값이고, 서식의 당사자 주소·연락처칸을 채우려면
        // 분석이 원문에서 뽑아내야 한다. 지우면 뽑을 값이 없어진다.
        Consultation consultation = consultation();
        consultation.setInputText("주소는 " + ADDRESS + "이고 연락처는 " + PHONE + "입니다");

        assertThat(consultation.getInputText()).contains(ADDRESS);
        assertThat(consultation.getInputText()).contains(PHONE);
    }

    @Test
    @DisplayName("금액·사건번호처럼 구분자 없는 숫자는 건드리지 않는다")
    void keepsPlainNumbers() {
        Consultation consultation = consultation();
        consultation.setInputText("미지급 양육비는 9800000원이고 사건번호는 2026느단1234입니다");

        assertThat(consultation.getInputText()).contains("9800000");
        assertThat(consultation.getInputText()).contains("2026느단1234");
    }

    @Test
    @DisplayName("구분자가 물결이거나 공백이 섞여도 지운다")
    void scrubsSpacedForms() {
        assertThat(ResidentNumbers.scrub("890412 - 2345678")).doesNotContain("2345678");
        assertThat(ResidentNumbers.scrub("890412~2345678")).doesNotContain("2345678");
    }

    @Test
    @DisplayName("한 문장에 여러 개가 있어도 모두 지운다")
    void scrubsEveryOccurrence() {
        String scrubbed = ResidentNumbers.scrub(
                "청구인 " + RRN + ", 상대방 750101-1234567");

        assertThat(scrubbed).doesNotContain(RRN);
        assertThat(scrubbed).doesNotContain("750101-1234567");
    }

    @Test
    @DisplayName("빈 값은 그대로 둔다")
    void keepsBlank() {
        assertThat(ResidentNumbers.scrub(null)).isNull();
        assertThat(ResidentNumbers.scrub("")).isEmpty();
    }
}
