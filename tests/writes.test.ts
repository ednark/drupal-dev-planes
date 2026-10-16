import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffEntityValues,
  missingRequiredValues,
  normalizeCreateContentResult,
  normalizeFieldDefs,
  createContentSnippet,
  createContentWire,
  entityReadbackSnippet,
  phpPayload,
  parseTrailingJson,
  shellJoinedEvalArg,
} from "../packages/writes/src/index.js";
import type { FieldDef } from "../packages/writes/src/fields.js";

// ---------------------------------------------------------------------------
// Field-definition normalizer
// ---------------------------------------------------------------------------

test("normalizeFieldDefs parses the eval JSON shape", () => {
  const defs = normalizeFieldDefs([
    { name: "title", label: "Title", type: "string", required: true, cardinality: 1 },
    { name: "body", label: "Body", type: "text_with_summary", required: false, cardinality: 1 },
    { name: "tags", label: "Tags", type: "entity_reference", required: false, cardinality: -1 },
  ]);
  assert.equal(defs.length, 3);
  assert.equal(defs[0]?.name, "title");
  assert.equal(defs[0]?.required, true);
  assert.equal(defs[2]?.cardinality, -1);
});

test("normalizeFieldDefs survives non-array and ragged rows", () => {
  assert.deepEqual(normalizeFieldDefs(null), []);
  assert.deepEqual(normalizeFieldDefs("nope"), []);
  const ragged = normalizeFieldDefs([{ name: "", required: "yes" }, { required: true }]);
  assert.equal(ragged.length, 0);
});

// ---------------------------------------------------------------------------
// Required-field precondition (catalog: unpopulated-field-fatal, measured)
// ---------------------------------------------------------------------------

const DEFS: FieldDef[] = [
  { name: "title", required: true, cardinality: 1 },
  { name: "field_must_have", required: true, cardinality: 1 },
  { name: "field_optional", required: false, cardinality: 1 },
];

test("missingRequiredValues flags absent and empty required fields", () => {
  assert.deepEqual(missingRequiredValues(DEFS, {}), ["title", "field_must_have"]);
  assert.deepEqual(
    missingRequiredValues(DEFS, { title: "x", field_must_have: "  " }),
    ["field_must_have"],
  );
  assert.deepEqual(missingRequiredValues(DEFS, { title: "x", field_must_have: [] }), ["field_must_have"]);
  assert.deepEqual(
    missingRequiredValues(DEFS, { title: "x", field_must_have: [{ value: "y" }], field_optional: "z" }),
    [],
  );
});

