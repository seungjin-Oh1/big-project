package com.aivle.bigproject.consultation;

import com.aivle.bigproject.consultation.dto.ConsultationRequest;
import com.aivle.bigproject.consultation.dto.ConsultationResponse;
import com.aivle.bigproject.consultation.dto.TranscriptSaveRequest;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ConsultationController {

    private final ConsultationService consultationService;

    public ConsultationController(ConsultationService consultationService) {
        this.consultationService = consultationService;
    }

    // POST /api/consultations — 상담 생성
    @PostMapping("/api/consultations")
    @ResponseStatus(HttpStatus.CREATED)
    public ConsultationResponse create(@Valid @RequestBody ConsultationRequest request) {
        return consultationService.create(request);
    }

    // GET /api/consultations — 전체 목록
    @GetMapping("/api/consultations")
    public List<ConsultationResponse> findAll() {
        return consultationService.findAll();
    }

    // GET /api/consultations/{id} — 단건 조회
    @GetMapping("/api/consultations/{id}")
    public ConsultationResponse findById(@PathVariable Long id) {
        return consultationService.get(id);
    }

    // PUT /api/consultations/{id} — 부분 수정 (body에 넣은 필드만 바뀜)
    @PutMapping("/api/consultations/{id}")
    public ConsultationResponse update(@PathVariable Long id, @RequestBody ConsultationRequest request) {
        return consultationService.update(id, request);
    }

    // POST /api/consultations/{id}/transcript — "상담 저장" 버튼 전용. 채널별 실시간 상담 메모를
    // Consultation.input_text / call_input_texts / inperson_input_texts(_masked)에 반영한다.
    @PostMapping("/api/consultations/{id}/transcript")
    public ConsultationResponse saveTranscript(@PathVariable Long id, @RequestBody TranscriptSaveRequest request) {
        return consultationService.saveTranscript(id, request);
    }

    // GET /api/consultations/{id}/masked-transcript — 개인정보를 가린 상담 내용
    //
    // 저장된 가림본을 읽는 게 아니라 이 자리에서 가려서 돌려준다. DB에는 원본 한 벌만
    // 두기 때문이다(TranscriptSaveRequest 주석 참고). 화면의 '개인정보 가림 결과' 카드가
    // 열릴 때만 부르므로 매번 가리는 비용이 문제되지 않는다.
    @GetMapping("/api/consultations/{id}/masked-transcript")
    public MaskedTranscriptResponse maskedTranscript(@PathVariable Long id) {
        return new MaskedTranscriptResponse(consultationService.maskedTranscript(id));
    }

    public record MaskedTranscriptResponse(String maskedText) {
    }

    // DELETE /api/consultations/{id} — 삭제 (첨부파일과 실제 파일도 같이 삭제됨)
    @DeleteMapping("/api/consultations/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        consultationService.delete(id);
    }
}
