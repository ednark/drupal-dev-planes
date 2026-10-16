import { type DrushConfig } from "@drupal-dev-planes/state";
import { diffConfig, type ConfigDiff } from "@drupal-dev-planes/verify";
import { phpEval, phpPayload, type EvalOutcome } from "./php-eval.js";
import { normalizeFieldDefs, missingRequiredValues, type FieldDef } from "./fields.js";

/**
 * Guarded content-entity writes. Each function builds a self-contained
 * `drush php:eval` snippet: catalog preconditions run BEFORE the write,
 * verification runs AFTER, and the agent surface never sees raw code.
 */

const ENTITY_TYPES = ["node", "taxonomy_term", "user", "media", "block_content"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Snippets (payload passes as base64; snippets return one JSON value).
// ---------------------------------------------------------------------------

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

export interface CreateContentPayload {
  entity_type: EntityType;
  bundle: string;
  title: string;
  published: boolean;
  /** Optional URL alias (nodes with path module). */
  alias?: string;
  /** Optional moderation state for moderated bundles ('published', 'draft', …). */
  moderationState?: string;
  /** Field-name → delta values, exactly as \Drupal::Entity::set() accepts them. */
  fields: Record<string, unknown>;
}

export function createContentSnippet(payload: Record<string, unknown>): string {
  const encoded = phpPayload(payload);
  return [
    `$p = json_decode(base64_decode('${encoded}'), true);`,
    `$r = ['errors' => [], 'id' => null, 'uuid' => null, 'bundle' => null];`,
    `try {`,
    `  $storage = \\Drupal::entityTypeManager()->getStorage($p['entity_type']);`,
    `  $values = [];`,
    `  if ($p['entity_type'] === 'node') { $values['type'] = $p['bundle']; $values['title'] = $p['title']; }`,
    `  if (array_key_exists('published', $p)) { $values['status'] = $p['published'] ? 1 : 0; }`,
    `  $entity = $storage->create($values);`,
    `  if (!empty($p['fields']) && is_array($p['fields'])) {`,
    `    foreach ($p['fields'] as $name => $vals) { $entity->set($name, $vals); }`,
    `  }`,
    `  if (!empty($p['moderation_state'])) { $entity->set('moderation_state', $p['moderation_state']); }`,
    `  if (!empty($p['alias']) && $entity->hasField('path')) { $entity->set('path', ['alias' => $p['alias'], 'pathauto' => 0]); }`,
    `  $entity->save();`,
    `  if (!empty($p['moderation_state']) && $entity->hasField('moderation_state')) {`,
    `    // Measured 2026-10-16: the moderation initial state can override the`,
    `    // requested transition on create — a second set+save after the first`,
    `    // save is what actually publishes.`,
    `    $current = $entity->get('moderation_state')->value;`,
    `    if ($current !== $p['moderation_state']) { $entity->set('moderation_state', $p['moderation_state']); $entity->save(); }`,
    `  }`,
    `  $r['id'] = (int) $entity->id();`,
    `  $r['uuid'] = $entity->uuid();`,
    `  $r['bundle'] = $entity->bundle();`,
    `} catch (Throwable $e) {`,
    `  $r['errors'][] = $e->getMessage();`,
    `}`,
    `return json_encode($r);`,
  ].join("\n");
}

export interface CreateContentResult {
  errors: string[];
  id: number | null;
  uuid: string | null;
  bundle: string | null;
}

export function normalizeCreateContentResult(raw: unknown): CreateContentResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    errors: Array.isArray(r["errors"]) ? r["errors"].map(String) : [],
    id: typeof r["id"] === "number" ? r["id"] : null,
    uuid: typeof r["uuid"] === "string" ? r["uuid"] : null,
    bundle: typeof r["bundle"] === "string" ? r["bundle"] : null,
  };
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

