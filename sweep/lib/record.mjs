// Record schema, validation, and writer. Records are the source of truth
// (sweep-harness principle #1): a catalog row may say `measured` only if a
// dated record exists for it, and the gate enforces that — nothing else does.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Closed verdict enum. skipped/inconclusive never fold into pass rates. */
export const VERDICTS = ["pass", "fail", "skipped", "inconclusive"];

export const FAMILIES = ["failure-mode", "corpus"];

/**
 * A record is one file per target per run:
 * { sweepId, family, target, startedAt, finishedAt, fixture, mutations,
 *   reproduce: {verdict, detail}, detect: {tool, verdict, detail},
 *   verdict, reason?, notes[], model }
 */
export function validateRecord(record) {
  const errors = [];
  if (!record || typeof record !== "object") return ["record is not an object"];
  const req = (field, label) => {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      errors.push(`${label} is required and must be a non-empty string`);
    }
  };
  req("sweepId", "sweepId");
  req("target", "target");
  req("startedAt", "startedAt (ISO date)");
  if (!FAMILIES.includes(record.family)) errors.push(`family must be one of ${FAMILIES.join(", ")}`);
  if (record.family === "corpus") {
    // Family B has no reproduce/detect duality; the retrieval check IS the
    // instrument. reproduce/detect stay optional for corpus records.
    const retrieval = record.retrieval;
    if (!retrieval || typeof retrieval !== "object") {
      errors.push("retrieval is required for corpus records");
    } else {
      if (!VERDICTS.includes(retrieval.verdict)) errors.push(`retrieval.verdict must be one of ${VERDICTS.join(", ")}`);
      if (typeof retrieval.detail !== "string" || retrieval.detail.length === 0) errors.push("retrieval.detail is required");
    }
    if (!Array.isArray(record.queries)) errors.push("queries must be an array for corpus records");
    if (record.verdict === "pass" && retrieval?.verdict !== "pass") {
      errors.push("corpus verdict pass requires retrieval.verdict pass");
    }
    if (record.answerability !== undefined) {
      if (!Array.isArray(record.answerability)) {
        errors.push("answerability must be an array when present");
      } else {
        record.answerability.forEach((row, i) => {
          if (typeof row?.model !== "string") errors.push(`answerability[${i}].model is required`);
          if (!VERDICTS.includes(row?.verdict) && row?.verdict !== "error") {
            errors.push(`answerability[${i}].verdict must be in the closed enum (or "error")`);
          }
        });
      }
    }
  }
  for (const field of record.family === "corpus" ? [] : ["reproduce", "detect"]) {
    const step = record[field];
    if (!step || typeof step !== "object") {
      errors.push(`${field} step is required`);
      continue;
    }
    if (!VERDICTS.includes(step.verdict)) errors.push(`${field}.verdict must be one of ${VERDICTS.join(", ")}`);
    if (typeof step.detail !== "string" || step.detail.length === 0) errors.push(`${field}.detail is required`);
  }
  if (record.family !== "corpus" && record.detect && typeof record.detect.tool !== "string") {
    errors.push("detect.tool is required (which plane tool ran the recipe)");
  }
  if (!record.fixture || typeof record.fixture !== "object") errors.push("fixture is required (site, url, drupal)");
  if (!Array.isArray(record.mutations)) errors.push("mutations must be an array (declared mutations, each with reverted flag)");
  if (!VERDICTS.includes(record.verdict)) errors.push(`verdict must be one of ${VERDICTS.join(", ")}`);
  if ((record.verdict === "skipped" || record.verdict === "inconclusive") &&
      (typeof record.reason !== "string" || record.reason.length === 0)) {
    errors.push("skipped/inconclusive records must carry a reason (G2)");
  }
  if (record.family !== "corpus" && record.verdict === "pass" &&
      !(record.reproduce?.verdict === "pass" && record.detect?.verdict === "pass")) {
    errors.push("verdict pass requires reproduce AND detect pass (G1 semantics)");
  }
  if (!Array.isArray(record.notes)) errors.push("notes must be an array");
  return errors;
}

export function recordSweepId(family, target) {
  const short = family === "failure-mode" ? "fm" : family === "corpus" ? "cs" : family;
  return `${short}-${target}`;
}

export function writeRecord(recordsDir, record) {
  const errors = validateRecord(record);
  if (errors.length > 0) {
    throw new Error(`refusing to write an invalid record: ${errors.join("; ")}`);
  }
  mkdirSync(recordsDir, { recursive: true });
  const date = record.startedAt.slice(0, 10);
  const path = join(recordsDir, `${date}-${record.sweepId}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  return path;
}

export function listRecords(recordsDir) {
  let names = [];
  try {
    names = readdirSync(recordsDir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(recordsDir, name), "utf8"));
      } catch (error) {
        return { sweepId: name, family: null, target: null, verdict: null, _parseError: String(error) };
      }
    });
}

/** Marker for a crashed sweep listing un-reverted mutations (§7 fixture strategy). */
export function writeAbortedMarker(recordsDir, sweepId, reason, mutations) {
  mkdirSync(recordsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(recordsDir, `${date}-${sweepId}-aborted.json`);
  writeFileSync(path, JSON.stringify({
    sweepId,
    abortedAt: new Date().toISOString(),
    reason,
    unrevertedMutations: mutations,
  }, null, 2) + "\n");
  return path;
}
