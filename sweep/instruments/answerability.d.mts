/**
 * Type declarations for the answerability instrument (plain JS). The TS test
 * suite imports `scoreAnswer`; these declarations keep `npm run typecheck`
 * green without converting the sweep harness to TypeScript.
 */

export interface ClaimSupportSummary {
  verdict: string;
  counts: Record<string, number>;
  groundingDensity: number | null;
  versionFlags: string[];
  unresolvedCitations: number;
  citedIds: string[];
}

export interface ScoredAnswer {
  markerScoring: { failHits: string[]; passCount: number };
  claimSupport: ClaimSupportSummary;
  verdict: "pass" | "fail" | "inconclusive" | "skipped" | "error";
}

export interface AnswerFixture {
  id: string;
  drupalVersion?: string;
  [key: string]: unknown;
}

export type ResolveDocsFn = (
  answer: string,
) => Promise<{ docs: Record<string, string>; unresolved: number; citedIds: string[] }>;

export function scoreAnswer(
  answer: string,
  fixture: AnswerFixture,
  resolveDocsFn: ResolveDocsFn,
): Promise<ScoredAnswer>;

export function connectExpert(env?: NodeJS.ProcessEnv): Promise<unknown>;
export function closeExpert(client: unknown): Promise<void>;
export function askAndScore(
  client: unknown,
  fixture: AnswerFixture,
  model: string,
  env?: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>>;
export function ollamaReachable(env?: NodeJS.ProcessEnv): Promise<false | Set<string>>;
export const DEFAULT_BASE_URL: string;
