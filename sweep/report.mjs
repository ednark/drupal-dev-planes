// Human summary: pass rates (pass/total-attempted) with skipped and
// inconclusive listed separately, never folded in (principle #2).

import { listRecords } from "./lib/record.mjs";

const RECORDS_DIR = new URL("./records/", import.meta.url).pathname;
const records = listRecords(RECORDS_DIR);

if (records.length === 0) {
  console.log("no sweep records yet — run npm run sweep:all");
  process.exit(0);
}

const attempted = records.filter((r) => r.verdict === "pass" || r.verdict === "fail");
const skipped = records.filter((r) => r.verdict === "skipped");
const inconclusive = records.filter((r) => r.verdict === "inconclusive");
const passed = attempted.filter((r) => r.verdict === "pass");

console.log(`records: ${records.length}`);
console.log(`attempted: ${attempted.length}  passed: ${passed.length}  failed: ${attempted.length - passed.length}`);
console.log(`pass rate (attempted only): ${attempted.length ? ((passed.length / attempted.length) * 100).toFixed(0) : "n/a"}%`);
console.log(`\nseparate — never folded into pass rates:`);
for (const r of skipped) console.log(`  skipped:      ${r.sweepId} — ${r.reason ?? "(no reason)"}`);
for (const r of inconclusive) console.log(`  inconclusive: ${r.sweepId} — ${r.reason ?? "(no reason)"}`);

if (attempted.length - passed.length > 0) {
  console.log("\nfailures:");
  for (const r of attempted.filter((x) => x.verdict === "fail")) {
    const detail = r.family === "corpus"
      ? r.retrieval?.detail ?? "(no retrieval detail)"
      : r.detect?.detail ?? "(no detect detail)";
    console.log(`  fail: ${r.sweepId} — ${detail.slice(0, 220)}`);
  }
}

// ---------------------------------------------------------------------------
// Token-price table (analysis-1 P3): measured cost of each corpus step.
// "The alternative" = an agent answering from weights alone (the uncited
// rows measure exactly that outcome class) or reading api.drupal.org by
// hand (human minutes, not machine-measurable here) — the table shows the
// measured machine costs; the alternative's cost is the risk column.
// ---------------------------------------------------------------------------

const corpusRecords = records.filter((r) => r.family === "corpus" && Array.isArray(r.queries));
if (corpusRecords.length > 0) {
  console.log("\ntoken-price table (measured; local models cost no API tokens — hardware seconds instead):");
  console.log("  fixture     | retrieval ms (kq+question) | answer ms/model        | tokens        | retrieval | answer verdicts");
  for (const r of corpusRecords) {
    const retrievalMs = r.queries.reduce((s, q) => s + (q.durationMs ?? 0), 0);
    const b2 = r.answerability ?? [];
    const answerMs = b2.reduce((s, a) => s + (a.durationMs ?? 0), 0);
    const tokens = b2.some((a) => a.usage)
      ? b2.map((a) => `${a.model}:${JSON.stringify(a.usage)}`).join(" ")
      : "estimate-not-available (usage not reported)";
    const answers = b2.length > 0
      ? b2.map((a) => `${a.model}=${a.verdict}`).join(", ")
      : "not-run";
    const pad = (s, n) => String(s).padEnd(n, " ");
    console.log(`  ${pad(r.target, 11)} | ${pad(retrievalMs, 26)} | ${pad(answerMs, 22)} | ${pad(tokens, 13)} | ${pad(r.retrieval?.verdict ?? "-", 9)} | ${answers}`);
  }
  const uncitedRows = corpusRecords.flatMap((r) => (r.answerability ?? []).filter((a) => a.claimSupport?.verdict === "uncited"));
  if (uncitedRows.length > 0) {
    console.log(`  risk column: ${uncitedRows.length} answer(s) were UNCITED — the model answered from weights alone; that is the failure class the planes' citations exist to prevent`);
  }
}
