package com.aivle.bigproject.common;

import java.util.regex.Pattern;

// 상담 원문에서 주민등록번호를 걷어낸다.
//
// 왜 이것만 지우는가 —
// 개인정보 보호법 제24조의2는 주민등록번호를 '동의를 받아도' 법령에 구체적 근거가
// 있어야 처리할 수 있게 하고 있다. 이름·주소·전화(제15조, 동의로 처리 가능)와 지위가
// 다르다. 그래서 이 시스템은 주민등록번호를 아예 보관하지 않기로 했고, 서식에서도
// [직접 기재]로 남겨 상담원이 신분증과 대조해 직접 적는다.
//
// 그런데 상담 원문은 상담자가 말한 것이 그대로 들어오는 자리라, 그 정책이 여기서
// 뚫린다. 실측: 상담 55의 input_text에 "890412-2345678"이 평문으로 들어가 있었다.
// 대면 녹음은 stt-mask-api가 [PRIVATE_RRN]으로 가려 주지만 그건 마스킹본 이야기이고,
// 원문(call/inperson_input_texts, input_text)에는 그대로 남는다.
//
// 지우면 잃는 것이 없다. 구조화 분석은 주민등록번호를 뽑지 않고(ExtractedInfo에 필드
// 자체가 없다), 서식 초안도 채우지 않는다. ai-api가 분석 입력에 같은 처리를 이미
// 하고 있어(analysis/service.py의 scrub_resident_number) 규칙도 그쪽과 맞춘다.
//
// 이름·주소·전화는 지우지 않는다. 동의를 받아 저장하는 값이고, 서식의 당사자
// 주소·연락처칸을 채우려면 분석이 원문에서 뽑아내야 한다 — 지우면 뽑을 값이 없어져
// 상담원이 초안을 받아 손으로 다시 채워야 한다. 그쪽은 저장 암호화로 다룬다
// (TolerantCryptoConverter — 원문 컬럼은 DB에 암호문으로 들어간다).
public final class ResidentNumbers {

    // 구분자가 있는 형태만 지운다. 구분자 없는 13자리를 지우면 금액·사건번호가
    // 함께 사라진다(ai-api가 같은 이유로 같은 조건을 쓴다).
    private static final Pattern RRN = Pattern.compile("\\d{6}\\s*[-~]\\s*\\d{7}");

    public static final String PLACEHOLDER = "[주민등록번호]";

    private ResidentNumbers() {
    }

    public static String scrub(String text) {
        if (text == null || text.isBlank()) {
            return text;
        }
        return RRN.matcher(text).replaceAll(PLACEHOLDER);
    }
}