test("missingRequiredValues treats a non-empty item array as populated", () => {
  assert.deepEqual(
    missingRequiredValues(DEFS, { title: "x", field_must_have: [{ value: "y" }, { value: "z" }] }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Entity diff (subset + scalar shorthand)
// ---------------------------------------------------------------------------

const READBACK: Record<string, unknown> = {
  found: true,
  id: 7,
  bundle: "basic_page",
  label: "Passport",
  title: ["not-returned"],
  body: [{ value: "hello world", format: "basic_html", summary: "" }],
  status: [{ value: 1 }],
};

test("diffEntityValues matches exact delta arrays", () => {
  const diff = diffEntityValues(READBACK, {
    id: 7,
    bundle: "basic_page",
    body: [{ value: "hello world", format: "basic_html", summary: "" }],
  });
  assert.equal(diff.verdict, "match");
  assert.deepEqual(diff.loose, []);
});

test("diffEntityValues unwraps scalar shorthand against first delta", () => {
  const diff = diffEntityValues(READBACK, { body: "hello world", status: 1 });
  assert.equal(diff.verdict, "match");
  assert.deepEqual(diff.loose.sort(), ["body", "status"]);
});

test("diffEntityValues reports diffs verdict-first", () => {
  const diff = diffEntityValues(READBACK, { body: "wrong text" });
  assert.equal(diff.verdict, "diff");
  assert.equal(diff.mismatched.length, 1);
});

test("diffEntityValues reports missing expected keys", () => {
  const diff = diffEntityValues(READBACK, { field_never_set: "x" });
  assert.equal(diff.verdict, "diff");
  assert.deepEqual(diff.missing, ["field_never_set"]);
});

// ---------------------------------------------------------------------------
// Create-result normalizer
// ---------------------------------------------------------------------------

test("normalizeCreateContentResult keeps the honest error list", () => {
  const r = normalizeCreateContentResult({
    errors: ["SQLSTATE boom"],
    id: 12,
    uuid: "abc",
    bundle: "basic_page",
  });
  assert.equal(r.errors.length, 1);
  assert.equal(r.id, 12);
  assert.equal(normalizeCreateContentResult(null).id, null);
  assert.deepEqual(normalizeCreateContentResult({}).errors, []);
});

// ---------------------------------------------------------------------------
// Snippet construction: payload travels as base64, content never raw
// ---------------------------------------------------------------------------

test("createContentSnippet embeds the payload as base64, never raw text", () => {
  const snippet = createContentSnippet({
    entity_type: "node",
    bundle: "basic_page",
    title: `O'Brien "quotes" ; drop table`,
    published: true,
    fields: { body: [{ value: "hello" }] },
  });
  assert.ok(snippet.includes(phpPayload({
    entity_type: "node",
    bundle: "basic_page",
    title: `O'Brien "quotes" ; drop table`,
    published: true,
    fields: { body: [{ value: "hello" }] },
  })));
  assert.ok(!snippet.includes("drop table"));
  assert.ok(!snippet.includes("O'Brien"));
});

test("entityReadbackSnippet accepts id, uuid, or both", () => {
  assert.ok(entityReadbackSnippet("node", 7, null).length > 0);
  assert.ok(entityReadbackSnippet("node", null, "abc").length > 0);
  assert.ok(entityReadbackSnippet("node", 7, "abc").length > 0);
});

test("createContentWire maps camelCase payload to the snake_case PHP keys", () => {
  const wire = createContentWire({
    entity_type: "node",
    bundle: "basic_page",
    title: "T",
    published: true,
    moderationState: "published",
    alias: "/t",
    fields: {},
  });
  // The snippet reads $p['moderation_state'] and $p['alias'] — the wire shape
  // must carry exactly those keys (the bug: moderationState never matched).
  assert.equal(wire["moderation_state"], "published");
  assert.equal(wire["alias"], "/t");
  assert.ok(!("moderationState" in wire));
  const snippet = createContentSnippet(wire);
  assert.ok(snippet.includes("$p['moderation_state']"));
  // and the encoded payload actually contains the snake_case key
  const b64 = snippet.match(/base64_decode\('([^']+)'\)/)?.[1] ?? "";
  const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  assert.equal(decoded.moderation_state, "published");
});

test("createContentWire omits optional keys when absent", () => {
  const wire = createContentWire({
    entity_type: "node", bundle: "b", title: "T", published: false, fields: {},
  });
  assert.ok(!("alias" in wire));
  assert.ok(!("moderation_state" in wire));
});

// ---------------------------------------------------------------------------
// parseTrailingJson: drush may prepend notices before the returned JSON
// ---------------------------------------------------------------------------

test("parseTrailingJson parses clean output", () => {
  assert.deepEqual(parseTrailingJson('{"a":1}'), { a: 1 });
});

test("parseTrailingJson finds the JSON after warning noise", () => {
  const noisy = 'PHP Warning: something\n> {"deleted":2,"errors":[]}\n';
  const parsed = parseTrailingJson(noisy) as { deleted: number } | null;
  assert.equal(parsed?.deleted, 2);
});

test("parseTrailingJson returns null on garbage", () => {
  assert.equal(parseTrailingJson("no json here at all"), null);
});

// ---------------------------------------------------------------------------
// Shell-joined transport (ddev shims re-join args through a container bash)
// ---------------------------------------------------------------------------

test("shellJoinedEvalArg wraps the program $-free and quote-safe", () => {
  const program = "$r = ['errors' => []];\nreturn json_encode($r);";
  const arg = shellJoinedEvalArg(program);
  // bash -u (unbound variable) must never see a $; the wrapper is one safe
  // one-liner: return eval(base64_decode("<base64>"));
  assert.ok(!arg.includes("$"));
  assert.ok(/^return eval\(base64_decode\("[A-Za-z0-9+/=]+"\)\);$/.test(arg));
  // round-trip: the payload decodes to the original program
  const b64 = arg.match(/base64_decode\("([^"]+)"\)/)?.[1] ?? "";
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), program);
});
