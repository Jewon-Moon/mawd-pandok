import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimVerdict, evidenceGrade, mentionsIngredient } from './verdict.ts';

test('claimVerdict', () => {
  assert.equal(claimVerdict(0.96, 0.11, 0), 'warn');
  assert.equal(claimVerdict(0.94, 0.45, 0.05), 'danger');
  assert.equal(claimVerdict(0.1, 0, 0.9), 'ok');
  assert.equal(claimVerdict(0.5, 0, 0.5), 'hold'); // 애매한 확률
  assert.equal(claimVerdict(0.6, 0.7, 0.1), 'danger'); // 의약품 오인은 범위 판정과 상관없이 위험
  assert.equal(claimVerdict(0.1, 0.2, 0.1), 'hold'); // 두 질문이 서로 어긋남
});

test('evidenceGrade', () => {
  assert.equal(evidenceGrade(2.9, 0.9, 5), 'A');
  assert.equal(evidenceGrade(0.2, 0.9, 5), 'D');
  assert.equal(evidenceGrade(1.6, 0.9, 5), 'B');
  assert.equal(evidenceGrade(3, 0.2, 5), 'hold');
  assert.equal(evidenceGrade(3, 0.9, 0), 'none');
});

test('mentionsIngredient', () => {
  assert.equal(mentionsIngredient('Vitamin D supplementation and body weight status', 'Garcinia'), false);
  assert.equal(mentionsIngredient('Garcinia cambogia extract for weight loss', 'Garcinia cambogia extract'), true);
  assert.equal(mentionsIngredient('Effects of probiotic yogurt on constipation', 'Probiotics'), true);
  assert.equal(mentionsIngredient('Banaba leaf and corosolic acid in glucose control', 'Banaba leaf extract'), true);
  assert.equal(mentionsIngredient('Green tea catechins', 'Banaba leaf extract'), false); // leaf·extract만으로는 맞지 않음
});

test('createRateLimiter', async () => {
  const { createRateLimiter } = await import('./limit.ts');
  const allow = createRateLimiter(2, 1000);
  assert.equal(allow('a', 0), true);
  assert.equal(allow('a', 10), true);
  assert.equal(allow('a', 20), false); // 1초 안에 3번째
  assert.equal(allow('b', 20), true); // 다른 IP는 따로
  assert.equal(allow('a', 1001), true); // 첫 기록이 1초 지나면 다시 허용
});
