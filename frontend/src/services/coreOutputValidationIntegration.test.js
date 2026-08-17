import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCoreAnalysisResponse } from './coreApiClientV2.js';

test('정규화 뒤 형식과 원문 근거가 모두 충족되면 내부 스키마 오류를 통과로 회복한다', () => {
  const result = mapCoreAnalysisResponse({
    summary: '2026년 5월 15일 부친 사망 후 상속재산과 채무를 확인 중입니다.',
    case_type: '상속',
    urgency_level: '높음',
    eligibility: '판단보류',
    raw_input_json: {
      memo: '내담자: 2026년 5월 15일 아버지가 돌아가셨습니다. 6월 10일 채권자가 8천만 원 채무를 주장했습니다.',
    },
    missing_info_json: [],
    checklist_json: [],
    timeline_json: [{ 날짜: '2026년 5월 15일', 내용: '아버지가 돌아가셨습니다.' }],
    extracted_json: {
      사건개요: '2026년 5월 15일 부친 사망 후 상속과 채무를 확인하는 사건입니다.',
      output_validation: {
        status: 'available',
        decision: 'high_risk',
        validation: { valid: false, schema_errors: ['$.timeline_json: invalid'] },
        review_reasons: ['JSON Schema validation failed'],
      },
    },
  });

  assert.equal(result.verification.formatLabel, '통과');
  assert.equal(result.verification.evidenceLabel, '근거 확인');
  assert.equal(result.verification.riskLabel, '낮음');
});

test('서버 검증이 unavailable이어도 원문 대조가 통과하면 화면 형식을 통과로 표시한다', () => {
  const result = mapCoreAnalysisResponse({
    summary: '아버지가 돌아가신 뒤 상속과 채무를 확인하고 있습니다.',
    case_type: '상속',
    urgency_level: '높음',
    eligibility: '판단보류',
    raw_input_json: {
      memo: '내담자: 아버지가 돌아가신 뒤 상속과 채무를 확인하고 있습니다.',
    },
    timeline_json: [{ 날짜: '2026년 5월 15일', 내용: '아버지가 돌아가셨습니다.' }],
    extracted_json: {
      사건개요: '아버지가 돌아가신 뒤 상속과 채무를 확인하는 사건입니다.',
      output_validation: { status: 'unavailable', reason: 'no_legal_sources' },
    },
  });

  assert.equal(result.verification.formatLabel, '통과');
  assert.equal(result.verification.evidenceLabel, '근거 확인');
  assert.equal(result.verification.riskLabel, '낮음');
});

test('모델의 고위험 근거가 있으면 높은 위험을 유지한다', () => {
  const result = mapCoreAnalysisResponse({
    extracted_json: {
      output_validation: {
        status: 'available',
        decision: 'high_risk',
        validation: { valid: false, schema_errors: ['$.timeline_json: invalid'] },
        review_reasons: ['JSON Schema validation failed', 'hallucination probability exceeded high-risk threshold'],
      },
    },
  });

  assert.equal(result.verification.riskLabel, '높음');
});
