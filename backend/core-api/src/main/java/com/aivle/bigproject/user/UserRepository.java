package com.aivle.bigproject.user;

import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

// JpaRepository만 상속받으면 save/findById/findAll/delete 등이 기본 제공됨 (직접 구현 X)
public interface UserRepository extends JpaRepository<User, Long> {

    // 로그인 시 이메일로 계정을 찾기 위해 필요 (AuthService)
    Optional<User> findByEmail(String email);

    // 관리자 승인 대기 목록 조회용 (UserService.findPending)
    List<User> findByApprovalStatus(ApprovalStatus approvalStatus);

    // 관리자 대시보드 "활성 사용자" 집계용 (AdminStatsService)
    long countByApprovalStatus(ApprovalStatus approvalStatus);
}
