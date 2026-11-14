// 광고 한 건을 판독하는 흐름. 단계마다 emit으로 결과를 바로 내보내 화면이 차례로 채워집니다.
//  1 추출(Router)  →  2 병렬: 제품 등록 확인(식약처 C003) · 인정 기능성 검색(Web) · 논문 검색(Scholar) · 전문가 추천 판정(Decisions)
//  →  3 문구별 판정(Decisions)  ·  성분별 근거 등급(Decisions)

import { costMeter, decide, routerJson, searchScholar, searchWeb, type Cost, type SearchResult } from './liner.ts';
import { lookupProduct } from './foodsafety.ts';
import { CLAIM_TYPES, EVIDENCE_LEVELS, claimVerdict, evidenceGrade, mentionsIngredient } from './verdict.ts';

export type Emit = (event: string, data: unknown) => void;
export type CheckInput = { text: string; productName?: string; imageDataUrl?: string };

type Extracted = {
  productName: string;
  ingredients: { ko: string; en: string; effectEn: string }[];
  claims: string[];
};

const EXTRACT_SYSTEM = `너는 한국 건강기능식품·식품 광고를 분석한다. 광고 텍스트(또는 이미지)에서 다음을 뽑아라.
- productName: 제품명. 없으면 빈 문자열.
- ingredients: 효과를 내세우는 핵심 원료 최대 3개. ko=광고에 쓰인 한국어 원료명, en=영문 원료명, effectEn=그 원료의 대표 효과 하나를 영어 2~4단어로 (예: "macular pigment density", "body fat reduction", "bowel movement").
- claims: 효과·효능을 주장하는 문구 최대 6개. 광고 표현을 그대로 짧게 옮긴다. 가격·배송·이벤트 문구는 제외.`;

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['productName', 'ingredients', 'claims'],
  properties: {
    productName: { type: 'string' },
    ingredients: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['ko', 'en', 'effectEn'], properties: { ko: { type: 'string' }, en: { type: 'string' }, effectEn: { type: 'string' } } },
    },
    claims: { type: 'array', items: { type: 'string' } },
  },
};

