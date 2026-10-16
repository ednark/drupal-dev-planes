// Tool registrations for this plane. Helpers come from ../shared.js; the
// catalog preconditions and verification pairings live with each tool.

import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkClaimSupport, CITATION_RE, loadFailureModes } from "@drupal-dev-planes/verify";
import { type ServerConfig } from "../config.js";
import { envelope, textResult, READ_ANNOTATIONS, knowledgeCall } from "../shared.js";

export function registerCrossPlaneToolRegistrations(server: McpServer, config: ServerConfig): void {
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
    "list_failure_modes",
    {
      description: "Cross-plane: the Drupal silent-failure-mode catalog with per-row evidence status (claimed until swept).",
      inputSchema: { plane: z.enum(["knowledge", "state", "verification", "writes", "cross-plane"]).optional() },
      annotations: READ_ANNOTATIONS,
    },
    async ({ plane }) => {
      const all = loadFailureModes();
      const rows = plane ? all.filter((m) => m.plane === plane) : all;
      const measured = all.filter((m) => m.evidenceStatus === "measured").length;
      return textResult(envelope("cross-plane", "ok", { count: rows.length, failureModes: rows }, {
        source: "data/failure-modes.json",
        evidenceStatus: `${measured}/${all.length} rows measured — graduate status is enforced by npm run sweep:gate`,
      }));
    },
  );
}
