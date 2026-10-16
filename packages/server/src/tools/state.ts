// Tool registrations for this plane. Helpers come from ../shared.js; the
// catalog preconditions and verification pairings live with each tool.

import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  checkRoute, findContent, findTerm, fetchFieldDefs, getWatchdog, listMenus, listRoles, listViews,
  maskSecrets, normalizeModules, normalizeStatus, parseJsonLoose, runDrush,
  WATCHDOG_SEVERITY_NAMES,
} from "@drupal-dev-planes/state";
import { type ServerConfig } from "../config.js";
import {
  envelope, textResult, stateUnavail, READ_ANNOTATIONS, drushProvenance, drushConfig,
  readConfigObject, ENTITY_TYPE_ENUM, parseEntityType,
} from "../shared.js";

export function registerStateToolRegistrations(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    "get_site_status",
    {
      description: "State plane: normalized drush status — Drupal/PHP versions, site root, bootstrap.",
      annotations: READ_ANNOTATIONS,
    },
    async () => {
      const result = await runDrush(drushConfig(config), ["status", "--format=json"]);
      if (result.code !== 0) {
        return textResult(stateUnavail(config, { stderr: result.stderr.slice(0, 500) }, drushProvenance(config)));
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
        return textResult(stateUnavail(config, { key, stderr: read.stderr }, drushProvenance(config)));
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
        return textResult(stateUnavail(config, { stderr: result.stderr.slice(0, 500) }, drushProvenance(config)));
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

  server.registerTool(
    "list_views",
    {
      description: "State plane: every view on the site — id, label, status, base table. Read before configuring or creating views.",
      annotations: READ_ANNOTATIONS,
    },
    async () => {
      const read = await listViews(drushConfig(config));
      if (!read.ok) {
        return textResult(stateUnavail(config, { stderr: read.stderr }, drushProvenance(config)));
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
        return textResult(stateUnavail(config, { stderr: read.stderr }, drushProvenance(config)));
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
        return textResult(stateUnavail(config, { stderr: read.stderr }, drushProvenance(config)));
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
        return textResult(stateUnavail(config, { stderr: read.stderr }, drushProvenance(config)));
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
        return textResult(stateUnavail(config, { stderr: read.stderr }, drushProvenance(config)));
      }
      return textResult(envelope("state", "ok", read.value, drushProvenance(config), read.value.exists
        ? []
        : ["no route matched — a reference to a non-existent route is a silent failure at render time"]));
    },
  );

  server.registerTool(
    "find_content",
    {
      description: "State plane: find content nodes by bundle and/or title (max 25) — read before creating or deleting so idempotency is a read, not a guess.",
      inputSchema: {
        bundle: z.string().optional(),
        title: z.string().optional(),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ bundle, title }) => {
      if (!bundle && !title) {
        return textResult(envelope("state", "error", null, drushProvenance(config), ["provide bundle and/or title"]));
      }
      const read = await findContent(drushConfig(config), { bundle, title });
      if (!read.ok) {
        return textResult(stateUnavail(config, { stderr: read.stderr }, drushProvenance(config)));
      }
      return textResult(envelope("state", "ok", { count: read.value.length, hits: read.value }, drushProvenance(config)));
    },
  );

  server.registerTool(
    "find_term",
    {
      description: "State plane: find taxonomy terms by vocabulary and/or name (max 25) — the read that resolves entity_reference target ids before create_content.",
      inputSchema: {
        vocabulary: z.string().optional(),
        name: z.string().optional(),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ vocabulary, name }) => {
      if (!vocabulary && !name) {
        return textResult(envelope("state", "error", null, drushProvenance(config), ["provide vocabulary and/or name"]));
      }
      const read = await findTerm(drushConfig(config), { vocabulary, name });
      if (!read.ok) {
        return textResult(stateUnavail(config, { stderr: read.stderr }, drushProvenance(config)));
      }
      return textResult(envelope("state", "ok", { count: read.value.length, terms: read.value }, drushProvenance(config)));
    },
  );

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
        return textResult(stateUnavail(config, { bundle, stderr: read.stderr }, drushProvenance(config)));
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
}
