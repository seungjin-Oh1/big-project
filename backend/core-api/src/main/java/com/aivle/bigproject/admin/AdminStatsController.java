package com.aivle.bigproject.admin;

import com.aivle.bigproject.admin.dto.AdminStatsResponse;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AdminStatsController {

    private final AdminStatsService adminStatsService;

    public AdminStatsController(AdminStatsService adminStatsService) {
        this.adminStatsService = adminStatsService;
    }

    // GET /api/admin/stats — 관리자 대시보드 상단 요약 카드 + 통계용 (ADMIN 전용, SecurityConfig)
    @GetMapping("/api/admin/stats")
    public AdminStatsResponse getStats() {
        return adminStatsService.getStats();
    }
}
