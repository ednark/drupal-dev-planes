/**
 * Claim-support checking: does a cited document actually SUPPORT a claim, as
 * opposed to merely existing? Deterministic only — no model in the check.
 *
 * Motivated by measured failures (expert-eval 2026-09-26): small models
 * produced confident wrong answers whose citations all RESOLVED but did not
 * SUPPORT the claim ("Drupal 11 requires PHP 8.2" citing a composer.json that
 * contains >=8.2 for a different Drupal version).
 *
 * Three mechanical tests per (claim, cited document) pair:
 *   1. value-presence  — every factual atom in the claim (version numbers,
 *      API identifiers, quoted tokens) must appear in the document.
 *   2. version-assertion — if the claim asserts a Drupal major version
 *      ("Drupal 11 requires..."), the document must mention that major.
 *      Catches version-transposed evidence.
 *   3. subject-proximity — the claim's subject terms must appear near each
 *      found value; a value sitting next to unrelated words is weak support.
 */

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "can", "how",
  "you", "your", "are", "was", "were", "has", "have", "will", "when", "what",
  "which", "there", "their", "them", "then", "than", "they", "its", "not",
  "use", "using", "used", "uses", "show", "shows", "shown", "code", "example",
  "version", "versions", "module", "modules", "drupal", "php", "minimum",
  "requires", "require", "required", "default", "should", "would", "must",
  "also", "all", "any", "one", "two", "per", "via", "out", "set", "get",
  "name", "named", "system", "answer", "objective", "summary", "evidence",
]);

export type ClaimVerdict =
  | "supported"
  | "weak"
  | "unsupported"
  | "uncited"
  | "unresolved";

export interface ClaimRow {
  sentence: string;
  citations: string[];
  verdict: ClaimVerdict;
  values: string[];
  missingValues: string[];
  weakValues: string[];
  versionConflict?: string;
}

export interface ClaimSupportReport {
  verdict: "supported" | "weak" | "unsupported" | "uncited" | "unresolvable";
  counts: Record<ClaimVerdict, number>;
  claims: ClaimRow[];
}

export interface SupportOptions {
  /** How close (chars) a document occurrence must sit to claim subject terms. */
  proximityChars?: number;
}

/** Remove fenced code blocks — code is not a claim, and breaks sentence splitting. */
export function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
}

