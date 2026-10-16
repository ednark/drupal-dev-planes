// Family B2 instrument: the answerability matrix (sweep-harness-plan §5 B2).
// For each fixture × configured model: run ask_a_drupal_expert (ask mode by
// default), then score the answer MECHANICALLY:
//   1. pass/fail markers from the shared eval-questions set
//   2. check_claim_support on the answer (unsupported -> fail)
//   3. version-assertion flags (version transposition -> fail)
//   4. grounding density (recorded; < 0.5 flagged)
// Records carry the FULL answer text (the 280-char-head lesson from the
// ad-hoc evals). The synthesis model connects DIRECTLY to drupal-dev-mcp —
// ask_a_drupal_expert is its surface, not the planes proxy's.
//
// Token accounting (plan §9.4): usage recorded when the tool reports it,
// otherwise null and labeled estimate-not-available.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkClaimSupport, CITATION_RE } from "../../packages/verify/dist/index.js";
import { QUESTIONS, score } from "../../scripts/eval-questions.mjs";

const DEFAULT_BASE_URL = "http://localhost:11434/v1";

/** Direct connection to drupal-dev-mcp with a named synthesis model. */
export async function connectExpert(env = process.env) {
  const serverPath =
    env.DRUPAL_DEV_MCP_SERVER ?? env.DRUPAL_DEV_MCP_ARGS ?? "";
  if (!serverPath) throw new Error("DRUPAL_DEV_MCP_SERVER (or DRUPAL_DEV_MCP_ARGS) must point at drupal-dev-mcp's server dist");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DRUPAL_MCP_INDEX_ROOT: env.DRUPAL_MCP_INDEX_ROOT,
      OPENAI_API_KEY: env.OPENAI_API_KEY ?? "ollama",
      OPENAI_BASE_URL: env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
      OPENAI_AGENT_MODEL: env.OPENAI_AGENT_MODEL,
    },
  });
  const client = new Client({ name: "sweep-b2", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

export async function closeExpert(client) {
  try {
    await client.close();
  } catch {
    // closing a half-connected client is not a sweep failure
  }
}

async function callTool(client, name, args, timeoutMs = 900_000) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const text = (res.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
  try {
    return JSON.parse(text);
  } catch {
    return { status: "unparseable", raw: text.slice(0, 2000) };
  }
}

function extractAnswer(parsed) {
  return (
    parsed.answer ??
    parsed.data?.answer ??
    parsed.report ??
    parsed.data?.report ??
    parsed.raw ??
    ""
  );
}

async function resolveDocs(client, answer) {
  const ids = [...new Set([...answer.matchAll(CITATION_RE)].map((m) => m[1] ?? "").filter(Boolean))];
  const docs = {};
  let unresolved = 0;
  for (const id of ids) {
    const doc = await callTool(client, "get_drupal_document", { document_id: id }, 60_000);
    const text = doc?.data?.text ?? doc?.text ?? null;
    if (typeof text === "string" && text.length > 0) docs[id] = text;
    else unresolved++;
  }
  return { docs, unresolved, citedIds: ids };
}

/**
 * Pure scoring of one answer against one fixture — no model, deterministic.
 * Exported for unit tests and the claim-support regression runner.
 */
export async function scoreAnswer(answer, fixture, resolveDocsFn) {
  const q = QUESTIONS.find((x) => x.id === fixture.id);
  const markers = q ? score(String(answer), q) : { failHits: [], passCount: 0 };

  const { docs, unresolved, citedIds } = await resolveDocsFn(String(answer));
  const report = checkClaimSupport(String(answer), docs);

  const grounded = report.claims.filter((c) => c.verdict !== "uncited").length;
  const totalClaims = report.claims.length;
  const groundingDensity = totalClaims > 0 ? Math.round((grounded / totalClaims) * 100) / 100 : null;
  const versionFlags = report.claims
    .filter((c) => c.versionConflict)
    .map((c) => c.versionConflict);

  // Verdict derivation (plan §5 B2): unsupported -> fail; version
  // transposition -> fail; stale-API markers -> fail; pass requires markers
  // AND claim support in {supported, weak}.
  let verdict;
  if (markers.failHits.length > 0) verdict = "fail";
  else if (report.verdict === "unsupported" || report.verdict === "unresolvable") verdict = "fail";
  else if (versionFlags.length > 0) verdict = "fail";
  else if (markers.passCount > 0 && (report.verdict === "supported" || report.verdict === "weak")) verdict = "pass";
  else verdict = "inconclusive";

  return {
    markerScoring: markers,
    claimSupport: {
      verdict: report.verdict,
      counts: report.counts,
      groundingDensity,
      versionFlags,
      unresolvedCitations: unresolved,
      citedIds,
    },
    verdict,
  };
}

const EXPERT_OK = new Set(["ok", "answered"]); // 0.2 says "answered", 0.1 said "ok"

export async function askAndScore(client, fixture, model, env = process.env) {
  const depth = env.SWEEP_ANSWERABILITY_DEPTH ?? "ask";
  const t0 = Date.now();
  const parsed = await callTool(client, "ask_a_drupal_expert", {
    question: fixture.question,
    depth,
    drupal_version: fixture.drupalVersion,
  });
  const durationMs = Date.now() - t0;
  const expertStatus = parsed.status ?? "unparseable";
  const answer = String(extractAnswer(parsed));
  const usage = parsed.usage ?? parsed.data?.usage ?? null;

  if (expertStatus === "insufficient_evidence") {
    return {
      model, depth, expertStatus, durationMs,
      verdict: "inconclusive",
      reason: "expert refused honestly (insufficient_evidence) — abstention, not a wrong answer",
      answer,
      usage,
      estimateNotAvailable: usage === null,
    };
  }
  if (!EXPERT_OK.has(expertStatus)) {
    return {
      model, depth, expertStatus, durationMs,
      verdict: expertStatus === "unparseable" ? "error" : "inconclusive",
      reason: `expert status ${expertStatus}`,
      answer,
      usage,
      estimateNotAvailable: usage === null,
    };
  }

  const scored = await scoreAnswer(answer, fixture, (text) => resolveDocs(client, text));
  return {
    model, depth, expertStatus, durationMs,
    verdict: scored.verdict,
    markerScoring: scored.markerScoring,
    claimSupport: scored.claimSupport,
    flagged: scored.claimSupport.groundingDensity !== null && scored.claimSupport.groundingDensity < 0.5,
    answer,
    usage,
    estimateNotAvailable: usage === null,
  };
}

export async function ollamaReachable(env = process.env) {
  const base = (env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace("/v1", "");
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const tags = await res.json();
    const available = new Set((tags.models ?? []).map((m) => m.name.replace(/:latest$/, "")));
    return available;
  } catch {
    return false;
  }
}

export { DEFAULT_BASE_URL };
