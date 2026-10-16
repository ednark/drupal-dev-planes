import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Knowledge-plane client: connects to drupal-dev-mcp as a child MCP server
 * over stdio and proxies a minimal subset of its tools. drupal-dev-mcp keeps
 * its own trust boundary (read-only evidence, closed world); this package
 * owns only the transport.
 */
export interface KnowledgeClientConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  requestTimeoutMs?: number;
}

export interface KnowledgeCall {
  isError: boolean;
  structured?: unknown;
  text: string;
}

export type KnowledgeClient = Client;

const DEFAULT_TIMEOUT_MS = 20_000;

export async function connectKnowledge(
  config: KnowledgeClientConfig,
): Promise<KnowledgeClient> {
  const env: Record<string, string> = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  Object.assign(env, config.env ?? {});

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
  });
  const client = new Client({ name: "drupal-dev-planes", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

export async function callKnowledgeTool(
  client: KnowledgeClient,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<KnowledgeCall> {
  const result = await client.callTool(
    { name: tool, arguments: args },
    undefined,
    { timeout: timeoutMs },
  );
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  return {
    isError: result.isError === true,
    structured: result.structuredContent,
    text,
  };
}