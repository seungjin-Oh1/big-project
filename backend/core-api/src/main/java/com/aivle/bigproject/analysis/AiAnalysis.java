package com.aivle.bigproject.analysis;

import com.aivle.bigproject.consultation.Consultation;
import com.aivle.bigproject.user.User;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EntityListeners;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import java.time.LocalDateTime;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

// AI 분석 결과 저장. contracts/ai_analysis_mock.json 계약서 필드명과 1:1로 맞춤.
// 상담 하나가 여러 번 재분석될 수 있다고 보고 N:1(여러 AiAnalysis - 상담 하나)로 설계함.
@Entity
@Table(name = "ai_analysis")
@Getter
@Setter
@NoArgsConstructor
@EntityListeners(AuditingEntityListener.class)
public class AiAnalysis {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id; // API 응답에서는 계약서 필드명대로 analysis_id로 나감 (AiAnalysisResponse 참고)

    @ManyToOne
    @JoinColumn(name = "consultation_id", nullable = false)
    private Consultation consultation;

    // @Lob을 붙이면 PostgreSQL에서 값이 pg_largeobject에 따로 저장되고 컬럼엔 OID만 남아
    // DB를 직접 조회할 때 내용이 안 보이고 행 삭제 시 실제 데이터가 누수된다.
    // PostgreSQL TEXT는 원래 길이 제한이 없으므로 @Lob 없이 columnDefinition만으로 충분.
    @Column(columnDefinition = "TEXT")
    private String summary;

    // ── 화면 기본 표시용 두 컬럼 ──
    // summary는 개요 형식의 '원재료'다 — 서식 초안 작성과 구조대상 판단이 이걸 읽는다.
    // 그런데 상담원·변호사는 목록에서 개요조차 길다고 느껴서, 화면에는 한 문장과 키워드를
    // 먼저 보여주고 전체 요약은 펼쳐서 보게 한다. summary를 줄여 대체하면 서식을 채울
    // 재료가 사라지므로, 지우지 않고 위에 얹는다.
    @Column(name = "summary_headline", columnDefinition = "TEXT")
    private String summaryHeadline;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "summary_keywords_json", columnDefinition = "jsonb")
    private String summaryKeywordsJson;

    @Column(name = "case_type")
    private String caseType;

    // case_type 세부유형. 계약서 v0.1엔 없었는데 추가 결정된 필드.
    @Column(name = "case_subtype")
    private String caseSubtype;

    // "상/중/하" 같은 값 표기가 아직 팀 회의로 미확정이라, enum으로 못박지 않고 자유 문자열로 둠
    @Column(name = "urgency_level")
    private String urgencyLevel;

    // 긴급도 점수 0.0~1.0. 계약서 v0.1엔 등급만 있는데 ai-api 그래프는 점수도 같이 낸다
    // (case_emergency_ratio). 화면이 게이지로 이 값을 쓴다.
    // 예전엔 extracted_json에 실려 왔는데, 그 필드는 계약서 정의대로 서식 자동채움 재료
    // (당사자·금액·날짜)를 담아야 해서 자리를 옮겼다.
    // 등급과 마찬가지로 후보값이다 — 확정은 상담원·변호사가 한다.
    @Column(name = "urgency_score")
    private Double urgencyScore;

    private String eligibility;

    // 아래 6개는 계약서 README 기준 전부 JSONB 컬럼("사건마다 구조가 달라서 컬럼을 안 쪼갠다").
    // Java 필드 타입은 String이지만, @JdbcTypeCode(SqlTypes.JSON) 덕분에 Hibernate가
    // 이 String을 "이미 완성된 JSON 텍스트"로 취급해서 jsonb 컬럼에 그대로 저장/조회함
    // (문자열을 다시 따옴표로 감싸는 이중 인코딩이 일어나지 않음).
    // 실제 요청/응답에서는 이 String을 Jackson JsonNode로 변환해서 진짜 JSON 형태로 주고받음
    // (변환 로직은 AiAnalysisService에 있음).
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "extracted_json", columnDefinition = "jsonb")
    private String extractedJson;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "missing_info_json", columnDefinition = "jsonb")
    private String missingInfoJson;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "checklist_json", columnDefinition = "jsonb")
    private String checklistJson;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "recommendation_json", columnDefinition = "jsonb")
    private String recommendationJson;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "timeline_json", columnDefinition = "jsonb")
    private String timelineJson;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "cluster_result_json", columnDefinition = "jsonb")
    private String clusterResultJson;

    // 계약서 README 기준: "통계 확보 전까지는 null". 형식(숫자? "2주" 같은 문자열?)이 미정이라
    // 우선 자유 문자열로 둠.
    @Column(name = "estimated_time")
    private String estimatedTime;

    // ai-api /consult/analyze 호출 시 실제로 보낸 raw_input을 그대로 보관 (추적용).
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "raw_input_json", columnDefinition = "jsonb")
    private String rawInputJson;
    // 상담원 확인/수정 -> 검토요청 -> 승인/반려 흐름. AnalysisReviewStatus 참고.
    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private AnalysisReviewStatus status;

    // 검토한 사용자(변호사 등) — 검토 전엔 null
    @ManyToOne
    @JoinColumn(name = "reviewer_id")
    private User reviewer;

    // 승인 코멘트 또는 반려 사유
    @Column(name = "review_note", columnDefinition = "TEXT")
    private String reviewNote;

    private LocalDateTime reviewedAt;

    // 계약서엔 updated_at이 없고 created_at(분석일)만 있어서 그대로 맞춤
    @CreatedDate
    @Column(nullable = false, updatable = false)
    private LocalDateTime createdAt;

    public AiAnalysis(Consultation consultation, String summary, String caseType, String caseSubtype,
                       String urgencyLevel, String eligibility, String extractedJson, String missingInfoJson,
                       String checklistJson, String recommendationJson, String timelineJson,
                       String clusterResultJson, String estimatedTime, String rawInputJson) {
        this.consultation = consultation;
        this.summary = summary;
        this.caseType = caseType;
        this.caseSubtype = caseSubtype;
        this.urgencyLevel = urgencyLevel;
        this.eligibility = eligibility;
        this.extractedJson = extractedJson;
        this.missingInfoJson = missingInfoJson;
        this.checklistJson = checklistJson;
        this.recommendationJson = recommendationJson;
        this.timelineJson = timelineJson;
        this.clusterResultJson = clusterResultJson;
        this.estimatedTime = estimatedTime;
        this.rawInputJson = rawInputJson;
        this.status = AnalysisReviewStatus.DRAFTED;
    }
}
