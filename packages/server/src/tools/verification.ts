// Tool registrations for this plane. Helpers come from ../shared.js; the
// catalog preconditions and verification pairings live with each tool.

import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { maskSecrets, readbackEntity } from "@drupal-dev-planes/state";
import { canonicalize, diffConfig, diffEntityValues, probePage } from "@drupal-dev-planes/verify";
import { type ServerConfig } from "../config.js";
import {
  envelope, textResult, READ_ANNOTATIONS, drushProvenance, drushConfig, asObject,
  readConfigObject, ENTITY_TYPE_ENUM, parseEntityType,
} from "../shared.js";

export function registerVerificationToolRegistrations(server: McpServer, config: ServerConfig): void {
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
      description: "Verification plane: probe a delivered URL and return a delivery verdict. 5xx = server_error, Drupal critical-error marker = error_page, 4xx = http_error, empty/tiny body = suspicious_short, and (with `expected`) a delivered page missing the expected text = content_missing. Only a fully delivered page is `alive`. Verdict first.",
      inputSchema: {
        url: z.string().url(),
        timeout_ms: z.number().int().positive().max(30_000).optional(),
        expected: z.string().min(1).optional(),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ url, timeout_ms, expected }) => {
      const probe = await probePage(url, timeout_ms ?? 10_000, expected);
      const notes =
        probe.verdict === "alive"
          ? []
          : probe.verdict === "content_missing"
            ? [`content assertion FAILED: "${probe.expected?.needle}" is not on the delivered page — do not claim success; see failure mode silent-partial-delivery.`]
            : probe.verdict === "http_error"
              ? [`HTTP ${probe.httpStatus} is not a delivered page — a successful commit is not evidence of a working site.`]
              : ["page did not deliver — see failure mode critical-error-page. A successful commit is not evidence of a working site."];
      return textResult(envelope("verification", "ok", probe, { source: "fetch", url }, notes));
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
}
