/**
 * Field-definition normalization for the write tools' precondition checks.
 * Written defensively (drush/PHP shapes vary); graduates to `measured` via
 * the sweep harness like every other normalizer.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface FieldDef {
  name: string;
  label?: string;
  type?: string;
  required: boolean;
  /** -1 means unlimited; 1 is the Drupal default. */
  cardinality: number;
}

export function normalizeFieldDefs(raw: unknown): FieldDef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const r = asRecord(row);
      const name = str(r["name"]) ?? "";
      const cardinalityRaw = r["cardinality"];
      const cardinality =
        typeof cardinalityRaw === "number" && Number.isFinite(cardinalityRaw)
          ? cardinalityRaw
          : 1;
      return {
        name,
        label: str(r["label"]),
        type: str(r["type"]),
        required: r["required"] === true || r["required"] === 1 || r["required"] === "1",
        cardinality,
      } satisfies FieldDef;
    })
    .filter((f) => f.name !== "");
}

/**
 * Precondition for create-class writes: every required field must be
 * provided with a non-empty value. This is the catalog-backed refusal for
 * the MEASURED row `unpopulated-field-fatal` — creating an entity without
 * populating a required field took the whole site to HTTP 500, and the
 * commit reported success.
 */
export function missingRequiredValues(
  defs: FieldDef[],
  values: Record<string, unknown>,
): string[] {
  const gaps: string[] = [];
  for (const def of defs) {
    if (!def.required) continue;
    if (!(def.name in values)) {
      gaps.push(def.name);
      continue;
    }
    if (!hasValue(values[def.name])) {
      gaps.push(def.name);
    }
  }
  return gaps;
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(hasValue);
  }
  if (typeof value === "object") {
    return Object.values(value).some(hasValue);
  }
  return true;
}
