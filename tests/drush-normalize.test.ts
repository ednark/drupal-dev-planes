import { test } from "node:test";
import assert from "node:assert/strict";
import {
  maskSecrets,
  normalizeConfigValue,
  normalizeModules,
  normalizeStatus,
} from "../packages/state/src/normalize.js";

test("normalizeStatus maps drush status json", () => {
  const status = normalizeStatus({
    "drupal-version": "11.4.1",
    "php-version": "8.3.14",
    "db-driver": "mysql",
    root: "/var/www/site",
    site: "demo",
    bootstrap: "Successful",
  });
  assert.equal(status.drupalVersion, "11.4.1");
  assert.equal(status.phpVersion, "8.3.14");
  assert.equal(status.databaseDriver, "mysql");
  assert.equal(status.siteRoot, "/var/www/site");
  assert.equal(status.bootstrap, "Successful");
});

test("normalizeStatus survives empty output", () => {
  const status = normalizeStatus(null);
  assert.deepEqual(Object.values(status).filter((v) => v !== undefined), []);
});

test("normalizeModules accepts the array shape", () => {
  const modules = normalizeModules([
    { name: "node", label: "Node", status: "Enabled", version: "11.4.1", package: "Core" },
    { name: "webform", label: "Webform", status: "Disabled", version: "6.2.0", package: "Forms" },
  ]);
  assert.equal(modules.length, 2);
  assert.equal(modules[0]?.machineName, "node");
  assert.equal(modules[0]?.status, "enabled");
  assert.equal(modules[1]?.status, "disabled");
});

test("normalizeModules accepts the object-keyed shape", () => {
  const modules = normalizeModules({
    node: { title: "Node", status: "Enabled", version: "11.4.1", package: "Core" },
  });
  assert.equal(modules.length, 1);
  assert.equal(modules[0]?.machineName, "node");
  assert.equal(modules[0]?.label, "Node");
});

test("normalizeModules drops nameless rows", () => {
  const modules = normalizeModules([{ label: "orphan", status: "Enabled" }]);
  assert.equal(modules.length, 0);
});

test("normalizeConfigValue unwraps correctly", () => {
  const value = normalizeConfigValue({ "system.site": { name: "demo" } }, "system.site");
  assert.deepEqual(value, { name: "demo" });
});

test("normalizeConfigValue passes through when shape is unexpected", () => {
  const raw = { other: 1, keys: 2 };
  assert.deepEqual(normalizeConfigValue(raw, "system.site"), raw);
});

test("maskSecrets masks credential keys recursively", () => {
  const masked = maskSecrets({
    name: "demo",
    password: "hunter2",
    api_key: "sk-123",
    nested: { access_token: "t0k", settings: { secret: "s" } },
    authors: "safe", // must NOT be masked by the auth rule
    cache_keys: "safe",
  }) as Record<string, unknown>;
  const nested = masked.nested as Record<string, unknown>;
  assert.equal(masked.name, "demo");
  assert.equal(masked.password, "[masked]");
  assert.equal(masked.api_key, "[masked]");
  assert.deepEqual(nested, { access_token: "[masked]", settings: { secret: "[masked]" } });
  assert.equal(masked.authors, "safe");
  assert.equal(masked.cache_keys, "safe");
});