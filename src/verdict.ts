// 라이너 Decisions가 돌려준 확률을 화면에 보일 판정으로 바꾸는 순수 함수들.
// 확신이 낮으면 단정하지 않고 "판단 보류"를 보여주는 것이 원칙입니다.

export type ClaimVerdict = 'danger' | 'warn' | 'ok' | 'hold';
export type Grade = 'A' | 'B' | 'C' | 'D' | 'hold' | 'none';

export const CLAIM_TYPES = {
  disease: '질병의 예방·치료·완화를 주장 (건강기능식품 광고에서 금지)',
  drug: '의약품(비만치료제 등)인 것처럼 표현',
  overclaim: '인정된 기능성보다 효과를 부풀리거나 단정함',
  unapproved: '인정되지 않은 다른 효과를 주장',
  ok: '인정된 기능성 범위 안의 표현',
} as const;

/** exceeds: "인정 범위를 넘는가" 확률, pSevere: 질병·의약품 표현일 확률 합, pOk: 문제없음 확률 */
export function claimVerdict(exceeds: number, pSevere: number, pOk: number): ClaimVerdict {
  // 질병 치료·의약품 오인 표현은 그 자체로 금지라 확률이 높으면 바로 위험
  if (pSevere >= 0.6) return 'danger';
  // 0.35~0.65는 사람이 직접 판단하도록 보류
  if (exceeds > 0.35 && exceeds < 0.65) return 'hold';
  if (exceeds >= 0.65) return pSevere >= 0.3 ? 'danger' : 'warn';
  // 넘지 않는다는데 성격 판정은 문제 쪽이면 두 질문이 어긋난 것 → 보류
  return pOk >= 0.4 ? 'ok' : 'hold';
}

export const EVIDENCE_LEVELS = [
  '근거 없음 또는 효과가 없다는 결과',
  '약함: 동물·세포 연구나 소규모 연구 위주',
  '중간: 사람 대상 임상시험이 일부 있음',
  '강함: 메타분석이나 여러 임상시험이 일치',
];

export function evidenceGrade(score: number, confidence: number, paperCount: number): Grade {
  if (paperCount === 0) return 'none';
  if (confidence < 0.4) return 'hold';
  const i = Math.max(0, Math.min(3, Math.round(score)));
  return (['D', 'C', 'B', 'A'] as const)[i];
}

/** 논문 제목·초록이 그 원료를 다루는지. 원료 영문명의 4글자 이상 단어 중 하나라도 (복수형 s는 무시) 들어 있으면 참 */
export function mentionsIngredient(text: string, nameEn: string): boolean {
  const hay = text.toLowerCase();
  const words = nameEn.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !['extract', 'acid', 'leaf', 'root', 'powder', 'seed'].includes(w));
  if (!words.length) return hay.includes(nameEn.toLowerCase().trim());
  return words.some((w) => hay.includes(w.replace(/s$/, '')));
}
