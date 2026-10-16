#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { callKnowledgeTool, connectKnowledge } from "@drupal-dev-planes/knowledge";
import {
  checkRoute,
  getWatchdog,
  listMenus,
  listRoles,
  listViews,
  maskSecrets,
  normalizeConfigValue,
  normalizeModules,
  normalizeStatus,
  parseJsonLoose,
  runDrush,
  WATCHDOG_SEVERITY_NAMES,
} from "@drupal-dev-planes/state";
import {
  canonicalize,
  checkClaimSupport,
  CITATION_RE,
  diffConfig,
  loadFailureModes,
  probePage,
} from "@drupal-dev-planes/verify";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  createContent,
  createContentType,
  deleteContent,
  diffEntityValues,
  fetchFieldDefs,
  missingRequiredValues,
  nodeTypeExists,
  readbackEntity,
  addField,
  isEntityType,
  isFieldType,
  normalizeCreateContentTypeResult,
  normalizeAddFieldResult,
  type EntityType,
} from "@drupal-dev-planes/writes";

// ---------------------------------------------------------------------------
// Envelope: every response names its plane, its status, and its provenance.
// ---------------------------------------------------------------------------

type Plane = "knowledge" | "state" | "verification" | "writes" | "cross-plane";
type EnvelopeStatus =
  | "ok"
  | "unavailable"
  | "state_unavailable"
  | "knowledge_unavailable"
  | "refused"
  | "error";

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
  return { bin: config.drushBin, root: config.siteRoot, timeoutMs: config.drushTimeoutMs, shellJoined: config.drushShellJoined };
}

const ENTITY_TYPE_ENUM = ["node", "taxonomy_term", "user", "media", "block_content"] as const;

function parseEntityType(value: string): { ok: true; entityType: EntityType } | { ok: false } {
  return isEntityType(value) ? { ok: true, entityType: value } : { ok: false };
}

