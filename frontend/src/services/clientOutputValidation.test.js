import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClientOutputValidation } from './clientOutputValidation.js';

function completeAnalysis(overrides = {}) {
  return {
    summary: '아버지 사망 후 상속재산과 채무를 정리해야 합니다.',
    case_type: '상속', urgency_level: '중', eligibility: '확인필요',
    extracted_json: { 사건개요: '아버지 사망 후 상속재산과 채무 정리가 필요합니다.' },
    missing_info_json: [], checklist_json: {},
    timeline_json: [{ 날짜: '5월 15일', 내용: '아버지 사망' }],
    raw_input_json: { content: { details: '아버지가 5월 15일 사망했고 상속재산과 채무를 정리하려고 상담했습니다.' } },
    ...overrides,
  };
}

test('서버 검증이 unavailable이면 세 표시를 실행 결과로 채운다', () => {
  const result = buildClientOutputValidation(completeAnalysis(), { status: 'unavailable', reason: 'no_legal_sources' });
  assert.equal(result.available, true);
  assert.equal(result.formatLabel, '통과');
  assert.equal(result.evidenceLabel, '근거 확인');
  assert.equal(result.riskLabel, '낮음');
});

test('원문이 없으면 실행 결과를 보수적으로 검토 필요로 표시한다', () => {
  const result = buildClientOutputValidation(completeAnalysis({ raw_input_json: null }));
  assert.equal(result.evidenceLabel, '근거 보강 필요');
  assert.equal(result.riskLabel, '검토 필요');
});

test('필수 형식 누락은 환각과 분리해 검토 필요로 표시한다', () => {
  const result = buildClientOutputValidation(completeAnalysis({ summary: '' }));
  assert.equal(result.formatLabel, '확인 필요');
  assert.equal(result.riskLabel, '검토 필요');
});
