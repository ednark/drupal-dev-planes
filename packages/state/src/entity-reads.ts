/**
 * Entity-model reads: the entity-type enumeration, bundle field definitions,
 * and entity read-back. These are *reads* (what is true on this site), so they
 * belong to the state plane — the write tools import them from here rather
 * than owning them. (Moved out of packages/writes, where read primitives were
 * living next to the writes they guard.)
 */

import { type DrushConfig } from "./drush.js";
import { phpEval, phpPayload, type EvalOutcome } from "./eval.js";

// ---------------------------------------------------------------------------
// Entity types (shared by reads and writes)
// ---------------------------------------------------------------------------

export const ENTITY_TYPES = ["node", "taxonomy_term", "user", "media", "block_content"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Bundle field definitions
// ---------------------------------------------------------------------------

export interface FieldDef {
  name: string;
  label?: string;
  type?: string;
  required: boolean;
  /** -1 means unlimited; 1 is the Drupal default. */
  cardinality: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

export function fieldDefsSnippet(entityType: EntityType, bundle: string): string {
  const payload = phpPayload({ entity_type: entityType, bundle });
  return [
    `$p = json_decode(base64_decode('${payload}'), true);`,
    `$defs = \\Drupal::service('entity_field.manager')->getFieldDefinitions($p['entity_type'], $p['bundle']);`,
    `$out = [];`,
    `foreach ($defs as $name => $def) {`,
    `  $out[] = ['name' => $name, 'label' => (string) $def->getLabel(), 'type' => $def->getType(), 'required' => (bool) $def->isRequired(), 'cardinality' => (int) $def->getFieldStorageDefinition()->getCardinality()];`,
    `}`,
    `return json_encode(array_values($out));`,
  ].join("\n");
}

export function fetchFieldDefs(
  config: DrushConfig,
  entityType: EntityType,
  bundle: string,
  timeoutMs?: number,
): Promise<EvalOutcome<FieldDef[]>> {
  const outcome = phpEval<unknown>(config, fieldDefsSnippet(entityType, bundle), timeoutMs);
  return outcome.then((r) =>
    r.ok ? { ok: true, value: normalizeFieldDefs(r.value) } : r,
  );
}

// ---------------------------------------------------------------------------
// Entity read-back
// ---------------------------------------------------------------------------

export interface EntityReadback {
  found: boolean;
  entity_type?: string;
  id?: number;
  uuid?: string;
  bundle?: string;
  label?: string;
  published?: boolean;
  [field: string]: unknown;
}

export function entityReadbackSnippet(entityType: EntityType, id: number | null, uuid: string | null): string {
  const payload = phpPayload({ entity_type: entityType, id, uuid });
  return [
    `$p = json_decode(base64_decode('${payload}'), true);`,
    `$storage = \\Drupal::entityTypeManager()->getStorage($p['entity_type']);`,
    `$entity = null;`,
    `if (!empty($p['uuid'])) { $found = $storage->loadByProperties(['uuid' => $p['uuid']]); $entity = $found ? reset($found) : null; }`,
    `if (!$entity && !empty($p['id'])) { $entity = $storage->load($p['id']); }`,
    `if (!$entity) { return json_encode(['found' => false]); }`,
    `$out = ['found' => true, 'entity_type' => $entity->getEntityTypeId(), 'id' => (int) $entity->id(), 'uuid' => $entity->uuid(), 'bundle' => $entity->bundle(), 'label' => (string) $entity->label()];`,
    `if (method_exists($entity, 'isPublished')) { $out['published'] = (bool) $entity->isPublished(); }`,
    `foreach ($entity->getFields() as $name => $list) {`,
    `  if ($name === 'label' || $name === 'title') { continue; }`,
    `  $vals = [];`,
    `  foreach ($list as $item) { $vals[] = $item->getValue(); }`,
    `  $out[$name] = $vals;`,
    `}`,
    `return json_encode($out);`,
  ].join("\n");
}

export function readbackEntity(
  config: DrushConfig,
  entityType: EntityType,
  id: number | null,
  uuid: string | null,
  timeoutMs?: number,
): Promise<EvalOutcome<EntityReadback>> {
  return phpEval<EntityReadback>(config, entityReadbackSnippet(entityType, id, uuid), timeoutMs);
}
