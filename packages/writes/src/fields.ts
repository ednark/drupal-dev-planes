/**
 * Write precondition: every required field must be provided with a non-empty
 * value before a create-class write. This is the catalog-backed refusal for
 * the MEASURED row `unpopulated-field-fatal` — creating an entity without
 * populating a required field took the whole site to HTTP 500 while the
 * commit reported success.
 *
 * This is a *write guard*, so it lives in the writes plane. The field
 * *definitions* it reads come from the state plane
 * (@drupal-dev-planes/state: FieldDef, fetchFieldDefs).
 */

import { type FieldDef } from "@drupal-dev-planes/state";

/**
 * Structural base fields the write tools set themselves (or that default):
 * they appear as required in field definitions but are NOT the caller's
 * responsibility in `fields`. 'type' comes from the bundle parameter,
 * 'title' from the title parameter, langcode/uuid/revision_* are auto-set.
 */
export const STRUCTURAL_BASE_FIELDS = new Set([
  "type", "langcode", "uuid", "vid",
  "revision_default", "revision_timestamp", "revision_uid", "revision_log",
]);

export function missingRequiredValues(
  defs: FieldDef[],
  values: Record<string, unknown>,
): string[] {
  const gaps: string[] = [];
  for (const def of defs) {
    if (!def.required) continue;
    if (STRUCTURAL_BASE_FIELDS.has(def.name)) continue;
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
