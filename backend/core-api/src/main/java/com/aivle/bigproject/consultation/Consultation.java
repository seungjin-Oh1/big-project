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
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
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
    //
    // TODO(규제): 평문으로 저장되고 있음 — 암호화 필요.
    //   상담 진술이라 주민번호·주소·가족관계가 그대로 들어간다. 정작 clientName은 암호화하면서
    //   더 민감한 이쪽이 빠져 있어 기준이 뒤집혀 있다.
    //   @Convert(converter = CryptoConverter.class) 한 줄이면 되지만, 이미 저장된 평문 행은
    //   복호화가 깨진다. 팀원 각자의 로컬 DB를 함께 초기화해야 하므로 합의 후 적용할 것.
    @Column(name = "input_text", columnDefinition = "TEXT")
    private String inputText;

    // "상담 저장" 버튼을 누를 때마다의 채널별 input_text 스냅샷 보관용(감사/이력 목적). 매 저장마다
    // 하나씩 쌓이기만 하고 지우지 않음 — ConsultationService.saveTranscript() 참고. "분석 내용
    // 저장"(AiAnalysisService)은 ai_analysis 테이블만 건드리고 여기는 건드리지 않는다.
    // 전화상담(call_*)과 대면상담(inperson_*)을 분리한 이유: 두 채널의 실시간 상담 메모/STT 결과가
    // 화면에서 섞여 보이면 안 된다는 요구에 맞춰, 저장되는 이력도 채널별로 나눈다.
    // 이전에 있던 단일 input_texts/input_texts_masked 컬럼을 대체한다(더 이상 관리 안 함 — DB에
    // 남아 있어도 ddl-auto: update는 안 쓰는 컬럼을 지우지 않으므로 그냥 방치됨).
    //
    // DB엔 이미 행이 있던(NULL) 상태로 컬럼이 추가될 수 있어 getter에서 항상 non-null을 보장하지
    // 않는다. null-safe 추가는 addCallInputText() 등 아래 헬퍼로만 한다.
    @JdbcTypeCode(SqlTypes.ARRAY)
    @Column(name = "call_input_texts", columnDefinition = "text[]")
    private List<String> callInputTexts = new ArrayList<>();

    @JdbcTypeCode(SqlTypes.ARRAY)
    @Column(name = "call_input_texts_masked", columnDefinition = "text[]")
    private List<String> callInputTextsMasked = new ArrayList<>();

    @JdbcTypeCode(SqlTypes.ARRAY)
    @Column(name = "inperson_input_texts", columnDefinition = "text[]")
    private List<String> inpersonInputTexts = new ArrayList<>();

    // 마스킹은 지금 대면 상담(mic-stt-mask) 세션에서만 실제로 일어난다 — 전화상담은 아직 자동 STT가
    // 없어 call_input_texts_masked는 사실상 계속 비어 있을 수 있다.
    @JdbcTypeCode(SqlTypes.ARRAY)
    @Column(name = "inperson_input_texts_masked", columnDefinition = "text[]")
    private List<String> inpersonInputTextsMasked = new ArrayList<>();

    public void addCallInputText(String value) {
        addTo(() -> this.callInputTexts, list -> this.callInputTexts = list, value);
    }

    public void addCallInputTextMasked(String value) {
        addAllowingBlank(() -> this.callInputTextsMasked, list -> this.callInputTextsMasked = list, value);
    }

    public void addInpersonInputText(String value) {
        addTo(() -> this.inpersonInputTexts, list -> this.inpersonInputTexts = list, value);
    }

    public void addInpersonInputTextMasked(String value) {
        addAllowingBlank(() -> this.inpersonInputTextsMasked, list -> this.inpersonInputTextsMasked = list, value);
    }

    private void addTo(java.util.function.Supplier<List<String>> getter,
                        java.util.function.Consumer<List<String>> setter, String value) {
        if (value == null || value.isBlank()) {
            return;
        }
        addAllowingBlank(getter, setter, value);
    }

    // 마스킹본은 비어 있어도 자리를 채운다.
    //
    // 원문과 마스킹본은 같은 인덱스끼리 짝이다. 그런데 빈 값을 건너뛰면 마스킹에
    // 실패한 회차만큼 마스킹본 배열이 짧아져, 이후 인덱스가 통째로 밀린다. 화면이
    // 쓰는 latestSnapshot은 각 배열의 마지막을 집으므로, 그때부터 '지금 메모'와
    // '엉뚱한 회차의 마스킹본'을 나란히 보여주게 된다(실측: 원문 3건 / 마스킹본 1건).
    // 가려졌다고 적힌 자리에 다른 회차 내용이 뜨는 것이라 그냥 비는 것보다 나쁘다.
    private void addAllowingBlank(java.util.function.Supplier<List<String>> getter,
                                   java.util.function.Consumer<List<String>> setter, String value) {
        if (value == null) {
            return;
        }
        List<String> list = getter.get();
        if (list == null) {
            list = new ArrayList<>();
            setter.accept(list);
        }
        list.add(value);
    }

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

    // ── 서식 작성용 개인정보 ──
    //
    // 법원 서식에서 당사자 주소는 송달을 위한 법정 필수 기재사항이라, 이게 없으면
    // 초안이 성립하지 않는다. 그래서 '상담'에는 필요 없지만 '서식 작성'에는 필수다 —
    // 목적이 다르므로 동의도 그 목적에 대해 따로 받는다(privacyConsent).
    //
    // clientName과 같은 이유로 암호화한다(CryptoConverter). 길이 500은 암호문 기준이다.
    //
    // 주민등록번호는 여기에 두지 않는다. 개인정보 보호법 제24조의2는 주민등록번호를
    // 동의가 아니라 '법령에 구체적 근거가 있을 때'만 처리하도록 하고 있어서, 동의를
    // 받아도 저장할 수 없다. 최종 서류에는 상담원이 신분증과 대조해 직접 적는다.
    @Convert(converter = CryptoConverter.class)
    @Column(name = "client_address", length = 500)
    private String clientAddress;

    @Convert(converter = CryptoConverter.class)
    @Column(name = "client_phone", length = 500)
    private String clientPhone;

    // 위 두 값을 받아도 되는지. 개인정보 보호법 시행령 제17조 제1항 제2호는 '전화로
    // 동의 내용을 알리고 동의 의사표시를 확인하는 방법'을 인정한다 — 상담원이 대신
    // 동의하는 것이 아니라, 내담자에게 받은 동의를 기록하는 자리다.
    //
    // 동의 대화 자체는 상담 녹취(call_input_texts / inperson_input_texts)에 함께 남아
    // 증거가 된다. 그런데 녹취만 있으면 "이 사람이 동의했나"를 확인하려고 텍스트 전체를
    // 사람이 읽어야 한다 — 표현이 제각각("네", "그러세요")이라 자동으로 못 찾는다.
    // 찾을 수 있게 하려고 필드로 따로 남긴다.
    @Column(name = "privacy_consent")
    private Boolean privacyConsent = false;

    @Column(name = "privacy_consent_at")
    private LocalDateTime privacyConsentAt;

    // 어느 채널에서 받은 동의인지(call / inperson). 시행령이 인정하는 방법이 채널마다
    // 달라서, 나중에 입증할 때 "무엇으로 받았는지"가 남아 있어야 한다.
    @Column(name = "privacy_consent_source")
    private String privacyConsentSource;

    /** 동의를 기록한다. 동의를 내리는 경우(잘못 체크했을 때)는 시각·채널을 함께 지운다.
     *
     *  @return 이번 호출이 '동의했다가 철회한 것'이면 true.
     *
     *  철회를 따로 알려주는 이유: 이 엔티티의 주소·전화번호만 지워서는 부족하기 때문이다.
     *  분석 단계가 같은 값을 ai_analysis.extracted_json에도 뽑아 두는데, 그건 서식 작성을
     *  위해 동의를 받고 만든 사본이라 동의가 사라지면 함께 지워야 한다. 그 정리는 다른
     *  테이블을 건드리는 일이라 엔티티가 못 하고, ConsultationService가 이 신호를 받아서
     *  한다(scrubDraftContactFromAnalyses).
     *
     *  '지금 동의가 false'와 '동의를 철회했다'를 구분해야 한다. 화면은 상담을 저장할 때마다
     *  동의 필드를 함께 보내므로, false를 그냥 철회로 보면 아직 동의를 받기 전 단계의 상담을
     *  저장할 때마다 사본이 지워진다 — 동의 화면이 미리 채워 줄 값이 그때 사라진다. */
    public boolean applyPrivacyConsent(Boolean consented, String source) {
        boolean agreed = Boolean.TRUE.equals(consented);
        boolean revoked = Boolean.TRUE.equals(this.privacyConsent) && !agreed;
        this.privacyConsent = agreed;
        this.privacyConsentAt = agreed ? LocalDateTime.now() : null;
        this.privacyConsentSource = agreed ? source : null;
        return revoked;
    }

    /** 동의가 없으면 주소·전화번호를 저장하지 않는다. 화면에서도 막지만, 이 API를 직접
     *  부르면 그 검사를 지나칠 수 있어 여기서도 본다(register()의 privacyAgreed와 같은 취지). */
    public void applyDraftContactInfo(String address, String phone) {
        if (!Boolean.TRUE.equals(this.privacyConsent)) {
            this.clientAddress = null;
            this.clientPhone = null;
            return;
        }
        if (address != null) {
            this.clientAddress = address.isBlank() ? null : address.trim();
        }
        if (phone != null) {
            this.clientPhone = phone.isBlank() ? null : phone.trim();
        }
    }

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