export function splitSentences(text: string): string[] {
  const cleaned = stripCodeBlocks(text);
  return cleaned
    .split(/(?:\n#{1,6}\s*|\n(?=\s*\n)|(?<=[.!?])\s+(?=[A-Z`*#\-\d]))/g)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 15);
}

export const CITATION_RE = /drupal:\/\/document\/(doc_[A-Za-z0-9_-]+)/g;

/** Factual atoms a claim depends on: numbers, API identifiers, quoted tokens. */
export function extractValues(claim: string): string[] {
  const values = new Set<string>();
  for (const m of claim.matchAll(/\b\d+\.\d+(?:\.\d+)?\b/g)) if (m[0]) values.add(m[0]);
  for (const m of claim.matchAll(/`([^`]{2,60})`/g)) if (m[1]) values.add(m[1]);
  for (const m of claim.matchAll(/\\?Drupal(\\[\w-]+)+/g)) if (m[0]) values.add(m[0]);
  for (const m of claim.matchAll(/\bhook_[A-Za-z_]+\b/g)) if (m[0]) values.add(m[0]);
  for (const m of claim.matchAll(/\$[\w>]+->\w+\(/g)) if (m[0]) values.add(m[0]);
  for (const m of claim.matchAll(/[A-Z][A-Za-z]{2,}(?:Interface|Service|Controller|Subscriber|Manager|Repository)/g)) {
    if (m[0]) values.add(m[0]);
  }
  return [...values];
}

/** Content words used for the proximity test. */
export function extractSubjects(claim: string): string[] {
  const words = claim
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d/.test(w));
  return [...new Set(words)];
}

function normalize(text: string): string {
  return text
    .replace(/\[([^\]\n]{1,40})\]/g, "$1") // index highlight artifacts
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function claimedDrupalMajor(claim: string): string | null {
  const m = claim.match(/drupal\s*v?(\d{1,2})\b/i);
  return m?.[1] ?? null;
}

function checkOne(claim: string, docText: string, opts: SupportOptions): Omit<ClaimRow, "sentence" | "citations"> {
  const doc = normalize(docText);
  const values = extractValues(claim);
  const subjects = extractSubjects(claim);
  const proximity = opts.proximityChars ?? 150;

  const missingValues: string[] = [];
  const weakValues: string[] = [];
  let versionConflict: string | undefined;

  for (const value of values) {
    const needle = normalize(value);
    const at = doc.indexOf(needle);
    if (at === -1) {
      missingValues.push(value);
      continue;
    }
    // Value found — is anything of the claim's subject near it?
    const window = doc.slice(Math.max(0, at - proximity), at + needle.length + proximity);
    const subjectHits = subjects.filter((s) => window.includes(s)).length;
    if (subjectHits === 0) weakValues.push(value);

    // Version transposition: doc mentions a DIFFERENT Drupal major near the value.
    const claimedMajor = claimedDrupalMajor(claim);
    if (claimedMajor && !versionConflict) {
      for (const m of window.matchAll(/drupal\s*v?(\d{1,2})\b/gi)) {
        if (m[1] !== claimedMajor) {
          versionConflict = `document ties "${value}" to Drupal ${m[1]}, claim asserts Drupal ${claimedMajor}`;
          break;
        }
      }
    }
  }

  // Claim asserts a Drupal major the document never mentions at all.
  const claimedMajor = claimedDrupalMajor(claim);
  if (claimedMajor && !doc.includes(`drupal ${claimedMajor}`) && !doc.includes(`drupal${claimedMajor}`)) {
    versionConflict = versionConflict ?? `document never mentions Drupal ${claimedMajor} though the claim asserts it`;
  }

  let verdict: Omit<ClaimRow, "sentence" | "citations">["verdict"];
  if (missingValues.length > 0 || versionConflict) verdict = "unsupported";
  else if (weakValues.length > 0) verdict = "weak";
  else verdict = "supported";

  return { verdict, values, missingValues, weakValues, versionConflict };
}

/**
 * Check an answer's claims against resolved citation texts.
 * @param answer the answer text (claims + inline drupal:// citations)
 * @param docs map from doc_ id (or full uri) to document text
 */
export function checkClaimSupport(
  answer: string,
  docs: Record<string, string>,
  opts: SupportOptions = {},
): ClaimSupportReport {
  const sentences = splitSentences(answer);
  const claims: ClaimRow[] = [];

  for (const sentence of sentences) {
    const citedIds = [...sentence.matchAll(CITATION_RE)].map((m) => m[1] ?? "").filter((s) => s !== "");
    const citations = citedIds.map((id) => `drupal://document/${id}`);
    const base: ClaimRow = {
      sentence,
      citations,
      verdict: "uncited",
      values: [],
      missingValues: [],
      weakValues: [],
    };
    if (citations.length === 0) {
      claims.push(base);
      continue;
    }
    const texts = citedIds
      .map((id) => docs[id] ?? docs[`drupal://document/${id}`])
      .filter((t): t is string => typeof t === "string");
    if (texts.length === 0) {
      claims.push({ ...base, verdict: "unresolved" });
      continue;
    }
    // Supported if ANY cited document carries the claim; unsupported if the
    // strongest available reading is a version conflict or missing value.
    const results = texts.map((t) => checkOne(sentence, t, opts));
    const rank = (v: ClaimVerdict): number => (v === "supported" ? 3 : v === "weak" ? 2 : 1);
    const best = results.reduce((a, b) => (rank(b.verdict) > rank(a.verdict) ? b : a));
    claims.push({ ...base, ...best, verdict: best.verdict });
  }

  const counts: Record<ClaimVerdict, number> = {
    supported: 0, weak: 0, unsupported: 0, uncited: 0, unresolved: 0,
  };
  for (const row of claims) counts[row.verdict]++;

  const citedRows = claims.filter((c) => c.verdict !== "uncited");
  let verdict: ClaimSupportReport["verdict"];
  if (citedRows.length === 0) verdict = "uncited";
  else if (counts.unresolved > 0) verdict = "unresolvable";
  else if (counts.unsupported > 0) verdict = "unsupported";
  else if (counts.weak > 0) verdict = "weak";
  else verdict = "supported";

  return { verdict, counts, claims };
}