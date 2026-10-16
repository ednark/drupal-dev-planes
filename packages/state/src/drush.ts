import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DrushConfig {
  bin: string;
  root?: string;
  timeoutMs?: number;
  /**
   * True when the drush bin routes args through a shell that re-joins them
   * (ddev shims do: `ddev exec drush ...` is re-parsed by bash inside the
   * container). Shell-sensitive arguments must then be pre-quoted by the
   * caller — see phpEval in packages/writes.
   */
  shellJoined?: boolean;
}

export interface DrushResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run drush. No shell interpolation: args are passed verbatim to execFile.
 * The site root, when configured, is passed as --root rather than relying on
 * the caller's working directory.
 */
export async function runDrush(
  config: DrushConfig,
  args: string[],
  timeoutMs?: number,
): Promise<DrushResult> {
  const fullArgs = config.root ? ["--root", config.root, ...args] : [...args];
  try {
    const { stdout, stderr } = await execFileAsync(config.bin, fullArgs, {
      timeout: timeoutMs ?? config.timeoutMs ?? 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      // An empty stderr hides the real failure ("" is not nullish), so fall
      // through to the spawn message (ENOENT, ETIMEDOUT, ...) when present.
      stderr:
        (err.stderr && err.stderr.length > 0 ? err.stderr : err.message) ??
        "drush invocation failed",
    };
  }
}

/** Parse JSON defensively; drush output can carry warnings or be empty. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}