const isOfficial = (r: SearchResult) => /foodsafetykorea\.go\.kr|mfds\.go\.kr|hfood\.or\.kr/.test(r.hostname || r.url);
// 안전 소식은 출처가 확인되는 언론·기관 자료만 (SNS·블로그·영상 제외)
const SOCIAL = /instagram|facebook|youtube|tiktok|blog\.|tistory|cafe\.naver|x\.com|twitter/;
const short =(s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

export const NOT_SUPPLEMENT = '(건강기능식품 신고 내역 없음: 일반식품이며 인정된 기능성이 없음)';

/** 광고 문구 하나를 인정 기능성과 대조. 평가 스크립트(eval/)도 같은 함수를 씀 */
export async function judgeClaim(claim: string, approvedText: string, cost: Cost) {
  const a = await decide({
    ad_claim: claim,
    approved_functionality: approvedText || '(식약처 인정 기능성 자료를 찾지 못함)',
  }, {
    exceeds: {
      type: 'noul',
      instructions: '광고 문구가 식약처가 인정한 기능성 범위를 넘어서는 주장을 하는가? 일반식품이면 어떤 건강 효능·기능성 주장도 범위를 넘는다. 인정 기능성 자료가 없으면, 일반 식품이 낼 수 없는 효능을 주장하는지로 판단한다.',
      criteria: { true: '인정 기능성에 없는 효과, 질병의 예방·치료, 효과를 단정하거나 부풀린 표현이 있다', false: '인정 기능성 범위 안에서 "도움을 줄 수 있음" 수준으로 표현하거나, 효능 주장이 아니다' },
    },
    type: { type: 'choice', instructions: '이 광고 문구의 성격은?', criteria: CLAIM_TYPES },
  }, cost);
  const exceeds = a.exceeds?.noul ?? 0.5;
  const type = a.type?.choice ?? 'ok';
  const probs: Record<string, number> = a.type?.probabilities ?? {};
  return {
    claim, exceeds, type, probabilities: probs,
    typeLabel: CLAIM_TYPES[type as keyof typeof CLAIM_TYPES] ?? type,
    verdict: claimVerdict(exceeds, (probs.disease ?? 0) + (probs.drug ?? 0), probs.ok ?? 0),
  };
}

export async function runCheck(input: CheckInput, emit: Emit): Promise<void> {
  const started = Date.now();
  const cost = costMeter();

  emit('stage', { step: 'extract', label: '광고에서 제품·원료·주장 문구를 찾는 중' });
  const ex = await routerJson<Extracted>(EXTRACT_SYSTEM, `광고 내용:\n${input.text || '(이미지 참고)'}`, EXTRACT_SCHEMA, cost, input.imageDataUrl);
  const productName = input.productName?.trim() || ex.productName.trim();
  const ingredients = ex.ingredients.slice(0, 3);
  const claims = ex.claims.slice(0, 6);
  emit('extracted', { productName, ingredients, claims });
  if (!claims.length) {
    emit('done', { costUsd: cost.total(), ms: Date.now() - started, note: '효과를 주장하는 문구를 찾지 못했어요.' });
    return;
  }

  emit('stage', { step: 'lookup', label: '식약처 신고 정보와 논문을 찾는 중' });

  const registrationP = productName
    ? lookupProduct(productName).then((r) => { emit('registration', { productName, ...r }); return r; })
    : Promise.resolve(null).then(() => { emit('registration', { productName: '', status: 'unknown', keyType: 'none', products: [] }); return null; });

  const approvedP = Promise.all(ingredients.map(async (ing) => {
    const results = await searchWeb(`${ing.ko} 기능성 내용 식품안전나라 건강기능식품`, cost, { max: 8 });
    // 기능성 문구가 실제로 들어 있는 식약처 자료를 앞으로
    const official = results.filter(isOfficial).sort((a, b) => Number(/기능성/.test(b.description)) - Number(/기능성/.test(a.description))).slice(0, 3);
    const items = (official.length ? official : results.slice(0, 2)).map((r) => ({ title: r.title, url: r.url, text: r.description, date: r.date, official: isOfficial(r) }));
    emit('approved', { ingredient: ing.ko, items });
    return { ingredient: ing.ko, items };
  }));

  // 최근 1년 안의 회수·이상사례·주의사항 변경. 고정 DB로는 따라갈 수 없는 부분이라 실시간 검색을 씀
  const safetyP = Promise.all(ingredients.map(async (ing) => {
    const results = await searchWeb(`${ing.ko} 이상사례 회수 섭취 주의사항 식약처`, cost, { max: 6, dateRange: 'past_year' });
    const items = results
      .filter((r) => (r.description.includes(ing.ko) || r.title.includes(ing.ko)) && !SOCIAL.test(r.hostname))
      .slice(0, 3)
      .map((r) => ({ title: r.title, url: r.url, text: r.description, date: r.date, official: isOfficial(r) || /korea\.kr/.test(r.hostname) }));
    emit('safety', { ingredient: ing.ko, items });
  }));

  const papersP = Promise.all(ingredients.map(async (ing) => {
    // 검색이 다른 성분 논문을 섞어 줄 때가 있어, 원료 이름이 제목·초록에 있는 논문만 씀. 없으면 단순한 검색어로 한 번 더
    const about = (list: SearchResult[]) => list.filter((p) => mentionsIngredient(`${p.title} ${p.description ?? ''}`, ing.en));
    let papers = about(await searchScholar(`${ing.en} supplementation ${ing.effectEn} randomized controlled trial meta-analysis`, cost, 8));
    if (!papers.length) papers = about(await searchScholar(`${ing.en} ${ing.effectEn}`, cost, 8));
    return { ing, papers: papers.slice(0, 6) };
  }));

  const endorsementP = decide({ ad: input.text || claims.join('\n') }, {
    endorsement: {
      type: 'noul',
      instructions: '광고가 의사·약사·한의사·영양사 등 전문가(실존 인물이든 가상 인물이든)가 제품을 추천하거나 보증하는 형식을 쓰는가?',
      criteria: { true: '전문가가 추천·보증·처방한다고 표현하거나 그런 인물을 내세운다', false: '전문가 추천·보증 표현이 없다' },
    },
  }, cost).then((a) => {
    const p = a.endorsement?.noul ?? 0;
    emit('endorsement', { probability: p, flagged: p >= 0.65 });
  });

  const [registration, approved] = await Promise.all([registrationP, approvedP]);

  // 판정 기준이 되는 "인정 기능성" 문구: 제품 신고 내용이 있으면 그것이 가장 정확하고, 없으면 원료별 식약처 자료.
  // 실제 인증키로 조회해 신고 내역이 없으면 일반식품이라는 사실 자체가 기준이 됨
  const approvedText = registration?.status === 'not_found'
    ? NOT_SUPPLEMENT
    : [
      ...(registration?.status === 'found' ? registration.products.slice(0, 1) : []).map((p) => `[제품 신고 주된기능성] ${p.functionality}`),
      ...approved.flatMap((a) => a.items.filter((i) => i.official).map((i) => `[${a.ingredient} 원료 인정 자료] ${short(i.text, 300)}`)),
    ].join('\n');

  emit('stage', { step: 'judge', label: '문구마다 인정 범위와 대조하는 중' });

  const claimJobs = claims.map(async (claim, i) => {
    emit('claim', { index: i, ...(await judgeClaim(claim, approvedText, cost)) });
  });

  const evidenceJobs = papersP.then((list) => Promise.all(list.map(async ({ ing, papers }) => {
    let score = 0, confidence = 0;
    if (papers.length) {
      const a = await decide({
        ingredient: `${ing.ko} (${ing.en})`,
        claimed_effect: ing.effectEn,
        papers: papers.map((p) => ({ title: p.title, journal: p.journal ?? '', year: p.date, citations: p.citationCount ?? 0, abstract: short(p.description ?? '', 400) })),
      }, {
        strength: { type: 'score', instructions: '이 논문들은 해당 원료가 광고된 효과를 사람에게 낸다는 주장을 얼마나 뒷받침하는가?', criteria: EVIDENCE_LEVELS },
      }, cost);
      score = a.strength?.score ?? 0;
      confidence = a.strength?.confidence ?? 0;
    }
    emit('evidence', {
      ingredient: ing.ko,
      effect: ing.effectEn,
      grade: evidenceGrade(score, confidence, papers.length),
      score, confidence,
      papers: papers.map((p) => ({ title: p.title, url: p.url, journal: p.journal ?? '', year: p.date, citations: p.citationCount ?? null })),
    });
  })));

  await Promise.all([...claimJobs, evidenceJobs, endorsementP, safetyP]);
  emit('done', { costUsd: cost.total(), ms: Date.now() - started });
}
