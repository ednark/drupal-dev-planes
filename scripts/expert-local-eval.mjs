// Expert eval: run the shared 8 questions through drupal-dev-mcp's
// ask_a_drupal_expert with a LOCAL model as the synthesis engine
// (OpenAI-compatible endpoint via OPENAI_BASE_URL).
//
// Env:
//   OPENAI_BASE_URL=http://localhost:11434/v1   (ollama)
//                     or http://127.0.0.1:8077/v1  (llama-server)
//   OPENAI_AGENT_MODEL=llama31-8b-16k | gemma-4-E4B-it-UD-Q4_K_XL
//   EVAL_TAG=llama31-8b | gemma4-4b
//
// Run: node22, .env sourced (DRUPAL_MCP_INDEX_ROOT etc.).
//   export PATH=/opt/homebrew/opt/node@22/bin:$PATH
//   set -a; source .env; set +a
//   OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_AGENT_MODEL=llama31-8b-16k EVAL_TAG=llama31-8b node scripts/expert-local-eval.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { QUESTIONS, score } from "./eval-questions.mjs";

const TAG = process.env.EVAL_TAG ?? "local-model";
const DEPTH = process.env.EVAL_DEPTH ?? "ask";
const ONLY_IDS = process.env.EVAL_IDS ? process.env.EVAL_IDS.split(",") : null;
const DRUPAL_DEV_MCP = "/Users/ednark/Projects/drupal-dev-mcp/packages/server/dist/index.js";

// ---------------------------------------------------------------------------
// Connect DIRECTLY to drupal-dev-mcp (the expert tool is its surface, not
// drupal-agent-planes'). Pass the local synthesis model through the env —
// exactly the configuration the README prescribes for local models.
// ---------------------------------------------------------------------------

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [DRUPAL_DEV_MCP],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DRUPAL_MCP_INDEX_ROOT: "/Users/ednark/Projects/drupal-dev-mcp/data/index",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "ollama",
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://localhost:11434/v1",
    OPENAI_AGENT_MODEL: process.env.OPENAI_AGENT_MODEL ?? "llama31-8b-16k",
  },
});
const client = new Client({ name: "expert-local-eval", version: "0.1.0" });
await client.connect(transport);

async function call(name, args, timeoutMs = 900_000) {
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
    JSON.stringify(parsed).slice(0, 4000)
  );
}

async function checkCitations(text) {
  const ids = [...text.matchAll(/drupal:\/\/document\/(doc_[A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  const unique = [...new Set(ids)];
  let resolvable = 0;
  for (const id of unique) {
    const doc = await call("get_drupal_document", { document_id: id }, 60_000);
    if (doc.status === "ok" || doc.status === "found") resolvable++;
  }
  return { cited: unique.length, resolvable };
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

const report = [];
for (const q of QUESTIONS) {
  if (ONLY_IDS && !ONLY_IDS.includes(q.id)) continue;
  const parsed = await call("ask_a_drupal_expert", {
    question: q.q,
    depth: DEPTH,
    drupal_version: "10.6",
  });
  const status = parsed.status ?? "?";
  const answer = extractAnswer(parsed);
  const s = score(answer, q);
  const citations = await checkCitations(answer);

  report.push({
    id: q.id,
    tier: q.tier,
    depth: DEPTH,
    expertStatus: status,
    ...s,
    citations,
    head: String(answer).slice(0, 280).replace(/\s+/g, " "),
  });
  console.log(`${q.id}: depth=${DEPTH} status=${status} fail=[${s.failHits}] pass=${s.passCount} cites=${citations.resolvable}/${citations.cited}`);
}

await client.close();
writeFileSync(`data/expert-eval-${TAG}-${DEPTH}${ONLY_IDS ? "-partial" : ""}.json`, JSON.stringify({ model: process.env.OPENAI_AGENT_MODEL, tag: TAG, depth: DEPTH, report }, null, 2));

for (const tier of [1, 2]) {
  const rows = report.filter((r) => r.tier === tier);
  if (rows.length === 0) continue;
  const ok = rows.filter((r) => r.passCount > 0 && r.failHits.length === 0).length;
  console.log(`[${TAG}] tier${tier} (${DEPTH}): correct ${ok}/${rows.length} (pass markers, no stale APIs)`);
}
console.log(`written: data/expert-eval-${TAG}-${DEPTH}${ONLY_IDS ? "-partial" : ""}.json`);