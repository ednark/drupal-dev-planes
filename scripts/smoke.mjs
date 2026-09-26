// Smoke test: spawn the server, list tools, and exercise the graceful-degradation
// paths (knowledge unconfigured, state unconfigured). Run: node scripts/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["packages/server/dist/index.js"],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DRUPAL_AGENT_ALLOW_EXEC: "false",
  },
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`tools registered: ${tools.tools.length}`);
for (const tool of tools.tools) {
  console.log(`  - ${tool.name} (readOnly=${tool.annotations?.readOnlyHint ?? "?"}, destructive=${tool.annotations?.destructiveHint ?? "?"})`);
}

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
  const parsed = JSON.parse(text);
  return parsed;
}

const failures = await call("list_failure_modes", {});
console.log(`\nlist_failure_modes -> plane=${failures.plane} status=${failures.status} rows=${failures.data.count} evidence=${failures.provenance.evidenceStatus}`);

const knowledge = await call("get_index_status", {});
console.log(`get_index_status   -> plane=${knowledge.plane} status=${knowledge.status} (expected: unavailable, no drupal-dev-mcp configured)`);

const state = await call("get_site_status", {});
console.log(`get_site_status    -> plane=${state.plane} status=${state.status}`);

const exec = await call("drush_dispatch", { args: ["cr"] });
console.log(`drush_dispatch     -> plane=${exec.plane} status=${exec.status} (expected: unavailable, gated)`);

await client.close();
console.log("\nsmoke test complete");