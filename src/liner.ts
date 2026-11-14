// 라이너 API 어댑터. 공식 문서: https://liner.com/ko/developers/docs
// Router(OpenAI 호환 chat completions) · Search(Web/Scholar) · Decisions 세 가지만 씁니다.

const BASE = 'https://platform.liner.com/api/v1';

// 호출당 고정 요금 (요금제 문서 기준, USD). Router·Decisions는 응답의 usage.cost를 그대로 씁니다.
export const PRICE = { web: 1 / 1000, scholar: 0.3 / 1000 };

export type Cost = { add(usd: number): void; total(): number };
export function costMeter(): Cost {
  let sum = 0;
  return { add: (usd) => { sum += Number.isFinite(usd) ? usd : 0; }, total: () => sum };
}

function key(): string {
  const k = process.env.LINER_API_KEY?.trim();
  if (!k) throw new Error('LINER_API_KEY가 없습니다. .env에 넣어 주세요.');
  return k;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown, timeoutMs = 60_000): Promise<any> {
  // 한도 초과(429)·일시 장애는 문서 권장대로 Retry-After + 지터를 두고 최대 3번 다시 시도
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    let retryable = res.status === 429 || res.status >= 500;
    try { retryable = JSON.parse(text)?.error?.retryable ?? retryable; } catch {}
    if (!retryable || attempt >= 3) throw new Error(`라이너 ${path} ${res.status}: ${text.slice(0, 300)}`);
    const after = Number(res.headers.get('retry-after')) || 1;
    await sleep(after * 1000 * 2 ** attempt + Math.random() * 400);
  }
}

// Scholar는 계정 전체 초당 2회 한도라, 서버 안의 모든 판독이 한 줄로 서서 0.55초 간격으로 호출
let scholarQueue: Promise<unknown> = Promise.resolve();
function inScholarQueue<T>(job: () => Promise<T>): Promise<T> {
  const run = scholarQueue.then(job, job);
  scholarQueue = run.catch(() => {}).then(() => sleep(550));
  return run;
}

export type SearchResult = { title: string; url: string; hostname: string; description: string; date: string; citationCount?: number; journal?: string; authors?: string[] };

export async function searchWeb(query: string, cost: Cost, opts: { max?: number; dateRange?: string } = {}): Promise<SearchResult[]> {
  // include_knowledge: false → 주가·스포츠 같은 프리미엄 데이터를 빼고 1,000건당 $1
  const j = await post('/tools/search/web', { query, max_results: opts.max ?? 8, include_knowledge: false, ...(opts.dateRange ? { date_range: opts.dateRange } : {}) }, 30_000);
  cost.add(PRICE.web);
  return j.results ?? [];
}

export async function searchScholar(query: string, cost: Cost, max = 6): Promise<SearchResult[]> {
  const j = await inScholarQueue(() => post('/tools/search/scholar', { query, max_results: max }, 30_000));
  cost.add(PRICE.scholar);
  // 논문 제목에 "&lt;i&gt;Garcinia&lt;/i&gt;" 같은 이스케이프된 태그가 섞여 와서 글자만 남김
  const plain = (s = '') => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/<[^>]*>/g, '');
  return (j.results ?? []).map((r: SearchResult) => ({ ...r, title: plain(r.title), description: plain(r.description) }));
}

type NoulQ = { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };
type ChoiceQ = { type: 'choice'; instructions: string; criteria: Record<string, string> };
type ScoreQ = { type: 'score'; instructions: string; criteria: string[] };
export type Question = NoulQ | ChoiceQ | ScoreQ;

/** 확률로 답하는 판정. 출력 토큰 무료, 입력 토큰만 과금 */
export async function decide(state: unknown, questions: Record<string, Question>, cost: Cost): Promise<Record<string, any>> {
  const model = process.env.DECISION_MODEL?.trim() || 'perplexity/pplx-decider-v1.2';
  const j = await post('/decisions', { model, state, questions }, 60_000);
  cost.add(j.usage?.cost ?? 0);
  return j.answers ?? {};
}

/** JSON 스키마에 맞는 객체 하나. 이미지(data URL)도 함께 보낼 수 있습니다 */
export async function routerJson<T>(system: string, user: string, schema: Record<string, unknown>, cost: Cost, imageDataUrl?: string): Promise<T> {
  const content = imageDataUrl
    ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: imageDataUrl } }]
    : user;
  const j = await post('/chat/completions', {
    model: 'liner-gpt-router',
    routing_strategy: 'cost',
    reasoning_effort: 'low',
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
    response_format: { type: 'json_schema', json_schema: { name: 'out', strict: true, schema } },
  }, 90_000);
  cost.add(j.usage?.cost ?? 0);
  return JSON.parse(j.choices?.[0]?.message?.content ?? '{}') as T;
}
