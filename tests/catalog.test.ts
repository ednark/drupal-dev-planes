import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFailureModes } from "../packages/verify/src/catalog.js";

const catalog = loadFailureModes();

test("catalog loads rows from data/failure-modes.json", () => {
  assert.ok(catalog.length >= 5, `expected at least 5 rows, got ${catalog.length}`);
});

test("every row has the required fields", () => {
  for (const row of catalog) {
    assert.ok(row.id, `row missing id: ${JSON.stringify(row)}`);
    assert.ok(row.title);
    assert.ok(row.symptom);
    assert.ok(row.rootCause);
    assert.ok(row.detection);
    assert.ok(["claimed", "measured"].includes(row.evidenceStatus));
  }
});

test("seed rows are honest: nothing is marked measured yet", () => {
  const measured = catalog.filter((row) => row.evidenceStatus === "measured");
  assert.equal(measured.length, 0, "a row claims measured without a sweep behind it");
});

test("failure mode ids are unique", () => {
  const ids = catalog.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
});