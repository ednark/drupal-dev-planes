import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DrushConfig {
  bin: string;
  root?: string;
  timeoutMs?: number;
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
      stderr: err.stderr ?? err.message ?? "drush invocation failed",
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