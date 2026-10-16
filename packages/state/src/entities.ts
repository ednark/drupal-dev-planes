/**
 * Stage-B typed state reads: views, menus, roles, watchdog, routes.
 * Each read is a base64-transported php:eval snippet returning one JSON
 * value — same transport discipline as the write tools. Normalizers are
 * written defensively and graduate via the sweep harness like every other.
 */

import { type DrushConfig } from "./drush.js";
import { phpEval, type EvalOutcome } from "./eval.js";

function snippet(body: string): string {
  return body;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface SiteView {
  id: string;
  label?: string;
  status?: "enabled" | "disabled";
  baseTable?: string;
  displayCount?: number;
}

const VIEWS_SNIPPET = snippet(
  `$out = [];
foreach (\\Drupal::entityTypeManager()->getStorage('view')->loadMultiple() as $id => $view) {
  $out[] = ['id' => $id, 'label' => (string) $view->label(), 'status' => (bool) $view->status(), 'base_table' => (string) ($view->get('base_table') ?? '')];
}
return json_encode($out);`,
);

export function normalizeViews(raw: unknown): SiteView[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      const id = typeof r["id"] === "string" ? r["id"] : "";
      const statusRaw = r["status"];
      return {
        id,
        label: typeof r["label"] === "string" ? r["label"] : undefined,
        status: statusRaw === true || statusRaw === 1 ? ("enabled" as const) : ("disabled" as const),
        baseTable: typeof r["base_table"] === "string" ? r["base_table"] : undefined,
      } satisfies SiteView;
    })
    .filter((v) => v.id !== "");
}

export function listViews(config: DrushConfig, timeoutMs?: number): Promise<EvalOutcome<SiteView[]>> {
  return phpEval<unknown>(config, VIEWS_SNIPPET, timeoutMs).then((r) =>
    r.ok ? { ok: true, value: normalizeViews(r.value) } : r,
  );
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

export interface SiteMenu {
  id: string;
  label?: string;
  description?: string;
}

const MENUS_SNIPPET = snippet(
  `$out = [];
foreach (\\Drupal::entityTypeManager()->getStorage('menu')->loadMultiple() as $id => $menu) {
  $out[] = ['id' => $id, 'label' => (string) $menu->label(), 'description' => (string) ($menu->get('description') ?? '')];
}
return json_encode($out);`,
);

export function normalizeMenus(raw: unknown): SiteMenu[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      const id = typeof r["id"] === "string" ? r["id"] : "";
      return {
        id,
        label: typeof r["label"] === "string" ? r["label"] : undefined,
        description: typeof r["description"] === "string" ? r["description"] : undefined,
      } satisfies SiteMenu;
    })
    .filter((m) => m.id !== "");
}

export function listMenus(config: DrushConfig, timeoutMs?: number): Promise<EvalOutcome<SiteMenu[]>> {
  return phpEval<unknown>(config, MENUS_SNIPPET, timeoutMs).then((r) =>
    r.ok ? { ok: true, value: normalizeMenus(r.value) } : r,
  );
}

// ---------------------------------------------------------------------------
// Roles + permissions
// ---------------------------------------------------------------------------

export interface SiteRole {
  id: string;
  label?: string;
  isAdmin: boolean;
  permissions: string[];
}

const ROLES_SNIPPET = snippet(
  `$out = [];
foreach (\\Drupal::entityTypeManager()->getStorage('user_role')->loadMultiple() as $id => $role) {
  $out[] = ['id' => $id, 'label' => (string) $role->label(), 'is_admin' => (bool) $role->isAdmin(), 'permissions' => array_values($role->getPermissions())];
}
return json_encode($out);`,
);

export function normalizeRoles(raw: unknown): SiteRole[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      const id = typeof r["id"] === "string" ? r["id"] : "";
      return {
        id,
        label: typeof r["label"] === "string" ? r["label"] : undefined,
        isAdmin: r["is_admin"] === true || r["is_admin"] === 1,
        permissions: Array.isArray(r["permissions"]) ? r["permissions"].map(String) : [],
      } satisfies SiteRole;
    })
    .filter((r) => r.id !== "");
}

