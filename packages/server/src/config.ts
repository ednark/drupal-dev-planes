import { z } from "zod";

const DEFAULT_DRUSH_TIMEOUT_MS =
  Number.parseInt(process.env.DRUSH_TIMEOUT_MS ?? "", 10) || 20_000;

const ConfigSchema = z.object({
  drupalDevMcpCommand: z.string().optional(),
  drupalDevMcpArgs: z.array(z.string()).default([]),
  drupalDevMcpEnv: z.record(z.string()).default({}),
  siteRoot: z.string().optional(),
  drushBin: z.string().default("drush"),
  drushTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(Math.min(DEFAULT_DRUSH_TIMEOUT_MS, 120_000)),
  /** ddev shim bins re-join args through a container shell. */
  drushShellJoined: z.boolean().default(false),
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
    drushShellJoined: env.DRUSH_SHELL_JOINED
      ? env.DRUSH_SHELL_JOINED === "true"
      : /ddev/i.test(env.DRUSH_BIN ?? ""),
    allowExec: env.DRUPAL_AGENT_ALLOW_EXEC === "true",
  });
}