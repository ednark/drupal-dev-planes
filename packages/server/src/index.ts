#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { callKnowledgeTool, connectKnowledge } from "@drupal-agent-planes/knowledge";
import {
  maskSecrets,
  normalizeConfigValue,
  normalizeModules,
  normalizeStatus,
  parseJsonLoose,
  runDrush,
} from "@drupal-agent-planes/state";
import { canonicalize, diffConfig, loadFailureModes, probePage } from "@drupal-agent-planes/verify";
import { loadConfig, type ServerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Envelope: every response names its plane, its status, and its provenance.
// ---------------------------------------------------------------------------

type Plane = "knowledge" | "state" | "verification" | "cross-plane";
type EnvelopeStatus = "ok" | "unavailable" | "state_unavailable" | "knowledge_unavailable" | "error";

function envelope(
  plane: Plane,
  status: EnvelopeStatus,
  data: unknown,
  provenance: Record<string, unknown>,
  notes: string[] = [],
): Record<string, unknown> {
  return { plane, status, data, notes, provenance };
}

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as { [x: string]: unknown },
  };
}

// ---------------------------------------------------------------------------
// Knowledge plane: lazy single connection to drupal-dev-mcp.
// ---------------------------------------------------------------------------

let knowledgePromise: Promise<Client> | null = null;

function getKnowledgeClient(config: ServerConfig): Promise<Client> | null {
  if (!config.drupalDevMcpCommand) return null;
  knowledgePromise ??= connectKnowledge({
    command: config.drupalDevMcpCommand,
    args: config.drupalDevMcpArgs,
    env: config.drupalDevMcpEnv,
  });
  return knowledgePromise;
}

