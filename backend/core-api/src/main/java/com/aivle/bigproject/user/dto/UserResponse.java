package com.aivle.bigproject.user.dto;

import com.aivle.bigproject.user.ApprovalStatus;
import com.aivle.bigproject.user.User;
import com.aivle.bigproject.user.UserRole;
import java.time.LocalDateTime;

// API 응답으로 내려줄 형태. passwordHash는 절대 포함하지 않음 (민감정보라 응답에서 제외).
public record UserResponse(
        Long id,
        String name,
        UserRole role,
        String email,
        // 관리자 화면(활성 사용자·승인 대기)이 소속을 보고 승인 여부를 판단한다.
        // 예전에는 이 셋이 없어서 화면이 '-'만 그렸다(User 엔티티 주석 참고).
        String organization,
        String branch,
        String phone,
        ApprovalStatus approvalStatus,
        LocalDateTime createdAt,
        LocalDateTime updatedAt
) {
    // 엔티티(User) → 응답 DTO로 변환하는 정적 팩토리 메서드
    public static UserResponse from(User user) {
        return new UserResponse(
                user.getId(),
                user.getName(),
                user.getRole(),
                user.getEmail(),
                user.getOrganization(),
                user.getBranch(),
                user.getPhone(),
                user.getApprovalStatus(),
                user.getCreatedAt(),
                user.getUpdatedAt()
        );
    }
}
