package com.aivle.bigproject.consultation;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

// 이름을 모르는 상담을 그대로 받아들이는지. 스프링 컨텍스트도 DB도 쓰지 않는다.
//
// 이 자리에서 두 번 사고가 났다. 이름칸을 필수로 막아 두니 프론트가 검증을 통과시키려고
// 값을 지어냈고, 그게 DB를 거쳐 서식 초안의 이름칸까지 인쇄됐다.
//   1차: '이름 미입력'  → "청구인(상속인) 이름 미입력"이 서식에 찍힘
//   2차: '아무개'       → 출생신고서의 부·모 칸에 "아무개"가 찍힘
//
// 2차가 더 나빴다. '미입력'은 봐서 아는데 '아무개'는 한글 세 글자 사람 이름 모양이라
// ai-api의 가짜 이름 필터(drafter.py UNKNOWN_NAME_MARKS)에도 안 걸렸고, 상담원 눈에도
// 진짜 이름처럼 보인다. 빈칸이면 채워야 한다는 게 보이지만 지어낸 이름은 그냥 넘어간다.
//
// 그래서 "이름을 모르는 상담은 정상"을 여기서 못박는다. 통화 중 접수나 "상담 만들고
// 자료 저장"은 이름을 나중에 채우는 흐름이다.
class ConsultationClientNameTest {

    private Consultation withClientName(String clientName) {
        return new Consultation(null, "제목", clientName, null, null, null, null, null, null);
    }

    @Test
    @DisplayName("이름 없이 상담을 만들 수 있다 — null이 와도 기동이 깨지지 않는다")
    void acceptsMissingName() {
        // 컬럼이 nullable=false라 null을 그대로 두면 insert가 실패한다.
        assertThat(withClientName(null).getClientName()).isEmpty();
        assertThat(withClientName("").getClientName()).isEmpty();
        assertThat(withClientName("   ").getClientName()).isEmpty();
    }

    @Test
    @DisplayName("빈 이름을 다른 값으로 대신 채우지 않는다")
    void doesNotInventAName() {
        // 여기서 무언가를 채워 넣으면 그 값이 서식의 이름칸에 그대로 인쇄된다.
        // 화면 표시용 문구('이름 미입력')는 읽는 쪽에서 붙인다(App.jsx, common.jsx).
        assertThat(withClientName(null).getClientName())
                .isBlank()
                .doesNotContain("아무개", "미입력", "미상");
    }

    @Test
    @DisplayName("실제 이름은 앞뒤 공백만 정리해 그대로 보관한다")
    void keepsRealNameAsIs() {
        assertThat(withClientName("문가영").getClientName()).isEqualTo("문가영");
        assertThat(withClientName("  문가영  ").getClientName()).isEqualTo("문가영");
    }
}
