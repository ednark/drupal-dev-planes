import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScratchDest } from "../sweep/lib/scratch.mjs";

// The scratch provisioner can rmSync a directory, ddev-remove a project, and
// DROP a database. validateScratchDest is the pure boundary that must refuse
// any destination that could be a real project. These tests pin that boundary.

const REPO = "/home/dev/drupal-dev-planes";
const SOURCE = "/home/dev/usagov-2021";

const base = { scratchProject: "usagov-sweep-scratch", sourceDir: SOURCE, fixtureSite: "usagov2021", repoRoot: REPO };

test("accepts a sibling scratch dir distinct from source and repo", () => {
  const r = validateScratchDest({ ...base, scratchDir: "/home/dev/usagov-sweep-scratch" });
  assert.equal(r.ok, true);
});

test("refuses the source checkout itself", () => {
  const r = validateScratchDest({ ...base, scratchDir: SOURCE });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /overlaps the source checkout/);
});

test("refuses a dir nested inside the source checkout", () => {
  const r = validateScratchDest({ ...base, scratchDir: SOURCE + "/scratch" });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /overlaps the source/);
});

test("refuses a dir that would contain the source checkout", () => {
  const r = validateScratchDest({ ...base, scratchDir: "/home/dev" });
  assert.equal(r.ok, false);
});

test("refuses the drupal-dev-planes repo itself and anything inside it", () => {
  assert.equal(validateScratchDest({ ...base, scratchDir: REPO }).ok, false);
  const inside = validateScratchDest({ ...base, scratchDir: REPO + "/sweep/scratch" });
  assert.equal(inside.ok, false);
  assert.match((inside as { reason: string }).reason, /inside the drupal-dev-planes repo/);
});

test("refuses a scratch project name that collides with the main fixture", () => {
  const r = validateScratchDest({ ...base, scratchDir: "/home/dev/other", scratchProject: "usagov2021" });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /collides with the main fixture/);
});

test("refuses a filesystem root", () => {
  assert.equal(validateScratchDest({ ...base, scratchDir: "/" }).ok, false);
});

test("refuses an unset scratch dir", () => {
  assert.equal(validateScratchDest({ ...base, scratchDir: "" }).ok, false);
  assert.equal(validateScratchDest({ ...base, scratchDir: null }).ok, false);
});
