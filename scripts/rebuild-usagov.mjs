// Rebuild 5 usa.gov pages in the local usagov-2021 (ddev) instance — using
// ONLY the drupal-agent-planes MCP tools (knowledge / state / verification).
// Run with node 22 and the plane env:
//   export PATH=/opt/homebrew/opt/node@22/bin:$PATH
//   set -a; source .env; set +a; node scripts/rebuild-usagov.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SITE_URL = "https://usagov2021.ddev.site";
const LIVE_BASE = "https://www.usa.gov";
// Ad-hoc bring-up driver: the fixture checkout is env-driven (SWEEP_SITE_SOURCE_DIR),
// defaulting to the sibling usagov-2021 checkout wherever both repos sit side by side.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USWDS_REPO = process.env.SWEEP_SITE_SOURCE_DIR ?? join(dirname(REPO_ROOT), "usagov-2021");
const CANDIDATES = [
  "/about-the-us",
  "/passport",
  "/voting",
  "/travel",
  "/scams-and-frauds",
  "/moving",
  "/insurance",
  "/contact-us",
];

// ---------------------------------------------------------------------------
// Connect through the server — nothing below bypasses the planes.
// ---------------------------------------------------------------------------

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["packages/server/dist/index.js"],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ...process.env },
});
const client = new Client({ name: "rebuild-usagov", version: "0.1.0" });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
  const parsed = JSON.parse(text);
  log(`[${name}] plane=${parsed.plane} status=${parsed.status}`);
  return parsed;
}

function log(msg) {
  console.log(msg);
}

// ---------------------------------------------------------------------------
// Phase 0 — ground: status, bundle config, knowledge for the write approach.
// ---------------------------------------------------------------------------

log("== phase 0: ground");
const status = await call("get_site_status", {});
log(`  drupal=${status.data?.drupalVersion} bootstrap=${status.data?.bootstrap}`);

const bundleConfig = await call("get_site_config", { key: "node.type.basic_page" });
log(`  bundle basic_page exists: ${JSON.stringify(bundleConfig.data?.value?.name ?? bundleConfig.data?.value?.label ?? "?")}`);

const explain = await call("explain_config", { key: "node.type.basic_page", drupal_version: "10.6" });
log(`  explain_config join: state=${!!explain.data?.state} knowledge=${!!explain.data?.knowledge}`);

const knowledge = await call("search_drupal", {
  query: "create node programmatically Node::create save path alias",
  drupal_version: "10.6",
  limit: 3,
});
const hits = knowledge.data?.results ?? knowledge.data?.hits ?? [];
log(`  knowledge hits for write approach: ${hits.length}`);
for (const hit of hits.slice(0, 2)) {
  log(`    - ${hit.title ?? hit.entity?.title ?? "?"} → ${hit.resourceUri ?? hit.uri ?? "?"}`);
}

// ---------------------------------------------------------------------------
// Phase 1 — read the live pages (the source material being rebuilt).
// ---------------------------------------------------------------------------

log("== phase 1: fetch live pages");
const pages = [];
for (const path of CANDIDATES) {
  if (pages.length >= 5) break;
  try {
    const res = await fetch(LIVE_BASE + path, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh) agent-planes-test" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) { log(`  ${path}: HTTP ${res.ok ? 200 : res.status} — skipped`); continue; }
    const html = await res.text();
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (!titleMatch || !mainMatch) { log(`  ${path}: no title/main — skipped`); continue; }
    let title = titleMatch[1].replace(/\s*\|\s*USAGov\s*$/i, "").trim();
    let body = mainMatch[1]
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
    if (body.trim().length < 400) { log(`  ${path}: main too small (${body.length}) — skipped`); continue; }
    pages.push({ path, title, body, sourceBytes: html.length });
    log(`  ${path}: "${title}" main=${body.length} chars (page ${html.length})`);
  } catch (e) {
    log(`  ${path}: fetch failed (${e.message}) — skipped`);
  }
}
if (pages.length < 5) { console.error(`only fetched ${pages.length}/5 usable pages — stopping`); process.exit(1); }

// ---------------------------------------------------------------------------
// Phase 2 — write through the gated state plane.
// ---------------------------------------------------------------------------

log("== phase 2: write via drush_dispatch (gated)");
const specs = pages.map((p) => ({
  type: "basic_page",
  title: p.title,
  alias: p.path,
  bodyFormat: "html",
  body: p.body,
}));

