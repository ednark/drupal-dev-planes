// Claim-support regression: recorded B2 answers become standing fixtures.
// Re-runs the deterministic check_claim_support on each recorded answer
// against freshly-resolved documents and compares verdicts — a corpus fix
// MUST flip previously-unsupported recorded answers to supported; drift in
// the other direction is reported loudly. (Sweep-harness-plan §5 B2.)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkClaimSupport, CITATION_RE } from "../packages/verify/dist/index.js";
import { call } from "./lib/planes.mjs";

const RECORDS_DIR = new URL("./records/", import.meta.url).pathname;

async function main() {
  const env = process.env;
  const records = readdirSync(RECORDS_DIR)
    .filter((n) => n.includes("cs-") && n.endsWith(".json"))
    .map((n) => JSON.parse(readFileSync(join(RECORDS_DIR, n), "utf8")));

  const rows = records.flatMap((r) =>
    (r.answerability ?? [])
      .filter((a) => a.claimSupport && a.answer)
      .map((a) => ({ fixture: r.target, model: a.model, recorded: a.claimSupport.verdict, answer: a.answer })),
  );
  if (rows.length === 0) {
    console.log("no recorded claim-support fixtures yet — run npm run sweep:b2 first");
    return;
  }

  // One connection resolves all cited documents.
  const { connectPlanes, closePlanes } = await import("./lib/planes.mjs");
  const client = await connectPlanes();
  const docCache = new Map();
  try {
    let drift = 0;
    let flipped = 0;
    for (const row of rows) {
      const ids = [...new Set([...row.answer.matchAll(CITATION_RE)].map((m) => m[1] ?? "").filter(Boolean))];
      const docs = {};
      let unresolved = 0;
      for (const id of ids) {
        if (docCache.has(id)) {
          docs[id] = docCache.get(id);
          continue;
        }
        const doc = await call(client, "get_drupal_document", { document_id: id });
        const text = doc?.data?.text ?? null;
        if (typeof text === "string" && text.length > 0) {
          docs[id] = text;
          docCache.set(id, text);
        } else unresolved++;
      }
      const fresh = checkClaimSupport(row.answer, docs);
      const same = fresh.verdict === row.recorded;
      const improved =
        !same &&
        ["unsupported", "unresolvable", "weak", "uncited"].includes(row.recorded) &&
        fresh.verdict === "supported";
      if (improved) flipped++;
      if (!same && !improved) drift++;
      console.log(
        `${same ? "same    " : improved ? "IMPROVED" : "DRIFT   "} ${row.fixture}/${row.model}: recorded=${row.recorded} fresh=${fresh.verdict}${unresolved ? ` (${unresolved} unresolved)` : ""}`,
      );
    }
    console.log(`\nfixtures: ${rows.length}  same: ${rows.length - drift - flipped}  improved: ${flipped}  drift: ${drift}`);
    if (drift > 0) {
      console.error("drift detected — a corpus change degraded recorded support; investigate before shipping");
      process.exit(1);
    }
  } finally {
    await closePlanes(client);
  }
}

main().catch((error) => {
  console.error("regression run failed:", error);
  process.exit(1);
});
