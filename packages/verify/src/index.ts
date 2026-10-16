import { Buffer } from "node:buffer";

/** Canonical string form with sorted object keys, for stable comparisons. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return (
    "{" +
    entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalize(v)).join(",") +
    "}"
  );
}

export interface ConfigDiff {
  verdict: "match" | "diff";
  missing: string[];
  mismatched: Array<{ key: string; expected: unknown; actual: unknown }>;
  extra: string[];
}

type DiffCtx = Pick<ConfigDiff, "missing" | "mismatched">;

/** Recursive SUBSET check: every expected key must exist and match; extra siblings are fine. */
function compareSubset(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  path: string,
  ctx: DiffCtx,
): void {
  for (const [key, want] of Object.entries(expected)) {
    const p = path ? `${path}.${key}` : key;
    const have = actual[key];
    if (want !== null && typeof want === "object" && !Array.isArray(want)) {
      if (have === undefined) {
        ctx.missing.push(p);
        continue;
      }
      if (have !== null && typeof have === "object" && !Array.isArray(have)) {
        compareSubset(have as Record<string, unknown>, want as Record<string, unknown>, p, ctx);
      } else {
        ctx.mismatched.push({ key: p, expected: want, actual: have });
      }
    } else if (!(key in actual)) {
      ctx.missing.push(p);
    } else if (canonicalize(have) !== canonicalize(want)) {
      ctx.mismatched.push({ key: p, expected: want, actual: have });
    }
  }
}

/** Top-level diff of expected keys against the actual config object. */
export function diffConfig(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  includeExtra = false,
): ConfigDiff {
  const missing: string[] = [];
  const mismatched: ConfigDiff["mismatched"] = [];
  compareSubset(actual, expected, "", { missing, mismatched });
  const extra = includeExtra
    ? Object.keys(actual).filter((k) => !(k in expected))
    : [];
  const verdict =
    missing.length === 0 && mismatched.length === 0 ? "match" : "diff";
  return { verdict, missing, mismatched, extra };
}

export type PageVerdict =
  | "alive"
  | "content_missing"
  | "error_page"
  | "server_error"
  | "http_error"
  | "suspicious_short"
  | "fetch_failed";

export interface PageProbeResult {
  verdict: PageVerdict;
  httpStatus: number;
  byteSize: number;
  detail: string;
  /** Content assertion (analysis-1 P1): present only when `expected` is given. */
  expected?: { needle: string; present: boolean };
}

/**
 * A delivered page is the only evidence of delivery. The verdict distinguishes
 * TRANSPORT success (a response came back) from DELIVERY success (the right
 * page arrived), so an agent never has to override `alive` by reading another
 * field. Precedence, most-severe first:
 *   server_error (5xx) > error_page (Drupal critical-error marker) >
 *   http_error (4xx) > suspicious_short (empty/tiny body) >
 *   content_missing (delivered but the expected text is absent) > alive.
 * Thresholds adapted from mosaic-headless's measured practice; re-measured
 * against the live fixture (sweep record: critical-error-page).
 */
export function interpretPageProbe(
  httpStatus: number,
  body: string,
  expected?: string,
): PageProbeResult {
  const byteSize = Buffer.byteLength(body, "utf8");
  const assertion = expected
    ? { needle: expected, present: body.includes(expected) }
    : undefined;
  if (httpStatus >= 500) {
    return {
      verdict: "server_error",
      httpStatus,
      byteSize,
      detail: "5xx treated as a dead page regardless of body content",
      expected: assertion,
    };
  }
  if (/The website encountered an unexpected error/i.test(body)) {
    return {
      verdict: "error_page",
      httpStatus,
      byteSize,
      detail: "Drupal critical-error screen detected",
      expected: assertion,
    };
  }
  if (httpStatus >= 400) {
    return {
      verdict: "http_error",
      httpStatus,
      byteSize,
      detail: `${httpStatus} is not a delivered page (404 = missing, 403 = access denied) — do not treat as alive`,
      expected: assertion,
    };
  }
  if (byteSize < 64) {
    return {
      verdict: "suspicious_short",
      httpStatus,
      byteSize,
      detail: "delivered body is empty or under 64 bytes — matches the tiny-error-string failure mode",
      expected: assertion,
    };
  }
  if (assertion && !assertion.present) {
    return {
      verdict: "content_missing",
      httpStatus,
      byteSize,
      detail: `page delivered but the expected content "${assertion.needle}" is MISSING — treat as not delivered`,
      expected: assertion,
    };
  }
  return { verdict: "alive", httpStatus, byteSize, detail: "page delivered", expected: assertion };
}

export async function probePage(
  url: string,
  timeoutMs = 10_000,
  expected?: string,
): Promise<PageProbeResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
  } catch (error) {
    return {
      verdict: "fetch_failed",
      httpStatus: 0,
      byteSize: 0,
      detail: `fetch failed: ${(error as Error).message}`,
    };
  }
  const body = await response.text();
  return interpretPageProbe(response.status, body, expected);
}

export { loadFailureModes, type FailureMode, type Plane } from "./catalog.js";
export {
  checkClaimSupport,
  stripCodeBlocks,
  splitSentences,
  extractValues,
  extractSubjects,
  CITATION_RE,
  type ClaimRow,
  type ClaimSupportReport,
  type ClaimVerdict,
  type SupportOptions,
} from "./claims.js";