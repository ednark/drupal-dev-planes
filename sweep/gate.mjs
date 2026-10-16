// Sweep gate: validate catalog/ledger claims against records (§3).
// `--apply` explicitly applies corpus-record ledger PROPOSALS to the ledger
// (§5 B3): locatedDocIds merge, observations append, new-issue proposals are
// created with status "proposed" (inert until a human promotes them). The
// ledger is never rewritten by sweeps without this flag.
//   G1  every catalog row with evidenceStatus "measured" has >=1 record with
//       matching target and verdict pass on BOTH reproduce and detect.
//   G2  every record's verdicts are in the closed enum; skipped/inconclusive
//       records carry a reason.
//   G3  (corpus ledger, when configured) confirmed/fixed entries cite a
//       corpus record; fixed requires a passing record dated after firstObserved.
//   G4  (corpus ledger, when configured) locatedDocIds resolve via get_drupal_document.
//   G5  catalog/ledger files parse and validate against their schemas.
// Exit 1 with a violation list otherwise. npm run sweep:gate

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listRecords, validateRecord, VERDICTS } from "./lib/record.mjs";

const SWEEP_DIR = join(dirname(fileURLToPath(import.meta.url)));
const CATALOG_PATH = join(SWEEP_DIR, "..", "data", "failure-modes.json");
const RECORDS_DIR = join(SWEEP_DIR, "records");
const CORPUS_LEDGER = process.env.SWEEP_CORPUS_LEDGER ?? null;
const APPLY = process.argv.includes("--apply");

const violations = [];
const warnings = [];

// G5: catalog parses and validates.
let catalogRows = [];
try {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  if (!Array.isArray(catalog.failureModes)) throw new Error("no failureModes array");
  for (const row of catalog.failureModes) {
    if (typeof row.id !== "string" || typeof row.detection !== "string") {
      violations.push(`G5: catalog row malformed (id/detection missing): ${JSON.stringify(row.id ?? row)}`);
    }
    if (row.evidenceStatus !== "claimed" && row.evidenceStatus !== "measured") {
      violations.push(`G5: catalog row ${row.id} has invalid evidenceStatus ${row.evidenceStatus}`);
    }
  }
  catalogRows = catalog.failureModes;
} catch (error) {
  violations.push(`G5: catalog unreadable: ${error.message}`);
}

// G2: records validate against the schema; closed enum; reasons present.
const records = listRecords(RECORDS_DIR);
for (const record of records) {
  if (record._parseError) {
    violations.push(`G2: record file unparseable: ${record.sweepId}`);
    continue;
  }
  for (const error of validateRecord(record)) {
    violations.push(`G2: record ${record.sweepId}: ${error}`);
  }
}

// G1: measured rows must be backed by passing records.
for (const row of catalogRows.filter((r) => r.evidenceStatus === "measured")) {
  const backed = records.some(
    (r) =>
      r.family === "failure-mode" &&
      r.target === row.id &&
      r.verdict === "pass" &&
      r.reproduce?.verdict === "pass" &&
      r.detect?.verdict === "pass",
  );
  if (!backed) {
    violations.push(`G1: measured row '${row.id}' has no passing sweep record (reproduce+detect)`);
  }
}

// G3/G4: only when a corpus ledger is configured.
if (CORPUS_LEDGER) {
  try {
    const ledger = JSON.parse(readFileSync(CORPUS_LEDGER, "utf8"));
    const corpusRecords = records.filter((r) => r.family === "corpus");

    // --apply: apply ledger proposals from corpus records (explicit human action).
    if (APPLY) {
      const proposals = corpusRecords.flatMap((r) =>
        (r.ledgerProposals ?? []).map((p) => ({ ...p, source: r.sweepId, startedAt: r.startedAt })),
      );
      const byIssue = new Map();
      for (const p of proposals) {
        if (!byIssue.has(p.issueId)) byIssue.set(p.issueId, []);
        byIssue.get(p.issueId).push(p);
      }
      let appliedDocIds = 0, appliedObservations = 0, appliedNewIssues = 0;
      for (const [issueId, group] of byIssue) {
        let issue = (ledger.issues ?? []).find((i) => i.id === issueId);
        if (!issue) {
          const newIssue = group.find((p) => p.type === "new-issue");
          if (!newIssue) continue;
          issue = {
            id: issueId.replace(/^proposed-/, ""),
            title: newIssue.title,
            question: newIssue.question,
            groundTruth: "(pending human verification)",
            observed: newIssue.text,
            classification: "retrieval-gap",
            locatedDocIds: [],
            detection: "sweep B1 retrieval check",
            remedy: "(pending human triage)",
            status: "proposed",
            firstObserved: new Date().toISOString().slice(0, 10),
          };
          ledger.issues = ledger.issues ?? [];
          ledger.issues.push(issue);
          appliedNewIssues++;
        }
        for (const p of group) {
          if (p.type === "locatedDocIds") {
            issue.locatedDocIds = [...new Set([...(issue.locatedDocIds ?? []), ...p.docIds])];
            appliedDocIds++;
          } else if (p.type === "observation") {
            issue.sweepObservations = [
              ...(issue.sweepObservations ?? []),
              { date: p.startedAt.slice(0, 10), source: p.source, text: p.text },
            ];
            appliedObservations++;
          }
        }
      }
      if (appliedDocIds || appliedObservations || appliedNewIssues) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(CORPUS_LEDGER, JSON.stringify(ledger, null, 2) + "\n");
        console.log(`--apply: ${appliedDocIds} locatedDocIds merge(s), ${appliedObservations} observation(s), ${appliedNewIssues} proposed issue(s) written to ${CORPUS_LEDGER}`);
      } else {
        console.log("--apply: no unapplied proposals found");
      }
    }

    for (const entry of ledger.issues ?? []) {
      if (entry.status === "confirmed" || entry.status === "fixed") {
        const cited = corpusRecords.filter((r) => r.target === entry.id);
        if (cited.length === 0) {
          violations.push(`G3: ledger entry ${entry.id} (${entry.status}) cites no corpus record`);
        } else if (entry.status === "fixed") {
          const passing = cited.some(
            (r) => r.verdict === "pass" && r.startedAt > (entry.firstObserved ?? ""),
          );
          if (!passing) violations.push(`G3: ledger entry ${entry.id} fixed without a passing record after firstObserved`);
        }
      }
      // G4 is schema-level here; URI resolution runs via planes in the corpus instrument.
      for (const docId of entry.locatedDocIds ?? []) {
        if (typeof docId !== "string" || docId.length === 0) {
          violations.push(`G4: ledger entry ${entry.id} has a malformed locatedDocId`);
        }
      }
    }
  } catch (error) {
    violations.push(`G5: corpus ledger unreadable: ${error.message}`);
  }
} else {
  warnings.push("SWEEP_CORPUS_LEDGER not set — G3/G4 skipped (corpus Phase 2 pending)");
}

if (records.length === 0) {
  warnings.push("no records yet — gate passes vacuously; run sweeps first");
}

console.log(`records: ${records.length}`);
for (const w of warnings) console.log(`warning: ${w}`);
if (violations.length > 0) {
  console.error(`\ngate FAILED — ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("gate PASSED");