export function deleteContentSnippet(entityType: EntityType, ids: number[], uuid: string | null): string {
  const payload = phpPayload({ entity_type: entityType, ids, uuid });
  return [
    `$p = json_decode(base64_decode('${payload}'), true);`,
    `$storage = \\Drupal::entityTypeManager()->getStorage($p['entity_type']);`,
    `$targets = [];`,
    `if (!empty($p['uuid'])) { foreach ($storage->loadByProperties(['uuid' => $p['uuid']]) as $e) { $targets[] = $e; } }`,
    `foreach ((array) ($p['ids'] ?? []) as $id) { $e = $storage->load((int) $id); if ($e) { $targets[] = $e; } }`,
    `$deleted = 0; $errors = [];`,
    `foreach ($targets as $e) { try { $e->delete(); $deleted++; } catch (Throwable $ex) { $errors[] = $ex->getMessage(); } }`,
    `return json_encode(['deleted' => $deleted, 'errors' => $errors]);`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Operations (thin wrappers over the snippets; the server supplies config).
// ---------------------------------------------------------------------------

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

/**
 * Map the camelCase payload to the snake_case wire shape the PHP snippet
 * reads. Without this, `moderationState` never reached `$p['moderation_state']`
 * and moderated bundles silently stayed in their initial state.
 */
export function createContentWire(payload: CreateContentPayload): Record<string, unknown> {
  return {
    entity_type: payload.entity_type,
    bundle: payload.bundle,
    title: payload.title,
    published: payload.published,
    fields: payload.fields,
    ...(payload.alias !== undefined ? { alias: payload.alias } : {}),
    ...(payload.moderationState !== undefined ? { moderation_state: payload.moderationState } : {}),
  };
}

export function createContent(
  config: DrushConfig,
  payload: CreateContentPayload,
  timeoutMs?: number,
): Promise<EvalOutcome<CreateContentResult>> {
  return phpEval<unknown>(config, createContentSnippet(createContentWire(payload)), timeoutMs).then((r) =>
    r.ok ? { ok: true, value: normalizeCreateContentResult(r.value) } : r,
  );
}

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

export function readbackEntity(
  config: DrushConfig,
  entityType: EntityType,
  id: number | null,
  uuid: string | null,
  timeoutMs?: number,
): Promise<EvalOutcome<EntityReadback>> {
  return phpEval<EntityReadback>(config, entityReadbackSnippet(entityType, id, uuid), timeoutMs);
}

export function deleteContent(
  config: DrushConfig,
  entityType: EntityType,
  ids: number[],
  uuid: string | null,
  timeoutMs?: number,
): Promise<EvalOutcome<{ deleted: number; errors: string[] }>> {
  return phpEval<unknown>(config, deleteContentSnippet(entityType, ids, uuid), timeoutMs).then((r) => {
    if (!r.ok) return r;
    const raw = (r.value ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      value: {
        deleted: typeof raw["deleted"] === "number" ? raw["deleted"] : 0,
        errors: Array.isArray(raw["errors"]) ? raw["errors"].map(String) : [],
      },
    };
  });
}

export { missingRequiredValues, normalizeFieldDefs };
export type { FieldDef };

// ---------------------------------------------------------------------------
// Entity diff: expected flat values vs the read-back, with scalar-unwrapping.
// ---------------------------------------------------------------------------

export interface EntityDiff extends ConfigDiff {
  /** Keys compared via the loose scalar shorthand instead of exact deltas. */
  loose: string[];
}

/**
 * Subset-compare expected field values against the entity read-back. Exact
 * form first (title as scalar, fields as delta arrays of item objects); on
 * mismatch, retry scalar expected values against the first item's `value`
 * so agents can write `body: "hi"` instead of the full item array.
 */
export function diffEntityValues(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): EntityDiff {
  const direct = diffConfig(actual, expected);
  const loose: string[] = [];
  if (direct.verdict === "match") return { ...direct, loose };
  const adjusted: Record<string, unknown> = { ...actual };
  for (const [key, want] of Object.entries(expected)) {
    if (want === null || typeof want !== "object") {
      const raw = actual[key];
      if (Array.isArray(raw)) {
        const first = raw[0];
        if (first !== null && typeof first === "object" && !Array.isArray(first) && "value" in (first as Record<string, unknown>)) {
          adjusted[key] = (first as Record<string, unknown>)["value"];
          loose.push(key);
        }
      }
    }
  }
  const retry = diffConfig(adjusted, expected);
  return { ...retry, loose };
}
