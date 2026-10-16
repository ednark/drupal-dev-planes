#!/usr/bin/env node
// Composition root: one MCP server, one registration call per plane. The
// response envelope and shared transport helpers live in ./shared.ts; the
// tool registrations live in ./tools/<plane>.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerKnowledgeToolRegistrations } from "./tools/knowledge.js";
import { registerStateToolRegistrations } from "./tools/state.js";
import { registerVerificationToolRegistrations } from "./tools/verification.js";
import { registerWritesToolRegistrations } from "./tools/writes.js";
import { registerCrossPlaneToolRegistrations } from "./tools/cross_plane.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new McpServer({ name: "drupal-dev-planes", version: "0.1.0" });

  registerKnowledgeToolRegistrations(server, config);
  registerStateToolRegistrations(server, config);
  registerVerificationToolRegistrations(server, config);
  registerWritesToolRegistrations(server, config);
  registerCrossPlaneToolRegistrations(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("drupal-dev-planes 0.1.0 listening on stdio");
}

main().catch((error) => {
  console.error("drupal-dev-planes failed to start:", error);
  process.exit(1);
});
