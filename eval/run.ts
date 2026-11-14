// 문구 판정 정확도 측정: node --env-file=.env eval/run.ts [결정모델...]
// 판정 단계(judgeClaim)만 따로 잰다. 인정 기능성은 정답 문구를 주고, 검색이 틀리는 경우는 이 수치에 들어가지 않는다.
import { readFile, writeFile } from 'node:fs/promises';
import { judgeClaim, NOT_SUPPLEMENT } from '../src/pipeline.ts';
import { costMeter } from '../src/liner.ts';

type Case = { id: string; claim: string; label: 'violation' | 'ok'; approved: string | null; context?: string; source: string };
const data = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
const cases: Case[] = data.cases;
const models = process.argv.slice(2).length ? process.argv.slice(2) : [process.env.DECISION_MODEL || "perplexity/pplx-decider-v1.2"];

const report: string[] = [];
for (const model of models) {
  process.env.DECISION_MODEL = model;
  const cost = costMeter();
  const t0 = Date.now();
  const rows = await Promise.all(cases.map(async (c) => {
    const approvedText = c.approved ? `[원료 인정 기능성] ${data.approvedTexts[c.approved]}` : NOT_SUPPLEMENT;
    const r = await judgeClaim(c.claim, approvedText, cost);
    const flagged = r.verdict === 'danger' || r.verdict === 'warn';
    return { ...c, verdict: r.verdict, exceeds: r.exceeds, type: r.type, flagged, hold: r.verdict === 'hold' };
  }));

  const v = rows.filter((r) => r.label === 'violation'), o = rows.filter((r) => r.label === 'ok');
  const tp = v.filter((r) => r.flagged).length, fn = v.filter((r) => r.verdict === 'ok').length, vHold = v.filter((r) => r.hold).length;
  const tn = o.filter((r) => r.verdict === 'ok').length, fp = o.filter((r) => r.flagged).length, oHold = o.filter((r) => r.hold).length;
  const decided = rows.filter((r) => !r.hold);
  const correct = tp + tn;
  const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + '%' : '-');

  const lines = [
    `## ${model}`,
    `- 문구 ${rows.length}개 (위반 ${v.length}, 정상 ${o.length}) · ${((Date.now() - t0) / 1000).toFixed(1)}초 · 비용 $${cost.total().toFixed(5)}`,
    `- 위반 탐지율(재현율): ${pct(tp, v.length)} (${tp}/${v.length}) · 보류 ${vHold} · 놓침 ${fn}`,
    `- 정상 통과율(특이도): ${pct(tn, o.length)} (${tn}/${o.length}) · 보류 ${oHold} · 오탐 ${fp}`,
    `- 판정 정밀도(위험·주의 중 실제 위반): ${pct(tp, tp + fp)}`,
    `- 보류 제외 정확도: ${pct(correct, decided.length)} (${correct}/${decided.length}) · 전체 보류율 ${pct(vHold + oHold, rows.length)}`,
    '',
    '| id | 문구 | 정답 | 판정 | 초과확률 | 성격 |',
    '|---|---|---|---|---|---|',
    ...rows
      .filter((r) => (r.label === 'violation' && !r.flagged) || (r.label === 'ok' && r.verdict !== 'ok'))
      .map((r) => `| ${r.id} | ${r.claim} | ${r.label} | ${r.verdict} | ${r.exceeds.toFixed(2)} | ${r.type} |`),
    '',
  ];
  console.log(lines.join('\n'));
  report.push(...lines);
}
await writeFile(new URL('./last-result.md', import.meta.url), `# 문구 판정 평가 결과\n\n측정: ${new Date().toISOString()}\n\n표는 틀리거나 보류된 문구만 보여줍니다.\n\n${report.join('\n')}`);
