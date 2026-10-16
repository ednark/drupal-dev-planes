import { type DrushConfig, phpEval, phpPayload, type EvalOutcome, type EntityType } from "@drupal-dev-planes/state";

/**
 * Guarded content-entity writes (create + delete). Reads — field definitions
 * and entity read-back — live in the state plane
 * (@drupal-dev-planes/state); the entity diff lives in the verification plane
 * (@drupal-dev-planes/verify). This module owns only what mutates a site.
 */

// ---------------------------------------------------------------------------
// create_content
// ---------------------------------------------------------------------------

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

export function createContent(
  config: DrushConfig,
  payload: CreateContentPayload,
  timeoutMs?: number,
): Promise<EvalOutcome<CreateContentResult>> {
  return phpEval<unknown>(config, createContentSnippet(createContentWire(payload)), timeoutMs).then((r) =>
    r.ok ? { ok: true, value: normalizeCreateContentResult(r.value) } : r,
  );
}

// ---------------------------------------------------------------------------
// delete_content
// ---------------------------------------------------------------------------

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
