// MCP client to drupal-agent-planes (smoke.mjs pattern). Every sweep runs its
// reproduce/detect steps through the plane tools — a sweep that bypasses the
// planes tests nothing about them (sweep-harness principle #3).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function connectPlanes(envOverrides = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(REPO_ROOT, "packages", "server", "dist", "index.js")],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // Inherit plane configuration from the caller's env (.env.example).
      // DRUPAL_AGENT_ALLOW_EXEC passes through unchanged: gated targets
      // require it to be explicitly true, and gated writes stay gated.
      ...process.env,
      ...envOverrides,
    },
  });
  const client = new Client({ name: "sweep", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

export async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { plane: null, status: "error", data: { raw: text.slice(0, 400) }, notes: [], provenance: {} };
  }
  return parsed;
}

/** Exit code from a dispatch envelope, with the raw fallback for diagnosis. */
export function exitOf(envelope) {
  const code = envelope?.data?.exitCode;
  if (typeof code === "number") return code;
  return "n/a";
}

/** Short diagnostic of an envelope whose expected fields are missing. */
export function envelopeDiag(envelope) {
  if (envelope?.data?.exitCode !== undefined) return "";
  const raw = JSON.stringify(envelope?.data ?? envelope).slice(0, 200);
  return ` [envelope: ${envelope?.status ?? "?"} ${raw}]`;
}

export async function closePlanes(client) {
  try {
    await client.close();
  } catch {
    // closing a half-connected client is not a sweep failure
  }
}
