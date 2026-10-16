// Small-model eval: does the knowledge plane (drupal-dev-mcp) help a small
// model more than it helps a frontier model?
//
// Conditions per question:
//   A "bare"     — model answers from its own weights
//   B "grounded" — top-3 lexical hits from search_drupal (10.6) injected as
//                  context, model instructed to cite drupal:// URIs
//
// Mechanical scoring: D7-era constructs = fail markers; D8+ constructs =
// pass markers. Grounded answers additionally get their cited URIs resolved
// through get_drupal_document (the README's confabulation check).
//
// Endpoint-agnostic: any OpenAI-compatible /v1/chat/completions server
// (llama-server, ollama). Configure via env:
//   EVAL_BASE_URL=http://127.0.0.1:8077   EVAL_MODEL=gemma-4-E4B-it-UD-Q4_K_XL
//   EVAL_TAG=gemma4-4b                    (label for the report)
//
// Run: node22, .env sourced, model server running.
//   export PATH=/opt/homebrew/opt/node@22/bin:$PATH
//   set -a; source .env; set +a
//   EVAL_BASE_URL=http://127.0.0.1:8077 EVAL_MODEL=gemma... node scripts/small-model-eval.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";

const BASE_URL = (process.env.EVAL_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
const MODEL = process.env.EVAL_MODEL ?? "llama3.1:8b";
const TAG = process.env.EVAL_TAG ?? MODEL;

const QUESTIONS = [
  {
    id: "route",
    q: "In Drupal 10, how do I register a route for the path /hello that returns rendered output from a custom module? Show code.",
    kq: "custom module route path controller routing yaml",
    fail: [/hook_menu\b/],
    pass: [/\.routing\.yml|routing\.yml|routes:/, /Controller/],
  },
  {
    id: "message",
    q: "In Drupal 10 custom module code, how do I show a status message to the user? Show code.",
    kq: "messenger service addStatus status message",
    fail: [/drupal_set_message/],
    pass: [/messenger/i],
  },
  {
    id: "dbquery",
    q: "In Drupal 10, how do I run a SELECT query against the site database from a custom module? Show code.",
    kq: "database connection select query service injection",
    fail: [/db_query\s*\(/],
    pass: [/::database\(\)|->query\(|Connection\s*\$|Drupal\\Core\\Database\\Connection|'database'/],
  },
  {
    id: "currentuser",
    q: "In Drupal 10 custom module code, how do I get the currently logged-in user account? Show code.",
    kq: "current user account service getCurrentAccount",
    fail: [/global \$user|\$user->uid/],
    pass: [/currentUser|current_user/i],
  },
  {
    id: "sdc",
    tier: 2,
    q: "In Drupal 10.3+, what is the recommended way to create a reusable front-end component with its template, CSS and JS colocated in one directory? Name the system.",
    kq: "single directory components SDC component theme",
    fail: [],
    pass: [/SDC|Single Directory Component|single directory component/i],
  },
  {
    id: "recipes",
    tier: 2,
    q: "In Drupal 10.3+, how can a module or distribution ship default configuration and content so another site can apply it as one unit? Name the system.",
    kq: "recipe install configuration content apply",
    fail: [],
    pass: [/\brecipe/i],
  },
  {
    id: "ckeditor",
    tier: 2,
    q: "Which text editor is Drupal 10's default, and what replaced the editor that Drupal 9 shipped with?",
    kq: "CKEditor 5 default text editor replacement",
    fail: [],
    pass: [/CKEditor\s*5/i],
  },
  {
    id: "phpfloor",
    tier: 2,
    q: "What is the minimum PHP version Drupal 11 requires?",
    kq: "Drupal 11 requirements PHP 8.3 composer.json",
    fail: [/minimum[^.\n]*8\.[12]\b/i],
    pass: [/8\.3/],
  },
];

// ---------------------------------------------------------------------------
// Knowledge plane (through drupal-dev-planes server → drupal-dev-mcp).
// ---------------------------------------------------------------------------

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["packages/server/dist/index.js"],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ...process.env },
});
const client = new Client({ name: "small-model-eval", version: "0.1.0" });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
  return JSON.parse(text);
}

/** Strip index-highlight bracket artifacts ("[Drupal]::time()" → "Drupal::time()"). */
function cleanSnippet(text) {
  return text.replace(/\[([^\]\n]{1,40})\]/g, "$1").replace(/ {2,}/g, " ");
}