mkdirSync(`${USWDS_REPO}/scripts/agent-planes`, { recursive: true });
writeFileSync(`${USWDS_REPO}/scripts/agent-planes/page-specs.json`, JSON.stringify(specs, null, 2));

const creatorPhp = `<?php
// Generated by drupal-agent-planes rebuild driver. Creates/updates basic_page
// nodes from a spec file. Idempotent: replaces a node found at the same alias.
$specPath = '/var/www/html/scripts/agent-planes/page-specs.json';
$specs = json_decode(file_get_contents($specPath), TRUE);
$results = [];
foreach ($specs as $spec) {
  try {
    $storage = \\Drupal::entityTypeManager()->getStorage('node');
    $existing = $storage->loadByProperties(['type' => $spec['type'], 'title' => $spec['title']]);
    foreach ($existing as $old) { $old->delete(); }

    $node = \\Drupal\\node\\Entity\\Node::create([
      'type' => $spec['type'],
      'title' => $spec['title'],
      'status' => 1,
      'body' => ['value' => $spec['body'], 'format' => $spec['bodyFormat']],
    ]);
    try {
      $node->set('moderation_state', 'published');
    } catch (\\Throwable $e) { /* bundle not moderated — published status is enough */ }
    $node->set('path', ['alias' => $spec['alias'], 'pathauto' => 0]);
    $node->save();
    $results[] = ['title' => $spec['title'], 'nid' => $node->id(), 'alias' => $spec['alias'], 'ok' => TRUE];
  } catch (\\Throwable $e) {
    $results[] = ['title' => $spec['title'] ?? '?', 'ok' => FALSE, 'error' => $e->getMessage()];
  }
}
\\Drupal::service('cache_tags.invalidator')->invalidateTags(['rendered', 'config:system.site']);
print(json_encode($results));
`;
writeFileSync(`${USWDS_REPO}/scripts/agent-planes/create-pages.php`, creatorPhp);

const write = await call("drush_dispatch", {
  args: ["php:script", "/var/www/html/scripts/agent-planes/create-pages.php"],
  timeout_ms: 60000,
});
let created = [];
try { created = JSON.parse(write.data?.stdout?.trim().split("\n").pop() ?? "[]"); } catch {}
for (const r of created) {
  log(`  ${r.ok ? "created" : "FAILED"} nid=${r.nid ?? "?"} ${r.alias} "${r.title}"${r.error ? " err=" + r.error : ""}`);
}

// ---------------------------------------------------------------------------
// Phase 3 — verify: never trust the commit.
// ---------------------------------------------------------------------------

log("== phase 3: verify (never trust the commit)");
const table = [];
for (const p of pages) {
  const probe = await call("verify_page", { url: SITE_URL + p.path });
  const v = probe.data ?? {};
  let marker = false;
  try {
    const res = await fetch(SITE_URL + p.path, { signal: AbortSignal.timeout(15000) });
    const html = await res.text();
    marker = html.includes(p.title);
  } catch {}
  table.push({ alias: p.path, verdict: v.verdict, http: v.httpStatus, bytes: v.byteSize, titleRendered: marker });
  log(`  ${p.path} → ${v.verdict} (HTTP ${v.httpStatus}, ${v.byteSize}B) title-rendered=${marker}`);
}

// Front page + config write verification through the planes.
log("== phase 3b: front page via config write");
await call("drush_dispatch", { args: ["cset", "system.site", "page.front", "/about-the-us"] });
const vc = await call("verify_config", { key: "system.site", expected: { page: { front: "/about-the-us" } } });
log(`  verify_config system.site page.front → ${vc.data?.verdict}`);
const home = await call("verify_page", { url: SITE_URL + "/" });
log(`  homepage → ${home.data?.verdict} (HTTP ${home.data?.httpStatus}, ${home.data?.byteSize}B)`);

await client.close();
log("== summary");
for (const row of table) log(`  ${row.alias.padEnd(22)} ${row.verdict} http=${row.http} bytes=${row.bytes} title=${row.titleRendered}`);
const allAlive = table.every((r) => r.verdict === "alive" && r.titleRendered);
log(allAlive ? "ALL 5 PAGES REBUILT AND VERIFIED" : "INCOMPLETE — see verdicts above");