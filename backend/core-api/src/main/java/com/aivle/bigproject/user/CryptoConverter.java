package com.aivle.bigproject.user;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

// User.name/email 컬럼용 결정론적(deterministic) AES-GCM 암호화 컨버터.
// email은 로그인 조회(findByEmail)와 UNIQUE 제약이 걸려있어서, 같은 평문이면
// 항상 같은 암호문이 나와야 조회/유니크 제약이 그대로 작동한다 — 그래서 IV를
// 매번 무작위로 뽑지 않고 HMAC-SHA256(key, 평문)에서 고정 유도한다.
// (컬럼이 이름/이메일 두 개뿐이고 값 자체도 이미 "이메일"이라는 게 알려져 있어서,
//  결정론적 암호화의 대표적 단점인 "같은 값 반복 노출"의 실질 위험은 낮다고 판단)
//
// PII_ENCRYPTION_KEY 환경변수로 키를 바꿀 것 — 아래 기본값은 개발용.
@Converter
public class CryptoConverter implements AttributeConverter<String, String> {

    private static final String DEV_DEFAULT_SECRET =
            "dev-only-pii-encryption-key-please-change-in-production";
    private static final byte[] KEY_BYTES = deriveKeyBytes(
            System.getenv().getOrDefault("PII_ENCRYPTION_KEY", DEV_DEFAULT_SECRET));
    private static final SecretKeySpec AES_KEY = new SecretKeySpec(KEY_BYTES, "AES");
    private static final SecretKeySpec HMAC_KEY = new SecretKeySpec(KEY_BYTES, "HmacSHA256");
    private static final int IV_LENGTH = 12; // AES-GCM 표준 IV 길이(byte)

    @Override
    public String convertToDatabaseColumn(String plainText) {
        if (plainText == null) {
            return null;
        }
        try {
            byte[] iv = deterministicIv(plainText);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, AES_KEY, new GCMParameterSpec(128, iv));
            byte[] cipherText = cipher.doFinal(plainText.getBytes(StandardCharsets.UTF_8));
            byte[] combined = new byte[iv.length + cipherText.length];
            System.arraycopy(iv, 0, combined, 0, iv.length);
            System.arraycopy(cipherText, 0, combined, iv.length, cipherText.length);
            return Base64.getEncoder().encodeToString(combined);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("개인정보 암호화 중 오류가 발생했습니다", e);
        }
    }

    @Override
    public String convertToEntityAttribute(String dbValue) {
        if (dbValue == null) {
            return null;
        }
        try {
            byte[] combined = Base64.getDecoder().decode(dbValue);
            byte[] iv = new byte[IV_LENGTH];
            System.arraycopy(combined, 0, iv, 0, IV_LENGTH);
            byte[] cipherText = new byte[combined.length - IV_LENGTH];
            System.arraycopy(combined, IV_LENGTH, cipherText, 0, cipherText.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, AES_KEY, new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(cipherText), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("개인정보 복호화 중 오류가 발생했습니다", e);
        }
    }

    private static byte[] deterministicIv(String plainText) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(HMAC_KEY);
            byte[] full = mac.doFinal(plainText.getBytes(StandardCharsets.UTF_8));
            byte[] iv = new byte[IV_LENGTH];
            System.arraycopy(full, 0, iv, 0, IV_LENGTH);
            return iv;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] deriveKeyBytes(String secret) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(secret.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    // 기존 평문 데이터를 암호화 마이그레이션할 때(1회성 스크립트) 재사용하는 정적 헬퍼
    public static String encryptStatic(String plainText) {
        return new CryptoConverter().convertToDatabaseColumn(plainText);
    }
}