async function evidenceFor(kq) {
  const r = await call("search_drupal", { query: kq, drupal_version: "10.6", limit: 3 });
  const hits = r.data?.results ?? r.data?.hits ?? [];
  return hits.map((h) => ({
    uri: h.resourceUri ?? h.uri ?? "?",
    title: h.title ?? h.entity?.title ?? "?",
    snippet: cleanSnippet((h.snippet ?? h.excerpt ?? (h.text ?? "")).slice(0, 1200)),
  }));
}

// ---------------------------------------------------------------------------
// Model calls (OpenAI-compatible chat completions, temperature 0).
// ---------------------------------------------------------------------------

const SYSTEM = "You are a senior Drupal developer. Answer for the stated Drupal version with concise, correct code.";

async function chat(messages) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`model server ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    finishReason: data.choices?.[0]?.finish_reason ?? "?",
  };
}

function barePrompt(q) {
  return [{ role: "system", content: SYSTEM }, { role: "user", content: `Question (Drupal 10): ${q.q}` }];
}

function groundedPrompt(q, evidence) {
  const block = evidence
    .map((e, i) => `[${i + 1}] ${e.title} (${e.uri})\n${e.snippet}`)
    .join("\n\n");
  const instruction =
    "Answer ONLY from the evidence below; cite the evidence as (uri) next to each claim. If the evidence is insufficient, say so.";
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Evidence:\n${block}\n\nQuestion (Drupal 10): ${q.q}\n\n${instruction}` },
  ];
}

function score(answer, q) {
  const failHits = q.fail.filter((re) => re.test(answer));
  const passHits = q.pass.filter((re) => re.test(answer));
  return { failHits: failHits.map(String), passCount: passHits.length };
}

async function checkCitations(answer) {
  const uris = [...answer.matchAll(/drupal:\/\/document\/(doc_[A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  const unique = [...new Set(uris)];
  let resolvable = 0;
  for (const id of unique) {
    const doc = await call("get_drupal_document", { document_id: id });
    if (doc.status === "ok") resolvable++;
  }
  return { cited: unique.length, resolvable };
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

const report = [];
for (const q of QUESTIONS) {
  const a = await chat(barePrompt(q));
  const evidence = await evidenceFor(q.kq);
  const b = await chat(groundedPrompt(q, evidence));

  const sa = score(a.content, q);
  const sb = score(b.content, q);
  const citations = await checkCitations(b.content);

  report.push({
    id: q.id,
    bare: { ...sa, finishReason: a.finishReason },
    grounded: { ...sb, citations, finishReason: b.finishReason },
    evidence: evidence.map((e) => e.title),
    evidenceHits: evidence.length,
    bareAnswerHead: a.content.slice(0, 260).replace(/\s+/g, " "),
    groundedAnswerHead: b.content.slice(0, 260).replace(/\s+/g, " "),
  });
  console.log(`${q.id}: bare fail=[${sa.failHits}] pass=${sa.passCount} | grounded fail=[${sb.failHits}] pass=${sb.passCount} cites=${citations.resolvable}/${citations.cited} (${b.finishReason})`);
}

await client.close();
writeFileSync(`data/small-model-eval-${TAG}.json`, JSON.stringify({ model: MODEL, baseUrl: BASE_URL, tag: TAG, report }, null, 2));
const tierOf = (q) => (q.tier ?? 1);
const bareFails1 = report.filter((r, i) => tierOf(QUESTIONS[i]) === 1 && r.bare.failHits.length > 0).length;
const groundedFails1 = report.filter((r, i) => tierOf(QUESTIONS[i]) === 1 && r.grounded.failHits.length > 0).length;
const bareFails2 = report.filter((r, i) => tierOf(QUESTIONS[i]) === 2 && r.bare.failHits.length > 0).length;
const groundedFails2 = report.filter((r, i) => tierOf(QUESTIONS[i]) === 2 && r.grounded.failHits.length > 0).length;
const n1 = QUESTIONS.filter((q) => tierOf(q) === 1).length;
const n2 = QUESTIONS.filter((q) => tierOf(q) === 2).length;
console.log(`\n[${TAG}] tier1 (D7-era traps):  bare ${bareFails1}/${n1} | grounded ${groundedFails1}/${n1}`);
console.log(`[${TAG}] tier2 (recent-era APIs): bare ${bareFails2}/${n2} | grounded ${groundedFails2}/${n2}`);
console.log(`written: data/small-model-eval-${TAG}.json`);