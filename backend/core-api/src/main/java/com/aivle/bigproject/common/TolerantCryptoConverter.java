package com.aivle.bigproject.common;

import com.aivle.bigproject.user.CryptoConverter;
import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;
import java.util.ArrayList;
import java.util.List;

// 상담 원문용 암호화 컨버터. 키와 알고리즘은 CryptoConverter(AES-GCM)를 그대로 쓰고,
// 읽는 방식만 다르다 — 암호문으로 풀리지 않는 값은 예외를 던지지 않고 받은 그대로 돌려준다.
//
// 왜 관대하게 읽는가 —
// 이 컬럼들은 평문으로 먼저 쓰이다가 나중에 암호화로 바뀐 자리다. 팀원마다 로컬 DB에
// 평문 행이 남아 있고 각자 언제 켤지 알 수 없다. 엄격하게 읽으면 그 행을 여는 순간
// 상담 조회가 500으로 죽는다 — 개인정보를 지키려다 화면을 세우는 셈이다. 되돌리기
// 어려운 쪽(조회 불능)보다 되돌리기 쉬운 쪽(평문이 한 번 더 읽힘)을 택한다. 새로 쓰는
// 값은 예외 없이 암호화되고, 남은 평문은 ConsultationPiiEncryption이 부팅할 때 올린다.
//
// User.name/email이 쓰는 CryptoConverter는 엄격한 채로 둔다. 그쪽은 처음부터 암호문만
// 있어서 복호화 실패가 곧 키 설정 오류이고, 조용히 넘어가면 로그인이 이상하게 동작한다.
@Converter
public class TolerantCryptoConverter implements AttributeConverter<String, String> {

    private static final CryptoConverter DELEGATE = new CryptoConverter();

    @Override
    public String convertToDatabaseColumn(String plainText) {
        return encrypt(plainText);
    }

    @Override
    public String convertToEntityAttribute(String dbValue) {
        return decrypt(dbValue);
    }

    public static String encrypt(String plainText) {
        if (plainText == null || plainText.isEmpty()) {
            return plainText;
        }
        return DELEGATE.convertToDatabaseColumn(plainText);
    }

    /** 암호문이면 풀고, 아니면(암호화 전에 저장된 평문) 받은 값을 그대로 준다. */
    public static String decrypt(String stored) {
        if (stored == null || stored.isEmpty()) {
            return stored;
        }
        try {
            return DELEGATE.convertToEntityAttribute(stored);
        } catch (RuntimeException e) {
            // Base64가 아니거나 GCM 인증 태그가 안 맞는 값 = 예전 평문.
            // 태그 검증이 있어서 평문을 암호문으로 잘못 읽을 확률은 사실상 0이다.
            return stored;
        }
    }

    /** 이미 암호화된 값인지. 부팅 시 1회성 마이그레이션이 건너뛸 행을 고르는 데 쓴다. */
    public static boolean isEncrypted(String stored) {
        if (stored == null || stored.isEmpty()) {
            return false;
        }
        try {
            DELEGATE.convertToEntityAttribute(stored);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    public static List<String> encryptAll(List<String> values) {
        return mapAll(values, true);
    }

    public static List<String> decryptAll(List<String> values) {
        return mapAll(values, false);
    }

    private static List<String> mapAll(List<String> values, boolean encrypting) {
        if (values == null) {
            return null;
        }
        List<String> result = new ArrayList<>(values.size());
        for (String value : values) {
            result.add(encrypting ? encrypt(value) : decrypt(value));
        }
        return result;
    }
}
