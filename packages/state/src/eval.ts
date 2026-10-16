import { runDrush, parseJsonLoose, type DrushConfig } from "./drush.js";

/**
 * The planes reach Drupal through `drush php:eval` snippets that return a
 * single JSON value. Every payload crosses into PHP as base64, so no
 * quoting hazard exists between the agent's content and the snippet. This
 * is an implementation detail of the plane tools — the agent surface never
 * sees raw code, only semantic tools with catalog checks.
 */

export type EvalOutcome<T> = { ok: true; value: T } | { ok: false; stderr: string };

/** Encode a payload for safe transport into a PHP snippet. */
export function phpPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/**
 * Last parseable JSON line wins: drush may prepend notices or deprecation
 * warnings to stdout before the snippet's returned value.
 */
export function parseTrailingJson(stdout: string): unknown {
  const direct = parseJsonLoose(stdout);
  if (direct !== null) return direct;
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let candidate = (lines[i] ?? "").trim();
    // Strip terminal decoration drush can prefix output with (prompts,
    // spinners, list markers) before the JSON value on that line.
    candidate = candidate.replace(/^[>\-*#\s]+/, "").trim();
    const parsed = parseJsonLoose(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Transport for a shell-joined drush bin (ddev shims): ddev re-joins args
 * into a bash command inside the container, so the PHP code must contain
 * no shell-sensitive characters at all. Wrap the ENTIRE program in a
 * second base64 layer: the outer one-liner is $-free and quote-safe, and
 * bash never sees the payload. The program's own `return json_encode(...)`
 * becomes eval()'s return value, which drush prints as plain JSON.
 */
export function shellJoinedEvalArg(code: string): string {
  const encoded = Buffer.from(code, "utf8").toString("base64");
  return `return eval(base64_decode("${encoded}"));`;
}

export async function phpEval<T = unknown>(
  config: DrushConfig,
  code: string,
  timeoutMs?: number,
): Promise<EvalOutcome<T>> {
  const evalArg = config.shellJoined ? shellJoinedEvalArg(code) : code;
  const result = await runDrush(config, ["php:eval", evalArg], timeoutMs);
  if (result.code !== 0) {
    return {
      ok: false,
      stderr: (result.stderr.slice(0, 800) || `drush exited with code ${result.code}`),
    };
  }
  const parsed = parseTrailingJson(result.stdout);
  if (parsed === null) {
    return {
      ok: false,
      stderr: `php:eval output was not parseable JSON: ${result.stdout.slice(0, 200)}`,
    };
  }
  return { ok: true, value: parsed as T };
}
