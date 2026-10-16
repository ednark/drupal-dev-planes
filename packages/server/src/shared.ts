// Shared server helpers: the response envelope, transport plumbing, and the
// client for the knowledge plane (drupal-dev-mcp). Tool registration lives in
// ./tools/*.ts, one module per plane; this is what they share.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callKnowledgeTool, connectKnowledge } from "@drupal-dev-planes/knowledge";
import {
  ENTITY_TYPES,
  isEntityType,
  normalizeConfigValue,
  parseJsonLoose,
  runDrush,
  type EntityType,
} from "@drupal-dev-planes/state";
import { type ServerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Envelope: every response names its plane, its status, and its provenance.
// ---------------------------------------------------------------------------

export const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export type Plane = "knowledge" | "state" | "verification" | "writes" | "cross-plane";
export type EnvelopeStatus =
  | "ok"
  | "unavailable"
  | "state_unavailable"
  | "knowledge_unavailable"
  | "refused"
  | "error";

export function envelope(
  plane: Plane,
  status: EnvelopeStatus,
  data: unknown,
  provenance: Record<string, unknown>,
  notes: string[] = [],
): Record<string, unknown> {
  return { plane, status, data, notes, provenance };
}

export function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as { [x: string]: unknown },
  };
}

// ---------------------------------------------------------------------------
// Knowledge plane: lazy single connection to drupal-dev-mcp.
// ---------------------------------------------------------------------------

let knowledgePromise: Promise<Client> | null = null;

export function getKnowledgeClient(config: ServerConfig): Promise<Client> | null {
  if (!config.drupalDevMcpCommand) return null;
  knowledgePromise ??= connectKnowledge({
    command: config.drupalDevMcpCommand,
    args: config.drupalDevMcpArgs,
    env: config.drupalDevMcpEnv,
  });
  return knowledgePromise;
}

export async function knowledgeCall(
  config: ServerConfig,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const pending = getKnowledgeClient(config);
  if (!pending) {
    return envelope(
      "knowledge",
      "unavailable",
      null,
      {},
      ["DRUPAL_DEV_MCP_COMMAND is not configured; knowledge tools degrade to unavailable while state and verification keep working."],
    );
  }
  try {
    const client = await pending;
    const result = await callKnowledgeTool(client, tool, args);
    if (result.isError) {
      return envelope(
        "knowledge",
        "error",
        { upstream: result.text.slice(0, 2000) },
        { source: "drupal-dev-mcp" },
      );
    }
    return envelope("knowledge", "ok", result.structured ?? { text: result.text }, {
      source: "drupal-dev-mcp",
    });
  } catch (error) {
    knowledgePromise = null; // allow a later retry after a failed connect
    return envelope(
      "knowledge",
      "knowledge_unavailable",
      null,
      {},
      [`knowledge plane unreachable: ${(error as Error).message}`],
    );
  }
}

// ---------------------------------------------------------------------------
// State plane helpers.
// ---------------------------------------------------------------------------

export function drushProvenance(config: ServerConfig): Record<string, unknown> {
  return { source: "drush", bin: config.drushBin, siteRoot: config.siteRoot ?? "(cwd)" };
}

export function drushConfig(config: ServerConfig) {
  return { bin: config.drushBin, root: config.siteRoot, timeoutMs: config.drushTimeoutMs, shellJoined: config.drushShellJoined };
}

export const ENTITY_TYPE_ENUM = ENTITY_TYPES;

export function parseEntityType(value: string): { ok: true; entityType: EntityType } | { ok: false } {
  return isEntityType(value) ? { ok: true, entityType: value } : { ok: false };
}

export function requireExecGate(config: ServerConfig): string[] | null {
  return config.allowExec
    ? null
    : ["Write tools require DRUPAL_AGENT_ALLOW_EXEC=true in the server env. Surface this to the user instead of attempting a workaround."];
}

/**
 * state_unavailable with a recovery hint: an agent seeing only a raw stderr
 * has no next move. Every state_unavailable response tells it what to check.
 */
export function stateUnavail(config: ServerConfig, data: unknown, provenance: Record<string, unknown>, notes: string[] = []): Record<string, unknown> {
  return envelope("state", "state_unavailable", data, provenance, [
    ...notes,
    "the state plane cannot reach the site — check DRUSH_BIN / DDEV_PROJECT and that the site's docker/daemon is running; surface this to the user rather than guessing",
  ]);
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function readConfigObject(
  config: ServerConfig,
  key: string,
): Promise<{ ok: true; value: unknown } | { ok: false; stderr: string }> {
  const result = await runDrush(drushConfig(config), ["config:get", key, "--format=json"]);
  if (result.code !== 0) {
    return { ok: false, stderr: result.stderr.slice(0, 500) };
  }
  const parsed = parseJsonLoose(result.stdout);
  return parsed === null
    ? { ok: false, stderr: "config:get output was not parseable JSON" }
    : { ok: true, value: normalizeConfigValue(parsed, undefined) };
}
