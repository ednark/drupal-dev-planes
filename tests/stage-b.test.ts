import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeViews,
  normalizeMenus,
  normalizeRoles,
  normalizeWatchdog,
  normalizeRouteCheck,
  WATCHDOG_SEVERITY_NAMES,
} from "../packages/state/src/entities.js";
import { interpretPageProbe } from "../packages/verify/src/index.js";
import {
  normalizeCreateContentTypeResult,
  normalizeAddFieldResult,
} from "../packages/writes/src/contenttypes.js";

test("normalizeViews maps the eval JSON shape", () => {
  const views = normalizeViews([
    { id: "frontpage", label: "Frontpage", status: 1, base_table: "node_field_data" },
    { id: "archived", label: "Archived", status: false, base_table: "node_field_data" },
  ]);
  assert.equal(views.length, 2);
  assert.equal(views[0]?.status, "enabled");
  assert.equal(views[1]?.status, "disabled");
  assert.equal(normalizeViews(null).length, 0);
});

test("normalizeRoles keeps permission lists", () => {
  const roles = normalizeRoles([
    { id: "administrator", label: "Admin", is_admin: true, permissions: ["administer site configuration", "access content"] },
    { id: "authenticated", is_admin: false, permissions: ["access content"] },
  ]);
  assert.equal(roles[0]?.permissions.length, 2);
  assert.equal(roles[0]?.isAdmin, true);
});

test("normalizeWatchdog keeps severity numbers mapped to names", () => {
  const entries = normalizeWatchdog([
    { wid: 12, severity: 3, type: "php", message: "Call to a member function getName() on null", timestamp: 1, location: "/node/9" },
  ]);
  assert.equal(entries[0]?.severity, 3);
  assert.equal(WATCHDOG_SEVERITY_NAMES[3], "error");
});

test("normalizeRouteCheck verdict on shape", () => {
  const miss = normalizeRouteCheck([]);
  assert.equal(miss.exists, false);
  const hit = normalizeRouteCheck([{ name: "entity.node.canonical", path: "/node/{node}", requirements: { _entity_access: "node.view" } }]);
  assert.equal(hit.exists, true);
  assert.equal(hit.matches[0]?.name, "entity.node.canonical");
});

test("interpretPageProbe: content assertion flags a delivered page missing expected text", () => {
  const body = "<html><body><p>" + "x".repeat(120) + "</p></body></html>"; // > 64B floor
  const probe = interpretPageProbe(200, body, "Passports");
  assert.equal(probe.verdict, "alive");
  assert.equal(probe.expected?.present, false);
  assert.match(probe.detail, /MISSING/);
  const filler = "x".repeat(120);
  const ok = interpretPageProbe(200, `<html><body><p>US Passports ${filler}</p></body></html>`, "Passports");
  assert.equal(ok.expected?.present, true);
  assert.equal(ok.detail, "page delivered");
});

test("content type + field result normalizers keep the honest error list", () => {
  assert.deepEqual(normalizeCreateContentTypeResult({ errors: ["node type already exists (precondition violated)"], type: null }).errors.length, 1);
  assert.equal(normalizeAddFieldResult({ errors: [], field: "field_page_type" }).field, "field_page_type");
  assert.equal(normalizeAddFieldResult(null).field, null);
});
