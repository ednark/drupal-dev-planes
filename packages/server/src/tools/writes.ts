// Tool registrations for this plane. Helpers come from ../shared.js; the
// catalog preconditions and verification pairings live with each tool.

import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { callKnowledgeTool, connectKnowledge } from "@drupal-dev-planes/knowledge";
import {
  checkRoute,
  findContent,
  findTerm,
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
import { loadConfig, type ServerConfig } from "../config.js";
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
  installModuleCheck,
  isEntityType,
  isFieldType,
  normalizeCreateContentTypeResult,
  normalizeAddFieldResult,
  placeBlock,
  readbackDisplayComponent,
  setDisplayComponent,
  setPermissions,
  type EntityType,
} from "@drupal-dev-planes/writes";

import {
  envelope,
  textResult,
  stateUnavail,
  READ_ANNOTATIONS,
  requireExecGate,
  drushProvenance,
  drushConfig,
  asObject,
  readConfigObject,
  ENTITY_TYPE_ENUM,
  parseEntityType,
  knowledgeCall,
} from "../shared.js";

export function registerWritesToolRegistrations(server: McpServer, config: ServerConfig): void {
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
        alias: z.string().optional(),
        moderation_state: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ entity_type, bundle, title, fields, published, alias, moderation_state }) => {
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
        const gapDefs = defs.value.filter((f) => gaps.includes(f.name));
        const refGaps = gapDefs.filter((f) => f.type === "entity_reference");
        const notes = [
          "Refused by catalog precondition: unpopulated-field-fatal (measured) — creating an entity without required fields took the site to HTTP 500 while the commit reported success.",
        ];
        if (refGaps.length > 0) {
          notes.push("entity_reference fields need a target id: resolve one with find_term (by vocabulary and/or name).");
          notes.push("If find_term finds no term, the field is UNSATISFIABLE on this site — do not retry; surface this to the user or create the term first.");
        }
        return textResult(envelope("writes", "refused", {
          bundle,
          missingRequired: gapDefs,
          requiredFields: defs.value.filter((f) => f.required).map((f) => f.name),
        }, drushProvenance(config), notes));
      }
      // Apply.
      const write = await createContent(drushConfig(config), {
        entity_type: parsed.entityType,
        bundle,
        title,
        published,
        fields,
        alias,
        moderationState: moderation_state,
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

  server.registerTool(
    "set_permissions",
    {
      description: "Writes plane: grant/revoke permissions on a role. Precondition: role exists, permissions are known to Drupal. Paired verification: list_roles read-back. GATED.",
      inputSchema: {
        role: z.string().min(1),
        grant: z.array(z.string()).default([]),
        revoke: z.array(z.string()).default([]),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ role, grant, revoke }) => {
      const gateNote = requireExecGate(config);
      if (gateNote) {
        return textResult(envelope("writes", "unavailable", null, drushProvenance(config), gateNote));
      }
      if (grant.length === 0 && revoke.length === 0) {
        return textResult(envelope("writes", "refused", null, drushProvenance(config), ["nothing to grant or revoke"]));
      }
      const write = await setPermissions(drushConfig(config), { role, grant, revoke });
      if (!write.ok) {
        return textResult(envelope("writes", "state_unavailable", { stderr: write.stderr }, drushProvenance(config)));
      }
      if (write.value.errors.length > 0) {
        return textResult(envelope("writes", "refused", { role, errors: write.value.errors }, drushProvenance(config), [
          "refused by precondition — fix the listed problems and retry",
        ]));
      }
      return textResult(envelope("writes", "ok", { role, granted: write.value.granted, revoked: write.value.revoked }, { ...drushProvenance(config), gated: true }, [
        "Commit reported; delivery NOT verified. Follow with list_roles read-back before claiming success.",
      ]));
    },
  );

  server.registerTool(
    "install_module",
    {
      description: "Writes plane: enable a module AFTER the dependency-safety scan — missing dependencies refuse (install-order class), missing service references refuse (undeclared-service-dependency class, measured). Paired verification: list_site_modules read-back. GATED.",
      inputSchema: {
        module: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ module }) => {
      const gateNote = requireExecGate(config);
      if (gateNote) {
        return textResult(envelope("writes", "unavailable", null, drushProvenance(config), gateNote));
      }
      // Catalog precondition scan — the guarded refusal the measured rows
      // (install-order-subscriber-crash, undeclared-service-dependency,
      // half-install-state) exist to prevent.
      const check = await installModuleCheck(drushConfig(config), module);
      if (!check.ok) {
        return textResult(envelope("writes", "state_unavailable", { stderr: check.stderr }, drushProvenance(config)));
      }
      const v = check.value;
      if (v.scanError) {
        const notFound = /not found/i.test(v.scanError);
        return textResult(envelope("writes", notFound ? "refused" : "state_unavailable", { module, scanError: v.scanError }, drushProvenance(config), [
          notFound ? `module '${module}' not found in the extension list` : `precondition scan failed: ${v.scanError}`,
        ]));
      }
      if (!v.exists) {
        return textResult(envelope("writes", "refused", { module }, drushProvenance(config), [`module '${module}' not found in the extension list`]));
      }
      if (v.enabled) {
        return textResult(envelope("writes", "refused", { module }, drushProvenance(config), [
          `module '${module}' is already enabled — read its state (list_site_modules) instead`,
        ]));
      }
      if (v.missingDependencies.length > 0 || v.missingServices.length > 0) {
        return textResult(envelope("writes", "refused", {
          module, missingDependencies: v.missingDependencies, missingServices: v.missingServices,
        }, drushProvenance(config), [
          "Refused by catalog precondition: enabling this module would crash the container compile (measured rows: install-order-subscriber-crash, undeclared-service-dependency, half-install-state — the failed enable HALF-COMMITS and bricks the next cache rebuild). Install/enable the missing dependencies first.",
        ]));
      }
      const enable = await runDrush(drushConfig(config), ["pm:enable", module, "-y"], 120_000);
      const readBack = await runDrush(drushConfig(config), ["pm:list", "--format=json"]);
      const modulesList = readBack.code === 0 ? normalizeModules(parseJsonLoose(readBack.stdout)) : [];
      const enabledNow = modulesList.some((m) => m.machineName === module && m.status === "enabled");
      if (enable.code !== 0) {
        return textResult(envelope("writes", "error", {
          module, exitCode: enable.code,
          halfCommitted: enabledNow,
          stderr: enable.stderr.slice(0, 400),
        }, { ...drushProvenance(config), gated: true }, [
          enabledNow
            ? "HALF-COMMIT: pm:enable fataled but the module is in core.extension — the next cache rebuild will fatal (measured half-install-state). Run the repair recipe before anything else."
            : "enable failed; the commit did not take.",
        ]));
      }
      return textResult(envelope("writes", "ok", { module }, { ...drushProvenance(config), gated: true }, [
        enabledNow
          ? "Enable reported and read-back confirms enabled. Verify further if the site serves the module's routes (verify_page)."
          : "Enable reported but read-back does NOT show the module enabled — do not claim success.",
      ]));
    },
  );

  server.registerTool(
    "place_block",
    {
      description: "Writes plane: place a block into a theme region. Preconditions: theme installed, region defined, block id unused. Paired verification: verify_page on an affected URL. GATED.",
      inputSchema: {
        id: z.string().regex(/^[a-z][a-z0-9_]*$/),
        plugin: z.string().min(1),
        theme: z.string().min(1),
        region: z.string().min(1),
        label: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, plugin, theme, region, label }) => {
      const gateNote = requireExecGate(config);
      if (gateNote) {
        return textResult(envelope("writes", "unavailable", null, drushProvenance(config), gateNote));
      }
      const write = await placeBlock(drushConfig(config), { id, plugin, theme, region, label });
      if (!write.ok) {
        return textResult(envelope("writes", "state_unavailable", { stderr: write.stderr }, drushProvenance(config)));
      }
      if (write.value.errors.length > 0) {
        return textResult(envelope("writes", "refused", { errors: write.value.errors }, drushProvenance(config), [
          "refused by precondition — the catalog row class here is 'block placed into a removed/undefined region', which renders fine until it doesn't",
        ]));
      }
      return textResult(envelope("writes", "ok", { block: write.value.block }, { ...drushProvenance(config), gated: true }, [
        "Commit reported; delivery NOT verified. Follow with verify_page (with `expected`) on an affected URL.",
      ]));
    },
  );

  server.registerTool(
    "configure_display",
    {
      description: "Writes plane: set or hide a field's formatter on a view mode. Preconditions: field exists on the bundle. Paired verification: read-back of the display component. GATED.",
      inputSchema: {
        entity_type: z.enum(["node", "taxonomy_term", "user", "media", "block_content"]),
        bundle: z.string().min(1),
        field_name: z.string().min(1),
        view_mode: z.string().default("default"),
        formatter: z.string().min(1).optional(),
        hidden: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ entity_type, bundle, field_name, view_mode, formatter, hidden }) => {
      const gateNote = requireExecGate(config);
      if (gateNote) {
        return textResult(envelope("writes", "unavailable", null, drushProvenance(config), gateNote));
      }
      if (!hidden && !formatter) {
        return textResult(envelope("writes", "refused", null, drushProvenance(config), ["formatter is required unless hidden=true"]));
      }
      const write = await setDisplayComponent(drushConfig(config), {
        entityType: entity_type, bundle, fieldName: field_name, viewMode: view_mode, formatter: formatter ?? "", hidden,
      });
      if (!write.ok) {
        return textResult(envelope("writes", "state_unavailable", { stderr: write.stderr }, drushProvenance(config)));
      }
      if (write.value.errors.length > 0) {
        return textResult(envelope("writes", "error", { errors: write.value.errors }, { ...drushProvenance(config), gated: true }, [
          "display save threw — do not claim success.",
        ]));
      }
      const read = await readbackDisplayComponent(drushConfig(config), { entityType: entity_type, bundle, fieldName: field_name, viewMode: view_mode });
      const present = read.ok ? read.value?.present === true : null;
      return textResult(envelope("writes", "ok", {
        field: field_name, viewMode: view_mode, hidden, readBack: { present, component: read.ok ? read.value?.component : null },
      }, { ...drushProvenance(config), gated: true }, [
        "Read-back performed — if it contradicts the intent, do not claim success.",
      ]));
    },
  );

  // ----- Cross-plane -----
}