function requireExecGate(config: ServerConfig): string[] | null {
  return config.allowExec
    ? null
    : ["Write tools require DRUPAL_AGENT_ALLOW_EXEC=true in the server env. Surface this to the user instead of attempting a workaround."];
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
  const server = new McpServer({ name: "drupal-dev-planes", version: "0.1.0" });

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
      description: "Verification plane: probe a delivered URL. 5xx = dead, Drupal critical-error marker = dead, 200 under 64 bytes = suspicious. With `expected`, a delivered page MISSING the expected content is treated as not delivered (content assertion).",
      inputSchema: {
        url: z.string().url(),
        timeout_ms: z.number().int().positive().max(30_000).optional(),
        expected: z.string().min(1).optional(),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ url, timeout_ms, expected }) => {
      const probe = await probePage(url, timeout_ms ?? 10_000, expected);
      const notes = probe.verdict === "alive"
        ? (probe.expected && !probe.expected.present
            ? [`content assertion FAILED: "${probe.expected.needle}" is not on the delivered page — do not claim success; see failure mode silent-partial-delivery.`]
            : [])
        : ["page did not deliver — see failure mode critical-error-page. A successful commit is not evidence of a working site."];
      return textResult(envelope("verification", "ok", probe, { source: "fetch", url }, notes));
    },
  );

  // ----- State plane: Stage-B typed reads -----

  server.registerTool(
    "list_views",
    {
      description: "State plane: every view on the site — id, label, status, base table. Read before configuring or creating views.",
      annotations: READ_ANNOTATIONS,
    },
    async () => {
      const read = await listViews(drushConfig(config));
      if (!read.ok) {
        return textResult(envelope("state", "state_unavailable", { stderr: read.stderr }, drushProvenance(config)));
      }
      return textResult(envelope("state", "ok", { count: read.value.length, views: read.value }, drushProvenance(config)));
    },
  );

  server.registerTool(
    "list_menus",
    {
      description: "State plane: every menu — id, label, description. Read before adding menu links.",
      annotations: READ_ANNOTATIONS,
    },
    async () => {
      const read = await listMenus(drushConfig(config));
      if (!read.ok) {
        return textResult(envelope("state", "state_unavailable", { stderr: read.stderr }, drushProvenance(config)));
      }
      return textResult(envelope("state", "ok", { count: read.value.length, menus: read.value }, drushProvenance(config)));
    },
  );

  server.registerTool(
    "list_roles",
    {
      description: "State plane: every role with its permission list — read before set_permissions-class writes or access probing.",
      inputSchema: { permission: z.string().optional() },
      annotations: READ_ANNOTATIONS,
    },
    async ({ permission }) => {
      const read = await listRoles(drushConfig(config));
      if (!read.ok) {
        return textResult(envelope("state", "state_unavailable", { stderr: read.stderr }, drushProvenance(config)));
      }
      let roles = read.value;
      if (permission) roles = roles.filter((r) => r.permissions.includes(permission));
      return textResult(envelope("state", "ok", { count: roles.length, roles }, drushProvenance(config)));
    },
  );

  server.registerTool(
    "get_watchdog",
    {
      description: "State plane: 50 most recent watchdog entries (wid, severity, type, message, timestamp). The post-write check for silent fatals: new error-class entries after a write mean the commit lied.",
      inputSchema: { min_severity: z.number().int().min(0).max(7).optional() },
      annotations: READ_ANNOTATIONS,
    },
    async ({ min_severity }) => {
      const read = await getWatchdog(drushConfig(config));
      if (!read.ok) {
        return textResult(envelope("state", "state_unavailable", { stderr: read.stderr }, drushProvenance(config)));
      }
      let entries = read.value;
      if (min_severity !== undefined) entries = entries.filter((e) => e.severity <= min_severity);
      return textResult(envelope("state", "ok", {
        count: entries.length,
        entries: entries.map((e) => ({ ...e, severityName: WATCHDOG_SEVERITY_NAMES[e.severity] ?? String(e.severity) })),
      }, drushProvenance(config), entries.length > 0
        ? ["watchdog is not empty — check for new entries timestamped after your write before claiming success"]
        : []));
    },
  );

  server.registerTool(
    "check_route",
    {
      description: "State plane: does a route exist for a path pattern (or exact route name), and what does it require? Read before referencing a route.",
      inputSchema: {
        pattern: z.string().optional(),
        name: z.string().optional(),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ pattern, name }) => {
      if (!pattern && !name) {
        return textResult(envelope("state", "error", null, drushProvenance(config), ["provide pattern or name"]));
      }
      const read = await checkRoute(drushConfig(config), { pattern, name });
      if (!read.ok) {
        return textResult(envelope("state", "state_unavailable", { stderr: read.stderr }, drushProvenance(config)));
      }
      return textResult(envelope("state", "ok", read.value, drushProvenance(config), read.value.exists
        ? []
        : ["no route matched — a reference to a non-existent route is a silent failure at render time"]));
    },
  );

  // ----- Writes plane (guarded semantic writes; gated) -----

  server.registerTool(
    "get_bundle_fields",
    {
      description: "State plane: field definitions for an entity bundle — name, type, required, cardinality. Read before any create/write: required fields you leave empty brick the site (failure mode unpopulated-field-fatal, measured).",
      inputSchema: {
        entity_type: z.enum(ENTITY_TYPE_ENUM).default("node"),
        bundle: z.string().min(1),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ entity_type, bundle }) => {
      const parsed = parseEntityType(entity_type);
      if (!parsed.ok) {
        return textResult(envelope("state", "error", { entity_type }, drushProvenance(config), [`unknown entity type ${entity_type}`]));
      }
      const read = await fetchFieldDefs(drushConfig(config), parsed.entityType, bundle);
      if (!read.ok) {
        return textResult(envelope("state", "state_unavailable", { bundle, stderr: read.stderr }, drushProvenance(config)));
      }
      const required = read.value.filter((f) => f.required).map((f) => f.name);
      return textResult(envelope("state", "ok", {
        bundle,
        count: read.value.length,
        requiredFields: required,
        fields: read.value,
      }, drushProvenance(config), required.length > 0
        ? [`required fields: ${required.join(", ")} — create_content refuses to write without them`]
        : []));
    },
  );

  server.registerTool(
    "create_content",
    {
      description: "Writes plane: create a content entity through a catalog-checked write — refuses to create an entity with unpopulated required fields (unpopulated-field-fatal, measured), applies, then the result carries the paired verification contract. GATED.",
      inputSchema: {
        entity_type: z.enum(ENTITY_TYPE_ENUM).default("node"),
        bundle: z.string().min(1),
        title: z.string().min(1),
        fields: z.record(z.unknown()).default({}),
        published: z.boolean().default(true),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ entity_type, bundle, title, fields, published }) => {
      const gateNote = requireExecGate(config);
      if (gateNote) {
        return textResult(envelope("writes", "unavailable", null, drushProvenance(config), gateNote));
      }
      const parsed = parseEntityType(entity_type);
      if (!parsed.ok) {
        return textResult(envelope("writes", "refused", { entity_type }, drushProvenance(config), [`unknown entity type ${entity_type}`]));
      }
      // Catalog precondition (measured row: unpopulated-field-fatal).
      const defs = await fetchFieldDefs(drushConfig(config), parsed.entityType, bundle);
      if (!defs.ok) {
        return textResult(envelope("writes", "state_unavailable", { bundle, stderr: defs.stderr }, drushProvenance(config)));
      }
      const provided: Record<string, unknown> = { title, ...fields };
      const gaps = missingRequiredValues(defs.value, provided);
      if (gaps.length > 0) {
        return textResult(envelope("writes", "refused", {
          bundle,
          missingRequired: gaps,
          requiredFields: defs.value.filter((f) => f.required).map((f) => f.name),
        }, drushProvenance(config), [
          "Refused by catalog precondition: unpopulated-field-fatal (measured) — creating an entity without required fields took the site to HTTP 500 while the commit reported success. Populate the missing fields and retry.",
        ]));
      }
      // Apply.
      const write = await createContent(drushConfig(config), {
        entity_type: parsed.entityType,
        bundle,
        title,
        published,
        fields,
      });
      if (!write.ok) {
        return textResult(envelope("writes", "state_unavailable", { bundle, stderr: write.stderr }, drushProvenance(config)));
      }
      if (write.value.errors.length > 0) {
        return textResult(envelope("writes", "error", { bundle, errors: write.value.errors }, {
          ...drushProvenance(config), gated: true,
        }, ["entity save threw — nothing was written successfully; do not claim success."]));
      }
      return textResult(envelope("writes", "ok", {
        id: write.value.id,
        uuid: write.value.uuid,
        bundle: write.value.bundle,
        revert: { tool: "delete_content", args: { entity_type: entity_type, uuid: write.value.uuid } },
      }, { ...drushProvenance(config), gated: true }, [
        "Commit reported; delivery NOT verified. Follow with verify_entity (read-back), then verify_page on the entity's URL, before claiming success.",
      ]));
    },
  );

  server.registerTool(
    "verify_entity",
    {
      description: "Verification plane: read back a content entity and diff against what you intended. Verdict first. Scalar expected values are compared loosely against the first field delta; exact delta arrays compare exactly.",
      inputSchema: {
        entity_type: z.enum(ENTITY_TYPE_ENUM).default("node"),
        id: z.number().int().positive().optional(),
        uuid: z.string().optional(),
        expected: z.record(z.unknown()),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ entity_type, id, uuid, expected }) => {
      const parsed = parseEntityType(entity_type);
      if (!parsed.ok) {
        return textResult(envelope("verification", "error", { entity_type }, drushProvenance(config), [`unknown entity type ${entity_type}`]));
      }
      if (!id && !uuid) {
        return textResult(envelope("verification", "error", null, drushProvenance(config), ["provide id or uuid"]));
      }
      const read = await readbackEntity(drushConfig(config), parsed.entityType, id ?? null, uuid ?? null);
      if (!read.ok) {
        return textResult(envelope("verification", "state_unavailable", { stderr: read.stderr }, drushProvenance(config)));
      }
      if (!read.value.found) {
        return textResult(envelope("verification", "ok", { verdict: "not_found", entity_type, id, uuid }, drushProvenance(config), [
          "entity does not exist — the write did not take effect, or was never committed.",
        ]));
      }
      const diff = diffEntityValues(read.value, expected);
      const notes = diff.verdict === "match"
        ? ["entity matches expected — config/content in place. Still follow with verify_page: delivery is the page, not the row."]
        : ["diff detected — do not claim success. Fix and re-verify."];
      return textResult(envelope("verification", "ok", {
        verdict: diff.verdict,
        id: read.value.id,
        uuid: read.value.uuid,
        bundle: read.value.bundle,
        label: read.value.label,
        published: read.value.published,
        missing: diff.missing,
        mismatched: diff.mismatched,
        looseCompared: diff.loose,
      }, drushProvenance(config), notes));
    },
  );

  server.registerTool(
    "delete_content",
    {
      description: "Writes plane: delete content entities by id or uuid — the declared revert path for create_content. GATED.",
      inputSchema: {
        entity_type: z.enum(ENTITY_TYPE_ENUM).default("node"),
        ids: z.array(z.number().int().positive()).optional(),
        uuid: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ entity_type, ids, uuid }) => {
      const gateNote = requireExecGate(config);
      if (gateNote) {
        return textResult(envelope("writes", "unavailable", null, drushProvenance(config), gateNote));
      }
      const parsed = parseEntityType(entity_type);
      if (!parsed.ok) {
        return textResult(envelope("writes", "refused", { entity_type }, drushProvenance(config), [`unknown entity type ${entity_type}`]));
      }
      if ((!ids || ids.length === 0) && !uuid) {
        return textResult(envelope("writes", "refused", null, drushProvenance(config), ["provide ids or uuid — refusing to delete without an explicit target"]));
      }
      const del = await deleteContent(drushConfig(config), parsed.entityType, ids ?? [], uuid ?? null);
      if (!del.ok) {
        return textResult(envelope("writes", "state_unavailable", { stderr: del.stderr }, drushProvenance(config)));
      }
      return textResult(envelope("writes", del.value.deleted > 0 && del.value.errors.length === 0 ? "ok" : "error", {
        deleted: del.value.deleted,
        errors: del.value.errors,
      }, { ...drushProvenance(config), gated: true }, del.value.deleted > 0
        ? ["deletion reported; if this reverted a create, verify with verify_entity expecting verdict not_found."]
        : ["nothing deleted — check the target ids/uuid."]));
    },
  );

  server.registerTool(
    "create_content_type",
    {
      description: "Writes plane: create a node content type (bundle). Precondition: type must not already exist; paired verification is the read-back via get_bundle_fields. GATED.",
      inputSchema: {
        bundle: z.string().regex(/^[a-z][a-z0-9_]*$/, "machine name: lowercase letters, digits, underscore"),
        label: z.string().min(1),
        description: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ bundle, label, description }) => {
      const gateNote = requireExecGate(config);
      if (gateNote) {
        return textResult(envelope("writes", "unavailable", null, drushProvenance(config), gateNote));
      }
      // Precondition (read, not guess): the type must not already exist.
      const exists = await nodeTypeExists(drushConfig(config), bundle);
      if (!exists.ok) {
        return textResult(envelope("writes", "state_unavailable", { bundle, stderr: exists.stderr }, drushProvenance(config)));
      }
      if (exists.value) {
        return textResult(envelope("writes", "refused", { bundle }, drushProvenance(config), [
          `node type '${bundle}' already exists — read it (get_bundle_fields) before writing; a duplicate create is a silent no-op at best`,
        ]));
      }
      const write = await createContentType(drushConfig(config), { bundle, label, description });
      if (!write.ok) {
        return textResult(envelope("writes", "state_unavailable", { bundle, stderr: write.stderr }, drushProvenance(config)));
      }
      if (write.value.errors.length > 0) {
        return textResult(envelope("writes", "error", { bundle, errors: write.value.errors }, { ...drushProvenance(config), gated: true }, [
          "node type save threw — nothing was written successfully; do not claim success.",
        ]));
      }
      return textResult(envelope("writes", "ok", {
        bundle: write.value.type,
        revert: { tool: "drush_dispatch", hint: "config delete or node type entity delete — declare the mutation before proceeding" },
      }, { ...drushProvenance(config), gated: true }, [
        "Commit reported; delivery NOT verified. Follow with get_bundle_fields (read-back: the bundle must list its base fields) before creating content in it.",
      ]));
    },
  );

  server.registerTool(
    "add_field",
    {
      description: "Writes plane: add a field to a node content type (storage + instance). Precondition: bundle exists and field not already present. Paired verification: get_bundle_fields read-back shows the field with the expected type/required. GATED.",
      inputSchema: {
        bundle: z.string().min(1),
        field_name: z.string().regex(/^field_[a-z0-9_]+$/, "field machine names must start with field_"),
        field_type: z.enum(["string", "string_long", "text", "text_long", "text_with_summary", "integer", "decimal", "boolean", "datetime", "link", "entity_reference", "list_string", "list_integer", "email", "telephone", "timestamp"]),
        label: z.string().min(1),
        required: z.boolean().default(false),
        cardinality: z.number().int().min(-1).default(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ bundle, field_name, field_type, label, required, cardinality }) => {
      const gateNote = requireExecGate(config);
      if (gateNote) {
        return textResult(envelope("writes", "unavailable", null, drushProvenance(config), gateNote));
      }
      if (!isFieldType(field_type)) {
        return textResult(envelope("writes", "refused", { field_type }, drushProvenance(config), [`unsupported field type ${field_type}`]));
      }
      // Preconditions: bundle exists, field does not.
      const typeExists = await nodeTypeExists(drushConfig(config), bundle);
      if (!typeExists.ok) {
        return textResult(envelope("writes", "state_unavailable", { bundle, stderr: typeExists.stderr }, drushProvenance(config)));
      }
      if (!typeExists.value) {
        return textResult(envelope("writes", "refused", { bundle }, drushProvenance(config), [
          `node type '${bundle}' does not exist — creating a field on a missing bundle fatals at the next container rebuild (failure mode undeclared-service-dependency class). Create the type first.`,
        ]));
      }
      const defs = await fetchFieldDefs(drushConfig(config), "node", bundle);
      if (!defs.ok) {
        return textResult(envelope("writes", "state_unavailable", { bundle, stderr: defs.stderr }, drushProvenance(config)));
      }
      if (defs.value.some((f) => f.name === field_name)) {
        return textResult(envelope("writes", "refused", { bundle, field_name }, drushProvenance(config), [
          `field '${field_name}' already exists on '${bundle}' — read it before changing it`,
        ]));
      }
      const write = await addField(drushConfig(config), {
        bundle, fieldName: field_name, fieldType: field_type, label, required, cardinality,
      });
      if (!write.ok) {
        return textResult(envelope("writes", "state_unavailable", { bundle, stderr: write.stderr }, drushProvenance(config)));
      }
      if (write.value.errors.length > 0) {
        return textResult(envelope("writes", "error", { bundle, errors: write.value.errors }, { ...drushProvenance(config), gated: true }, [
          "field save threw — check whether the storage was created (half-commit: storage may exist without the instance); do not claim success.",
        ]));
      }
      return textResult(envelope("writes", "ok", {
        bundle, field: write.value.field,
      }, { ...drushProvenance(config), gated: true }, [
        required
          ? "Commit reported; delivery NOT verified. REQUIRED field: content created without it will be refused by create_content (unpopulated-field-fatal is the measured class this prevents)."
          : "Commit reported; delivery NOT verified.",
        "Follow with get_bundle_fields read-back — the field must appear with the expected type and required flag.",
      ]));
    },
  );

  // ----- Cross-plane -----

  server.registerTool(
    "check_claim_support",
    {
      description: "Verification plane: does the cited evidence actually SUPPORT the answer's claims? Deterministic value-presence + version-assertion + subject-proximity checks per claim. Catches confident-wrong answers whose citations resolve but do not support.",
      inputSchema: {
        answer: z.string().min(1),
        proximity_chars: z.number().int().positive().max(2000).optional(),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ answer, proximity_chars }) => {
      // Resolve every cited document through the knowledge plane.
      const ids = [...new Set([...answer.matchAll(CITATION_RE)].map((m) => m[1] ?? "").filter((s) => s !== ""))];
      const docs: Record<string, string> = {};
      let unresolved = 0;
      for (const id of ids) {
        const doc = await knowledgeCall(config, "get_drupal_document", { document_id: id });
        if (doc.status === "ok" && typeof (doc.data as { text?: unknown })?.text === "string") {
          docs[id] = (doc.data as { text: string }).text;
        } else {
          unresolved++;
        }
      }
      const report = checkClaimSupport(answer, docs, proximity_chars ? { proximityChars: proximity_chars } : {});
      const notes = report.verdict === "unsupported"
        ? ["unsupported claims found — do not accept this answer; re-ground or answer without the claim."]
        : report.verdict === "weak"
          ? ["weak support — values present but far from the claim's subject terms."]
          : report.verdict === "uncited"
            ? ["answer carries no drupal:// citations; nothing to check mechanically."]
            : [];
      if (unresolved > 0) notes.push(`${unresolved} cited document(s) could not be resolved through the knowledge plane.`);
      notes.push("claim-support is presence/proximity evidence, not semantic entailment; treat 'supported' as necessary, not sufficient.");
      return textResult(envelope("verification", "ok", {
        verdict: report.verdict,
        counts: report.counts,
        claims: report.claims.slice(0, 20),
      }, { source: "deterministic checks + drupal-dev-mcp document texts", checkedClaims: report.claims.length }, notes));
    },
  );

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
      inputSchema: { plane: z.enum(["knowledge", "state", "verification", "writes", "cross-plane"]).optional() },
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
  console.error("drupal-dev-planes 0.1.0 listening on stdio");
}

main().catch((error) => {
  console.error("drupal-dev-planes failed to start:", error);
  process.exit(1);
});