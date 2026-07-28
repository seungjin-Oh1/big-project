package com.aivle.bigproject.consultation;

import com.aivle.bigproject.consultation.dto.ConsultationRequest;
import com.aivle.bigproject.consultation.dto.ConsultationResponse;
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

    // DELETE /api/consultations/{id} — 삭제 (첨부파일과 실제 파일도 같이 삭제됨)
    @DeleteMapping("/api/consultations/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        consultationService.delete(id);
    }
}
