/**
 * Slices 3–5: guarded permission, module, block, and display writes.
 * Same three-beat contract: precondition (catalog-backed) -> apply ->
 * paired read-back verification.
 */

import { type DrushConfig, phpEval, type EvalOutcome } from "@drupal-dev-planes/state";

function wrapWithPayload(payload: Record<string, unknown>, body: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `$p = json_decode(base64_decode('${encoded}'), true);\n${body}`;
}

// ---------------------------------------------------------------------------
// Slice 3: set_permissions
// ---------------------------------------------------------------------------

export interface SetPermissionsPayload {
  role: string;
  /** Permission machine names to grant. */
  grant: string[];
  /** Permission machine names to revoke. */
  revoke: string[];
}

const SET_PERMISSIONS_SNIPPET = `$r = ['errors' => [], 'granted' => [], 'revoked' => []];
try {
  $role = \\Drupal::entityTypeManager()->getStorage('user_role')->load($p['role']);
  if (!$role) { $r['errors'][] = 'role does not exist (precondition violated)'; }
  else {
    $known = \\Drupal::service('user.permissions')->getPermissions();
    foreach ($p['grant'] ?? [] as $perm) {
      if (!isset($known[$perm])) { $r['errors'][] = 'unknown permission: ' . $perm; continue; }
      $role->grantPermission($perm); $r['granted'][] = $perm;
    }
    foreach ($p['revoke'] ?? [] as $perm) {
      if (!isset($known[$perm])) { $r['errors'][] = 'unknown permission: ' . $perm; continue; }
      $role->revokePermission($perm); $r['revoked'][] = $perm;
    }
    if (empty($r['errors'])) { $role->save(); }
  }
} catch (Throwable $e) { $r['errors'][] = $e->getMessage(); }
return json_encode($r);`;

export interface SetPermissionsResult {
  errors: string[];
  granted: string[];
  revoked: string[];
}

function normalizeLists(raw: unknown): SetPermissionsResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    errors: Array.isArray(r["errors"]) ? r["errors"].map(String) : [],
    granted: Array.isArray(r["granted"]) ? r["granted"].map(String) : [],
    revoked: Array.isArray(r["revoked"]) ? r["revoked"].map(String) : [],
  };
}

export function setPermissions(
  config: DrushConfig,
  payload: SetPermissionsPayload,
  timeoutMs?: number,
): Promise<EvalOutcome<SetPermissionsResult>> {
  return phpEval<unknown>(config, wrapWithPayload({ ...payload }, SET_PERMISSIONS_SNIPPET), timeoutMs)
    .then((r) => (r.ok ? { ok: true, value: normalizeLists(r.value) } : r));
}

// ---------------------------------------------------------------------------
// Slice 4: install_module (dependency-safe precondition scan)
// ---------------------------------------------------------------------------

export interface InstallModuleCheck {
  exists: boolean;
  enabled: boolean;
  missingDependencies: string[];
  missingServices: string[];
  /** The module's own error, if the precondition scan could not run. */
  scanError?: string;
}

const INSTALL_CHECK_SNIPPET = `$r = ['exists' => false, 'enabled' => false, 'missingDependencies' => [], 'missingServices' => []];
try {
  $list = \\Drupal::service('extension.list.module');
  if (!$list->exists($p['module'])) { $r['scanError'] = 'module not found in the extension list'; }
  else {
    $r['exists'] = true;
    $r['enabled'] = \\Drupal::moduleHandler()->moduleExists($p['module']);
    $info = $list->getExtensionInfo($p['module']);
    foreach ((array) ($info['dependencies'] ?? []) as $dep) {
      $depName = (strpos($dep, ':') !== false) ? substr($dep, strrpos($dep, ':') + 1) : $dep;
      if (!$list->exists($depName) || !\\Drupal::moduleHandler()->moduleExists($depName)) { $r['missingDependencies'][] = $depName; }
    }
    // Half-commit hazard (measured: undeclared-service-dependency): scan the
    // module's services.yml for @service references that do not exist.
    $dir = $list->getPath($p['module']);
    $yml = $dir . '/' . $p['module'] . '.services.yml';
    if (file_exists($yml)) {
      $text = file_get_contents($yml);
      preg_match_all('/@(?!cache\\.)([a-z0-9_.]+)/', $text, $m);
      $ids = \\Drupal::service('kernel')->getContainer()->getServiceIds();
      foreach (array_unique($m[1] ?? []) as $ref) {
        if (!in_array($ref, $ids)) { $r['missingServices'][] = $ref; }
      }
    }
  }
} catch (Throwable $e) { $r['scanError'] = $e->getMessage(); }
return json_encode($r);`;