async function knowledgeCall(
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

function drushProvenance(config: ServerConfig): Record<string, unknown> {
  return { source: "drush", bin: config.drushBin, siteRoot: config.siteRoot ?? "(cwd)" };
}

function drushConfig(config: ServerConfig) {
  return { bin: config.drushBin, root: config.siteRoot, timeoutMs: config.drushTimeoutMs };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readConfigObject(
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

// ---------------------------------------------------------------------------
// Server.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new McpServer({ name: "drupal-agent-planes", version: "0.1.0" });

  const READ_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;

  // ----- Knowledge plane (proxied from drupal-dev-mcp) -----

  server.registerTool(
    "get_index_status",
    {
      description: "Knowledge plane: drupal-dev-mcp index build readiness, versions, counts. Cite builtAt when freshness matters.",
      annotations: READ_ANNOTATIONS,
    },
    async () => textResult(await knowledgeCall(config, "get_index_status", {})),
  );

  server.registerTool(
    "search_drupal",
    {
      description: "Knowledge plane: cited evidence search across the versioned Drupal index (core docs, change records, contrib code).",
      inputSchema: {
        query: z.string().min(1),
        drupal_version: z.enum(["10.6", "11.4", "all"]).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ query, drupal_version, limit }) => {
      const args: Record<string, unknown> = { query };
      if (drupal_version) args.drupal_version = drupal_version;
      if (limit) args.limit = limit;
      return textResult(await knowledgeCall(config, "search_drupal", args));
    },
  );

  server.registerTool(
    "get_drupal_document",
    {
      description: "Knowledge plane: exact indexed text of a document or chunk — use to verify a citation without re-searching.",
      inputSchema: {
        document_id: z.string().min(1),
        chunk_id: z.string().optional(),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ document_id, chunk_id }) => {
      const args: Record<string, unknown> = { document_id };
      if (chunk_id) args.chunk_id = chunk_id;
      return textResult(await knowledgeCall(config, "get_drupal_document", args));
    },
  );

  // ----- State plane (drush-backed) -----

  server.registerTool(
    "get_site_status",
    {
      description: "State plane: normalized drush status — Drupal/PHP versions, site root, bootstrap.",
      annotations: READ_ANNOTATIONS,
    },
    async () => {
      const result = await runDrush(drushConfig(config), ["status", "--format=json"]);
      if (result.code !== 0) {
        return textResult(envelope("state", "state_unavailable", { stderr: result.stderr.slice(0, 500) }, drushProvenance(config)));
      }
      return textResult(envelope("state", "ok", normalizeStatus(parseJsonLoose(result.stdout)), drushProvenance(config)));
    },
  );

  server.registerTool(
    "get_site_config",
    {
      description: "State plane: read a config object or key from the live site (drush config:get), secrets masked. Never assume state — read it.",
      inputSchema: { key: z.string().min(1) },
      annotations: READ_ANNOTATIONS,
    },
    async ({ key }) => {
      const read = await readConfigObject(config, key);
      if (!read.ok) {
        return textResult(envelope("state", "state_unavailable", { key, stderr: read.stderr }, drushProvenance(config)));
      }
      return textResult(envelope("state", "ok", { key, value: maskSecrets(read.value) }, drushProvenance(config)));
    },
  );

  server.registerTool(
    "list_site_modules",
    {
      description: "State plane: normalized drush pm:list — machine names, versions, enabled/disabled.",
      inputSchema: { status: z.enum(["enabled", "disabled"]).optional() },
      annotations: READ_ANNOTATIONS,
    },
    async ({ status }) => {
      const result = await runDrush(drushConfig(config), ["pm:list", "--format=json"]);
      if (result.code !== 0) {
        return textResult(envelope("state", "state_unavailable", { stderr: result.stderr.slice(0, 500) }, drushProvenance(config)));
      }
      let modules = normalizeModules(parseJsonLoose(result.stdout));
      if (status) modules = modules.filter((m) => m.status === status);
      return textResult(envelope("state", "ok", { count: modules.length, modules }, drushProvenance(config)));
    },
  );

  server.registerTool(
    "drush_dispatch",
    {
      description: "State plane: run an explicit drush command (writes included). GATED — unavailable unless DRUPAL_AGENT_ALLOW_EXEC=true. Never trust the commit: follow every write with verify_config/verify_page.",
      inputSchema: {
        args: z.array(z.string()).min(1),
        timeout_ms: z.number().int().positive().max(120_000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ args, timeout_ms }) => {
      if (!config.allowExec) {
        return textResult(envelope("state", "unavailable", null, drushProvenance(config), [
          "drush_dispatch requires DRUPAL_AGENT_ALLOW_EXEC=true in the server env. Surface this to the user instead of attempting a workaround.",
        ]));
      }
      const result = await runDrush(drushConfig(config), args, timeout_ms);
      return textResult(envelope("state", result.code === 0 ? "ok" : "error", {
        command: args,
        exitCode: result.code,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 2000),
      }, { ...drushProvenance(config), gated: true }, [
        "Commit reported; delivery not yet verified. Follow with verify_config and/or verify_page before claiming success.",
      ]));
    },
  );

  // ----- Verification plane -----

  server.registerTool(
    "verify_config",
    {
      description: "Verification plane: read back a config object from the live site and diff against what you intended. Verdict first.",
      inputSchema: {
        key: z.string().min(1),
        expected: z.record(z.unknown()),
        include_extra: z.boolean().optional(),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ key, expected, include_extra }) => {
      const read = await readConfigObject(config, key);
      if (!read.ok) {
        return textResult(envelope("verification", "state_unavailable", { key, stderr: read.stderr }, drushProvenance(config)));
      }
      const actualObj = asObject(read.value);
      const diff = actualObj
        ? diffConfig(actualObj, expected, include_extra ?? false)
        : {
            verdict: canonicalize(read.value) === canonicalize(expected) ? "match" : "diff",
            missing: [],
            mismatched: canonicalize(read.value) === canonicalize(expected)
              ? []
              : [{ key: "(value)", expected, actual: read.value }],
            extra: [],
          };
      const notes = diff.verdict === "match"
        ? ["config matches — but config:get success is not evidence of delivery. See failure mode config-import-without-rebuild; follow with verify_page on an affected URL."]
        : ["diff detected — do not claim success. Fix and re-verify."];
      return textResult(envelope("verification", "ok", {
        key,
        verdict: diff.verdict,
        missing: diff.missing,
        mismatched: diff.mismatched,
        ...(include_extra ? { extra: diff.extra } : {}),
        actualPreview: canonicalize(actualObj ? maskSecrets(actualObj) : read.value).slice(0, 2000),
      }, drushProvenance(config), notes));
    },
  );

  server.registerTool(
    "verify_page",
    {
      description: "Verification plane: probe a delivered URL. 5xx = dead, Drupal critical-error marker = dead, 200 under 64 bytes = suspicious.",
      inputSchema: {
        url: z.string().url(),
        timeout_ms: z.number().int().positive().max(30_000).optional(),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ url, timeout_ms }) => {
      const probe = await probePage(url, timeout_ms ?? 10_000);
      const notes = probe.verdict === "alive"
        ? []
        : ["page did not deliver — see failure mode critical-error-page. A successful commit is not evidence of a working site."];
      return textResult(envelope("verification", "ok", probe, { source: "fetch", url }, notes));
    },
  );

  // ----- Cross-plane -----

  server.registerTool(
    "explain_config",
    {
      description: "Cross-plane join: the live value of a config key (state) plus knowledge-plane evidence about it, verdict-first.",
      inputSchema: {
        key: z.string().min(1),
        drupal_version: z.enum(["10.6", "11.4", "all"]).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ key, drupal_version }) => {
      const data: Record<string, unknown> = { key };
      const notes: string[] = [];
      let stateOk = false;
      let knowledgeOk = false;

      const read = await readConfigObject(config, key);
      if (read.ok) {
        data.state = { value: maskSecrets(read.value) };
        stateOk = true;
      } else {
        notes.push(`state plane unavailable: ${read.stderr}`);
      }

      const searchArgs: Record<string, unknown> = { query: key, limit: 3 };
      if (drupal_version) searchArgs.drupal_version = drupal_version;
      const knowledge = await knowledgeCall(config, "search_drupal", searchArgs);
      if (knowledge.status === "ok") {
        data.knowledge = knowledge.data;
        knowledgeOk = true;
      } else {
        notes.push(`knowledge plane unavailable: DRUPAL_DEV_MCP_COMMAND not configured`);
      }

      const status: EnvelopeStatus = stateOk && knowledgeOk ? "ok" : stateOk || knowledgeOk ? "ok" : "unavailable";
      return textResult(envelope(
        "cross-plane",
        status,
        data,
        { state: "drush", knowledge: "drupal-dev-mcp" },
        notes,
      ));
    },
  );

  server.registerTool(
    "list_failure_modes",
    {
      description: "Cross-plane: the Drupal silent-failure-mode catalog with per-row evidence status (claimed until swept).",
      inputSchema: { plane: z.enum(["knowledge", "state", "verification", "cross-plane"]).optional() },
      annotations: READ_ANNOTATIONS,
    },
    async ({ plane }) => {
      const all = loadFailureModes();
      const rows = plane ? all.filter((m) => m.plane === plane) : all;
      return textResult(envelope("cross-plane", "ok", { count: rows.length, failureModes: rows }, {
        source: "data/failure-modes.json",
        evidenceStatus: "seed — none swept yet",
      }));
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("drupal-agent-planes 0.1.0 listening on stdio");
}

main().catch((error) => {
  console.error("drupal-agent-planes failed to start:", error);
  process.exit(1);
});