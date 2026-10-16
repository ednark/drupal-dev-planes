// Family B1 instrument: deterministic retrieval checks — no model in the
// loop (sweep-harness-plan §5 B1). For each fixture: run search_drupal with
// (a) the curated keyword query (kq) and (b) the raw question, at the
// fixture's Drupal version. Assert expected docs surface in top-k (record
// the rank); record forbidden-doc presence/absence per the fixture's
// forbiddenPolicy. Every run also emits ledger PROPOSALS — the ledger is
// never rewritten by sweeps (§5 B3); a human or `gate --apply` applies them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { call } from "../lib/planes.mjs";

const SWEEP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUESTIONS_PATH = join(SWEEP_DIR, "corpus-questions.json");

export function loadFixtures(path = QUESTIONS_PATH) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  return { config: data, fixtures: data.fixtures ?? [] };
}

function matchesDoc(hit, m) {
  if (m.title && !(hit.title ?? "").includes(m.title)) return false;
  if (m.titleSubstr && !(hit.title ?? "").toLowerCase().includes(m.titleSubstr.toLowerCase())) return false;
  if (m.pathSubstr && !(hit.repositoryPath ?? "").toLowerCase().includes(m.pathSubstr.toLowerCase())) return false;
  if (m.project && hit.project !== m.project) return false;
  if (m.projectNot && hit.project === m.projectNot) return false;
  if (m.sourceType && hit.sourceType !== m.sourceType) return false;
  return true;
}

function summarizeHit(hit, rank) {
  return {
    rank,
    docId: hit.id,
    title: hit.title,
    repositoryPath: hit.repositoryPath ?? null,
    project: hit.project ?? null,
    sourceType: hit.sourceType ?? null,
    score: typeof hit.score === "number" ? Math.round(hit.score * 1000) / 1000 : null,
  };
}

async function runQuery(client, fixture, queryType, query, topK) {
  const t0 = Date.now();
  const envelope = await call(client, "search_drupal", {
    query,
    drupal_version: fixture.drupalVersion,
    limit: topK,
  });
  const durationMs = Date.now() - t0;
  if (envelope.status !== "ok") {
    return {
      type: queryType,
      query,
      durationMs,
      verdict: "skipped",
      detail: `search_drupal ${envelope.status}: ${(envelope.data?.stderr ?? envelope.notes?.[0] ?? "unavailable").slice(0, 200)}`,
      hits: [],
      bestExpectedRank: null,
      forbiddenHits: [],
    };
  }
  const results = envelope.data?.results ?? [];
  const hits = results.map((hit, i) => summarizeHit(hit, i + 1));

  const expectedAnyOf = fixture.expectedDocs?.anyOf ?? [];
  const bestRank = hits.reduce(
    (best, hit) => {
      const matched = expectedAnyOf.some((m) => matchesDoc(hit, m));
      return matched && (best === null || hit.rank < best) ? hit.rank : best;
    },
    null,
  );

  const forbiddenHits = (fixture.forbiddenDocs ?? [])
    .flatMap((m) => hits.filter((hit) => matchesDoc(hit, m)).map((hit) => ({ rank: hit.rank, docId: hit.id, title: hit.title })));

  const verdict =
    bestRank !== null && bestRank <= topK ? "pass" : "fail";
  let detail = `expected doc ${bestRank !== null ? `rank ${bestRank}` : "absent"} in top-${topK} for ${queryType}`;
  if (forbiddenHits.length > 0) detail += `; forbidden: ${forbiddenHits.map((f) => `#${f.rank} ${f.title}`).join(", ")}`;

  return { type: queryType, query, durationMs, verdict, detail, hits, bestExpectedRank: bestRank, forbiddenHits };
}

export async function runFixture(client, fixture, config) {
  const startedAt = new Date().toISOString();
  const topK = config.topK ?? 5;

  const kq = await runQuery(client, fixture, "kq", fixture.kq, topK);
  const question = await runQuery(client, fixture, "question", fixture.question, topK);

  // Forbidden policy: must-not-outrank fails retrieval when a forbidden doc
  // ranks ABOVE the best expected doc; must-not-appear fails whenever present.
  const policy = fixture.forbiddenPolicy ?? "record-only";
  let forbiddenViolation = null;
  if (policy === "must-not-appear" && (kq.forbiddenHits.length > 0 || question.forbiddenHits.length > 0)) {
    forbiddenViolation = "forbidden doc appeared (must-not-appear)";
  } else if (policy === "must-not-outrank") {
    const forPolicy = (q) =>
      q.forbiddenHits.filter((f) => q.bestExpectedRank === null || f.rank < q.bestExpectedRank);
    if (forPolicy(kq).length > 0 || forPolicy(question).length > 0) {
      forbiddenViolation = "forbidden doc outranks the expected doc (must-not-outrank)";
    }
  }

  const bothPass = kq.verdict === "pass" && question.verdict === "pass";
  const retrieval = {
    verdict: bothPass && !forbiddenViolation ? "pass" : "fail",
    detail: `kq: ${kq.detail}; question: ${question.detail}${forbiddenViolation ? `; ${forbiddenViolation}` : ""}`,
  };

  const locatedDocIds = [...new Set([...kq.hits, ...question.hits].map((h) => h.docId))];
  const proposals = [];
  if (fixture.ledgerIssue) {
    proposals.push({
      issueId: fixture.ledgerIssue,
      type: "locatedDocIds",
      docIds: locatedDocIds,
    });
    proposals.push({
      issueId: fixture.ledgerIssue,
      type: "observation",
      text: `B1 retrieval 2026-10-16: kq=${kq.verdict} (${kq.detail}); question=${question.verdict} (${question.detail})${forbiddenViolation ? `; ${forbiddenViolation}` : ""}`,
    });
  } else if (retrieval.verdict === "fail") {
    // Untracked retrieval gap: propose a NEW ledger issue for human review.
    // The ledger is never rewritten by sweeps (§5 B3).
    proposals.push({
      issueId: `proposed-${fixture.id}`,
      type: "new-issue",
      title: `Retrieval gap: ${fixture.id} question does not surface expected docs`,
      question: fixture.question,
      text: retrieval.detail,
      proposedStatus: "open",
    });
  }

  return {
    startedAt,
    fixture: { site: "corpus", url: "drupal-dev-mcp index", drupal: fixture.drupalVersion },
    mutations: [],
    queries: [kq, question].map(({ type, query, durationMs, verdict, detail, hits, bestExpectedRank, forbiddenHits }) => ({
      type, query, durationMs, verdict, detail, bestExpectedRank,
      topK: hits,
      forbiddenHits,
    })),
    retrieval,
    locatedDocIds,
    ledgerProposals: proposals,
  };
}
