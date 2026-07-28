package com.aivle.bigproject.consultation;

import com.aivle.bigproject.attachment.Attachment;
import com.aivle.bigproject.user.CryptoConverter;
import com.aivle.bigproject.user.User;
import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.EntityListeners;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OneToMany;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

// 상담 1건. ERD 기준 Main Table.
@Entity
@Getter
@Setter
@NoArgsConstructor
@EntityListeners(AuditingEntityListener.class)
public class Consultation {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    // 이 상담을 담당하는 상담원. 다대일(N:1) — 여러 상담이 같은 User를 가리킬 수 있음.
    // nullable=false라서 반드시 존재하는 User를 연결해야 저장 가능 (ConsultationService에서 검증함).
    @ManyToOne
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @Column(nullable = false)
    private String title;

    // 내담자(의뢰인) 본인 이름 — User.name/email과 같은 이유로 암호화(CryptoConverter).
    // opponentName(상대방)과 헷갈리지 않도록 이름을 명확히 구분함.
    @Convert(converter = CryptoConverter.class)
    @Column(name = "client_name", nullable = false, length = 500)
    private String clientName;

    // 상담 본문(텍스트로 직접 입력했거나, STT로 변환된 내용). 녹음파일만 있는 경우 null 가능.
    // 주의: 여기에 @Lob을 붙이면 안 됨 — Postgres text 컬럼에 @Lob(String)을 쓰면 Hibernate/pgjdbc가
    // 실제 텍스트 대신 Large Object OID 참조 숫자를 저장해버리는 알려진 문제가 있음(JPA 세션 안에서는
    // 우연히 정상 조회되어 눈치채기 어렵지만, DB를 직접 SELECT하면 숫자만 보임). Postgres text는 길이
    // 제한이 없어서 애초에 @Lob이 필요 없음.
    // @Lob은 쓰지 않는다 — AiAnalysis.summary 주석 참고.
    @Column(name = "input_text", columnDefinition = "TEXT")
    private String inputText;

    // 상대방 이름 — 유사 사건 집단화(clustering)에 참고용으로 쓰일 필드 (ERD 주석 기준)
    @Column(name = "opponent_name")
    private String opponentName;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private ConsultationStatus status = ConsultationStatus.RECEIVED;

    // 사건 대분류/소분류 (등록 화면 ChoicePicker 선택값). 분류 체계가 아직 팀 협의 중이라
    // AiAnalysis.caseType과 마찬가지로 enum이 아닌 자유 문자열로 둠.
    @Column(name = "category")
    private String category;

    @Column(name = "type")
    private String type;

    // 법률구조 대상자 유형 (예: basicLivelihood, nearPoverty, none 등 — frontend legalAidApplicantTypes 참고)
    @Column(name = "legal_aid_type")
    private String legalAidType;

    @Column(name = "eligibility_evidence_submitted")
    private Boolean eligibilityEvidenceSubmitted = false;

    // 이 상담에 딸린 첨부파일 목록. 1:N 관계.
    // cascade=ALL: Consultation을 저장/삭제하면 Attachment도 같이 저장/삭제됨
    // orphanRemoval=true: 이 리스트에서 Attachment를 빼면 DB에서도 자동 삭제됨
    // 기본적으로 LAZY 로딩이라, 트랜잭션이 열려있을 때만 접근 가능 (Service 계층 안에서 다뤄야 함)
    @OneToMany(mappedBy = "consultation", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<Attachment> attachments = new ArrayList<>();

    @CreatedDate
    @Column(nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @LastModifiedDate
    @Column(nullable = false)
    private LocalDateTime updatedAt;

    // 생성 시 필요한 필드만 받는 생성자
    public Consultation(User user, String title, String clientName, String inputText, String opponentName,
                         String category, String type, String legalAidType, Boolean eligibilityEvidenceSubmitted) {
        this.user = user;
        this.title = title;
        this.clientName = clientName;
        this.inputText = inputText;
        this.opponentName = opponentName;
        this.category = category;
        this.type = type;
        this.legalAidType = legalAidType;
        this.eligibilityEvidenceSubmitted = eligibilityEvidenceSubmitted != null && eligibilityEvidenceSubmitted;
    }
}
