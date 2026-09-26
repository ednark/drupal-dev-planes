import { z } from "zod";

const ConfigSchema = z.object({
  drupalDevMcpCommand: z.string().optional(),
  drupalDevMcpArgs: z.array(z.string()).default([]),
  drupalDevMcpEnv: z.record(z.string()).default({}),
  siteRoot: z.string().optional(),
  drushBin: z.string().default("drush"),
  drushTimeoutMs: z.number().int().positive().max(120_000).default(20_000),
  allowExec: z.boolean().default(false),
});

export type ServerConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const args = env.DRUPAL_DEV_MCP_ARGS
    ? env.DRUPAL_DEV_MCP_ARGS.split(/[\s,]+/).filter(Boolean)
    : [];

  const drupalDevMcpEnv: Record<string, string> = {};
  if (env.DRUPAL_MCP_INDEX_ROOT) {
    drupalDevMcpEnv.DRUPAL_MCP_INDEX_ROOT = env.DRUPAL_MCP_INDEX_ROOT;
  }

  return ConfigSchema.parse({
    drupalDevMcpCommand: env.DRUPAL_DEV_MCP_COMMAND,
    drupalDevMcpArgs: args,
    drupalDevMcpEnv,
    siteRoot: env.DRUPAL_SITE_ROOT,
    drushBin: env.DRUSH_BIN ?? "drush",
    allowExec: env.DRUPAL_AGENT_ALLOW_EXEC === "true",
  });
}