export function installModuleCheck(
  config: DrushConfig,
  module: string,
  timeoutMs?: number,
): Promise<EvalOutcome<InstallModuleCheck>> {
  return phpEval<unknown>(config, wrapWithPayload({ module }, INSTALL_CHECK_SNIPPET), timeoutMs).then((r) => {
    if (!r.ok) return r;
    const v = (r.value ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      value: {
        exists: v["exists"] === true,
        enabled: v["enabled"] === true,
        missingDependencies: Array.isArray(v["missingDependencies"]) ? v["missingDependencies"].map(String) : [],
        missingServices: Array.isArray(v["missingServices"]) ? v["missingServices"].map(String) : [],
        scanError: typeof v["scanError"] === "string" ? v["scanError"] : undefined,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Slice 5: place_block + configure_display
// ---------------------------------------------------------------------------

export interface PlaceBlockPayload {
  /** Block config entity id (unique per theme), e.g. mytheme_sweeblock. */
  id: string;
  /** Plugin id, e.g. system_powered_by_block. */
  plugin: string;
  theme: string;
  region: string;
  label?: string;
}

const PLACE_BLOCK_SNIPPET = `$r = ['errors' => [], 'block' => null];
try {
  $themeHandler = \\Drupal::service('theme_handler');
  $themeInfo = null;
  try { $themeInfo = $themeHandler->getTheme($p['theme']); } catch (Throwable $e) { $themeInfo = null; }
  if (!$themeInfo) { $r['errors'][] = 'theme not installed (precondition violated)'; }
  else {
    $regions = $themeInfo->info['regions'] ?? [];
    if (!isset($regions[$p['region']])) { $r['errors'][] = 'region not defined in the theme (precondition violated)'; }
    elseif (\\Drupal::entityTypeManager()->getStorage('block')->load($p['id'])) { $r['errors'][] = 'block id already exists (precondition violated)'; }
    else {
      $block = \\Drupal::entityTypeManager()->getStorage('block')->create([
        'id' => $p['id'], 'plugin' => $p['plugin'], 'theme' => $p['theme'], 'region' => $p['region'],
        'settings' => ['label' => $p['label'] ?? ''],
      ]);
      $block->save();
      $r['block'] = $p['id'];
    }
  }
} catch (Throwable $e) { $r['errors'][] = $e->getMessage(); }
return json_encode($r);`;

export interface PlaceBlockResult {
  errors: string[];
  block: string | null;
}

export function placeBlock(
  config: DrushConfig,
  payload: PlaceBlockPayload,
  timeoutMs?: number,
): Promise<EvalOutcome<PlaceBlockResult>> {
  return phpEval<unknown>(config, wrapWithPayload({ ...payload }, PLACE_BLOCK_SNIPPET), timeoutMs).then((r) => {
    if (!r.ok) return r;
    const v = (r.value ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      value: {
        errors: Array.isArray(v["errors"]) ? v["errors"].map(String) : [],
        block: typeof v["block"] === "string" ? v["block"] : null,
      },
    };
  });
}

export interface SetDisplayPayload {
  entityType: string;
  bundle: string;
  fieldName: string;
  viewMode: string;
  /** Formatter plugin, e.g. text_default, string, entity_reference_label. */
  formatter: string;
  hidden?: boolean;
}

const SET_DISPLAY_SNIPPET = `$r = ['errors' => [], 'component' => null];
try {
  $display = \\Drupal::service('entity_display.repository')->getViewDisplay($p['entity_type'], $p['bundle'], $p['view_mode']);
  if ($p['hidden']) { $display->removeComponent($p['field_name']); }
  else { $display->setComponent($p['field_name'], ['type' => $p['formatter']]); }
  $display->save();
  $r['component'] = $p['field_name'];
} catch (Throwable $e) { $r['errors'][] = $e->getMessage(); }
return json_encode($r);`;

export interface SetDisplayResult {
  errors: string[];
  component: string | null;
}

export function setDisplayComponent(
  config: DrushConfig,
  payload: SetDisplayPayload,
  timeoutMs?: number,
): Promise<EvalOutcome<SetDisplayResult>> {
  const wire = {
    entity_type: payload.entityType,
    bundle: payload.bundle,
    field_name: payload.fieldName,
    view_mode: payload.viewMode,
    formatter: payload.formatter,
    hidden: payload.hidden ?? false,
  };
  return phpEval<unknown>(config, wrapWithPayload(wire, SET_DISPLAY_SNIPPET), timeoutMs).then((r) => {
    if (!r.ok) return r;
    const v = (r.value ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      value: {
        errors: Array.isArray(v["errors"]) ? v["errors"].map(String) : [],
        component: typeof v["component"] === "string" ? v["component"] : null,
      },
    };
  });
}

export function readbackDisplayComponent(
  config: DrushConfig,
  { entityType, bundle, fieldName, viewMode }: { entityType: string; bundle: string; fieldName: string; viewMode: string },
  timeoutMs?: number,
): Promise<EvalOutcome<Record<string, unknown>>> {
  return phpEval<unknown>(
    config,
    wrapWithPayload(
      { entity_type: entityType, bundle, field_name: fieldName, view_mode: viewMode },
      `$display = \\Drupal::service('entity_display.repository')->getViewDisplay($p['entity_type'], $p['bundle'], $p['view_mode']);
$component = $display->getComponent($p['field_name']);
return json_encode(['present' => $component !== null, 'component' => $component]);`,
    ),
    timeoutMs,
  ).then((r) => (r.ok ? { ok: true as const, value: (r.value ?? {}) as Record<string, unknown> } : r));
}
