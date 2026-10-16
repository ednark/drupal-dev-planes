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

export function registerKnowledgeToolRegistrations(server: McpServer, config: ServerConfig): void {
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
}