export function listRoles(config: DrushConfig, timeoutMs?: number): Promise<EvalOutcome<SiteRole[]>> {
  return phpEval<unknown>(config, ROLES_SNIPPET, timeoutMs).then((r) =>
    r.ok ? { ok: true, value: normalizeRoles(r.value) } : r,
  );
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export interface WatchdogEntry {
  wid: number;
  severity: number;
  type?: string;
  message?: string;
  timestamp?: number;
  location?: string;
}

const WATCHDOG_SNIPPET = snippet(
  `$q = \\Drupal::database()->select('watchdog', 'w')
  ->fields('w', ['wid', 'severity', 'type', 'message', 'timestamp', 'location'])
  ->orderBy('wid', 'DESC')
  ->range(0, 50);
$out = [];
foreach ($q->execute() as $row) {
  $out[] = ['wid' => (int) $row->wid, 'severity' => (int) $row->severity, 'type' => (string) $row->type, 'message' => (string) $row->message, 'timestamp' => (int) $row->timestamp, 'location' => (string) $row->location];
}
return json_encode($out);`,
);

export const WATCHDOG_SEVERITY_NAMES: Record<number, string> = {
  0: "emergency", 1: "alert", 2: "critical", 3: "error",
  4: "warning", 5: "notice", 6: "info", 7: "debug",
};

export function normalizeWatchdog(raw: unknown): WatchdogEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return {
        wid: typeof r["wid"] === "number" ? r["wid"] : 0,
        severity: typeof r["severity"] === "number" ? r["severity"] : -1,
        type: typeof r["type"] === "string" ? r["type"] : undefined,
        message: typeof r["message"] === "string" ? r["message"] : undefined,
        timestamp: typeof r["timestamp"] === "number" ? r["timestamp"] : undefined,
        location: typeof r["location"] === "string" ? r["location"] : undefined,
      } satisfies WatchdogEntry;
    })
    .filter((e) => e.wid > 0);
}

export function getWatchdog(config: DrushConfig, timeoutMs?: number): Promise<EvalOutcome<WatchdogEntry[]>> {
  return phpEval<unknown>(config, WATCHDOG_SNIPPET, timeoutMs).then((r) =>
    r.ok ? { ok: true, value: normalizeWatchdog(r.value) } : r,
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface RouteCheck {
  exists: boolean;
  matches: Array<{ name: string; path: string; requirements: Record<string, unknown> }>;
}

const ROUTE_SNIPPET_BASE = `$provider = \\Drupal::service('router.route_provider');
$out = [];
$pattern = $p['pattern'];
try {
  $collection = $provider->getRoutesByPattern($pattern);
} catch (Throwable $e) { $collection = null; }
$all = $collection ? $collection->all() : [];
if (empty($all) && !empty($p['name'])) {
  try { $all = $provider->getRoutesByNames([$p['name']]); } catch (Throwable $e) { $all = []; }
}
foreach ($all as $name => $route) {
  $out[] = ['name' => $name, 'path' => (string) $route->getPath(), 'requirements' => $route->getRequirements() ?? new stdClass()];
}
return json_encode($out);`;

export function normalizeRouteCheck(raw: unknown): RouteCheck {
  const matches = Array.isArray(raw)
    ? raw.map((row) => {
        const r = (row ?? {}) as Record<string, unknown>;
        return {
          name: typeof r["name"] === "string" ? r["name"] : "",
          path: typeof r["path"] === "string" ? r["path"] : "",
          requirements: (r["requirements"] ?? {}) as Record<string, unknown>,
        };
      })
    : [];
  return { exists: matches.length > 0, matches };
}

export function checkRoute(
  config: DrushConfig,
  { pattern, name }: { pattern?: string; name?: string },
  timeoutMs?: number,
): Promise<EvalOutcome<RouteCheck>> {
  const encoded = Buffer.from(JSON.stringify({ pattern: pattern ?? null, name: name ?? null }), "utf8").toString("base64");
  const code = `$p = json_decode(base64_decode('${encoded}'), true);\n${ROUTE_SNIPPET_BASE}`;
  return phpEval<unknown>(config, code, timeoutMs).then((r) =>
    r.ok ? { ok: true, value: normalizeRouteCheck(r.value) } : r,
  );
}
