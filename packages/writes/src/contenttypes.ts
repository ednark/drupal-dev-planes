/**
 * Slice 2: guarded content-type and field writes. Same three-beat contract
 * as Slice 1: precondition (catalog-backed) -> apply -> paired read-back
 * verification. The agent surface never sees raw code.
 */

import { type DrushConfig } from "@drupal-dev-planes/state";
import { phpEval, type EvalOutcome } from "@drupal-dev-planes/state";

// ---------------------------------------------------------------------------
// Node type existence (precondition + read-back)
// ---------------------------------------------------------------------------

const NODE_TYPE_EXISTS_SNIPPET = `return json_encode([
  'exists' => \\Drupal::entityTypeManager()->getStorage('node_type')->load($p['bundle']) !== null,
]);`;

export function nodeTypeExists(
  config: DrushConfig,
  bundle: string,
  timeoutMs?: number,
): Promise<EvalOutcome<boolean>> {
  return phpEval<unknown>(
    config,
    wrapWithPayload({ bundle }, NODE_TYPE_EXISTS_SNIPPET),
    timeoutMs,
  ).then((r) => {
    if (!r.ok) return r;
    const v = (r.value ?? {}) as Record<string, unknown>;
    return { ok: true as const, value: v["exists"] === true };
  });
}

function wrapWithPayload(payload: Record<string, unknown>, body: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `$p = json_decode(base64_decode('${encoded}'), true);\n${body}`;
}

// ---------------------------------------------------------------------------
// create_content_type
// ---------------------------------------------------------------------------

export interface CreateContentTypePayload {
  bundle: string;
  label: string;
  description?: string;
}

export function createContentTypeSnippet(payload: CreateContentTypePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return [
    `$p = json_decode(base64_decode('${encoded}'), true);`,
    `$r = ['errors' => [], 'type' => null];`,
    `try {`,
    `  $existing = \\Drupal::entityTypeManager()->getStorage('node_type')->load($p['bundle']);`,
    `  if ($existing) { $r['errors'][] = 'node type already exists (precondition violated)'; }`,
    `  else {`,
    `    $type = \\Drupal::entityTypeManager()->getStorage('node_type')->create(['type' => $p['bundle'], 'name' => $p['label'], 'description' => $p['description'] ?? '']);`,
    `    $type->save();`,
    `    $r['type'] = $p['bundle'];`,
    `  }`,
    `} catch (Throwable $e) { $r['errors'][] = $e->getMessage(); }`,
    `return json_encode($r);`,
  ].join("\n");
}

export interface CreateContentTypeResult {
  errors: string[];
  type: string | null;
}

export function normalizeCreateContentTypeResult(raw: unknown): CreateContentTypeResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    errors: Array.isArray(r["errors"]) ? r["errors"].map(String) : [],
    type: typeof r["type"] === "string" ? r["type"] : null,
  };
}

export function createContentType(
  config: DrushConfig,
  payload: CreateContentTypePayload,
  timeoutMs?: number,
): Promise<EvalOutcome<CreateContentTypeResult>> {
  return phpEval<unknown>(config, createContentTypeSnippet(payload), timeoutMs).then((r) =>
    r.ok ? { ok: true, value: normalizeCreateContentTypeResult(r.value) } : r,
  );
}

// ---------------------------------------------------------------------------
// add_field
// ---------------------------------------------------------------------------

const FIELD_TYPES = [
  "string", "string_long", "text", "text_long", "text_with_summary",
  "integer", "decimal", "boolean", "datetime", "link", "entity_reference",
  "list_string", "list_integer", "email", "telephone", "timestamp",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export function isFieldType(value: string): value is FieldType {
  return (FIELD_TYPES as readonly string[]).includes(value);
}

export interface AddFieldPayload {
  bundle: string;
  fieldName: string;
  fieldType: FieldType;
  label: string;
  required: boolean;
  /** -1 unlimited; default 1. */
  cardinality: number;
}

export function addFieldSnippet(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return [
    `$p = json_decode(base64_decode('${encoded}'), true);`,
    `$r = ['errors' => [], 'field' => null];`,
    `try {`,
    `  $defs = \\Drupal::service('entity_field.manager')->getFieldDefinitions('node', $p['bundle']);`,
    `  if (isset($defs[$p['field_name']])) { $r['errors'][] = 'field already exists on bundle (precondition violated)'; }`,
    `  else {`,
    `    \\Drupal::entityTypeManager()->getStorage('field_storage_config')->create([`,
    `      'field_name' => $p['field_name'], 'entity_type' => 'node', 'type' => $p['field_type'],`,
    `      'cardinality' => (int) $p['cardinality'],`,
    `    ])->save();`,
    `    \\Drupal::entityTypeManager()->getStorage('field_config')->create([`,
    `      'field_name' => $p['field_name'], 'entity_type' => 'node', 'bundle' => $p['bundle'],`,
    `      'label' => $p['label'], 'required' => (bool) $p['required'],`,
    `    ])->save();`,
    `    $r['field'] = $p['field_name'];`,
    `  }`,
    `} catch (Throwable $e) { $r['errors'][] = $e->getMessage(); }`,
    `return json_encode($r);`,
  ].join("\n");
}

export interface AddFieldResult {
  errors: string[];
  field: string | null;
}

export function normalizeAddFieldResult(raw: unknown): AddFieldResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    errors: Array.isArray(r["errors"]) ? r["errors"].map(String) : [],
    field: typeof r["field"] === "string" ? r["field"] : null,
  };
}

export function addField(
  config: DrushConfig,
  payload: AddFieldPayload,
  timeoutMs?: number,
): Promise<EvalOutcome<AddFieldResult>> {
  // The snippet reads snake_case keys; serialize on the wire shape.
  const wire = {
    bundle: payload.bundle,
    field_name: payload.fieldName,
    field_type: payload.fieldType,
    label: payload.label,
    required: payload.required,
    cardinality: payload.cardinality,
  };
  return phpEval<unknown>(config, addFieldSnippet(wire), timeoutMs).then((r) =>
    r.ok ? { ok: true, value: normalizeAddFieldResult(r.value) } : r,
  );
}
