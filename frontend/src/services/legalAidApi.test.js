import assert from 'node:assert/strict';
import test from 'node:test';

import { recommendTemplates } from './legalAidApi.js';

test('상속 대분류만 있어도 상속 서식을 추천한다', () => {
  const templates = recommendTemplates('상속');

  assert.ok(templates.length > 0);
  assert.ok(templates.every((template) => template.caseCategory === '상속'));
});

test('상속재산분할 소분류는 정확히 해당 서식만 추천한다', () => {
  const templates = recommendTemplates('상속재산분할');

  assert.ok(templates.length > 0);
  assert.ok(templates.every((template) => template.caseType === '상속재산분할'));
});
