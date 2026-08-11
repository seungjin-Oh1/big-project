package com.aivle.bigproject.user;

import com.aivle.bigproject.common.exception.NotFoundException;
import com.aivle.bigproject.user.dto.UserRequest;
import com.aivle.bigproject.user.dto.UserResponse;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

// 실제 업무 로직(생성/조회)이 들어가는 계층. Controller는 요청만 받고, 실제 처리는 여기서 함.
@Service
// 클래스 전체 기본값: 읽기 전용 트랜잭션. DB에 트랜잭션(세션)을 열어둬야
// 엔티티의 지연 로딩(LAZY) 필드를 문제없이 읽을 수 있음.
@Transactional(readOnly = true)
public class UserService {

    private final UserRepository userRepository;

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    // 쓰기 작업이라 readOnly=true를 오버라이드해서 진짜 쓰기 트랜잭션으로 실행
    @Transactional
    public UserResponse create(UserRequest request) {
        User saved = userRepository.save(new User(request.name(), request.role(), request.email()));
        return UserResponse.from(saved);
    }

    public List<UserResponse> findAll() {
        return userRepository.findAll().stream()
                .map(UserResponse::from)
                .toList();
    }

    // 관리자 승인 대기 화면용 — PENDING 상태인 계정만
    public List<UserResponse> findPending() {
        return userRepository.findByApprovalStatus(ApprovalStatus.PENDING).stream()
                .map(UserResponse::from)
                .toList();
    }

    // 컨트롤러가 호출하는 조회용 — 바로 응답 DTO로 변환해서 돌려줌
    public UserResponse get(Long id) {
        return UserResponse.from(findById(id));
    }

    // 로그인한 본인. 프론트는 상담을 만들 때 userId가 필요한데, 예전에는 그걸 알아내려고
    // 전체 목록(GET /api/users)을 받아 이메일로 찾았다. 그 목록이 관리자 전용이 되면서
    // 상담원·변호사는 상담을 아예 만들 수 없게 됐다.
    //
    // 애초에 남의 목록을 뒤질 일이 아니다. 토큰에 본인이 누구인지 들어 있으므로
    // 여기서 그 한 건만 돌려준다.
    public UserResponse getByEmail(String email) {
        return UserResponse.from(userRepository.findByEmail(email)
                .orElseThrow(() -> new NotFoundException("사용자를 찾을 수 없습니다: " + email)));
    }

    @Transactional
    public UserResponse approve(Long id) {
        User user = findById(id);
        user.setApprovalStatus(ApprovalStatus.APPROVED);
        return UserResponse.from(user);
    }

    @Transactional
    public UserResponse reject(Long id) {
        User user = findById(id);
        user.setApprovalStatus(ApprovalStatus.REJECTED);
        return UserResponse.from(user);
    }

    // 이건 DTO가 아니라 엔티티(User) 자체를 반환 — ConsultationService처럼
    // 다른 서비스가 "User가 실제로 존재하는지 확인하고 그 엔티티를 참조로 써야 할 때" 쓰는 내부용 메서드.
    // 반드시 트랜잭션이 열린 상태에서 호출해야 함 (세션 밖에서 쓰면 에러 남).
    public User findById(Long id) {
        return userRepository.findById(id)
                .orElseThrow(() -> new NotFoundException("사용자를 찾을 수 없습니다: " + id));
    }
}
