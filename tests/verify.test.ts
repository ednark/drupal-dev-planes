import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalize,
  checkClaimSupport,
  CITATION_RE,
  diffConfig,
  interpretPageProbe,
  loadFailureModes,
  probePage,
  stripCodeBlocks,
  splitSentences,
  extractValues,
  extractSubjects,
} from "../packages/verify/src/index.js";

test("canonicalize is key-order independent", () => {
  assert.equal(canonicalize({ a: 1, b: { c: 2, d: 3 } }), canonicalize({ b: { d: 3, c: 2 }, a: 1 }));
});

test("diffConfig verdicts on missing, mismatched, and matching keys", () => {
  const actual = { name: "demo", front: "/node", mail: "old@example.com" };
  const expected = { name: "demo", front: "/node", mail: "new@example.com", page: "/about" };
  const diff = diffConfig(actual, expected);
  assert.equal(diff.verdict, "diff");
  assert.deepEqual(diff.missing, ["page"]);
  assert.deepEqual(diff.mismatched.map((m) => m.key), ["mail"]);
  assert.deepEqual(diff.extra, []);
});

test("diffConfig match verdict with nested values", () => {
  const diff = diffConfig(
    { page: { front: "/node", title: "Home" } },
    { page: { title: "Home", front: "/node" } },
  );
  assert.equal(diff.verdict, "match");
});

test("diffConfig extra keys only when requested", () => {
  const actual = { a: 1, b: 2 };
  assert.deepEqual(diffConfig(actual, { a: 1 }).extra, []);
  assert.deepEqual(diffConfig(actual, { a: 1 }, true).extra, ["b"]);
});

test("diffConfig subset semantics: extra nested siblings do not fail the match", () => {
  const diff = diffConfig(
    { page: { "403": "", "404": "", front: "/about-the-us" } },
    { page: { front: "/about-the-us" } },
  );
  assert.equal(diff.verdict, "match");
});

test("diffConfig reports nested mismatches with dotted paths", () => {
  const diff = diffConfig(
    { page: { front: "/node" } },
    { page: { front: "/about-the-us" } },
  );
  assert.equal(diff.verdict, "diff");
  assert.equal(diff.mismatched[0]?.key, "page.front");
});

test("interpretPageProbe: 5xx is dead regardless of body", () => {
  const probe = interpretPageProbe(503, "<html>huge error wrapper</html>");
  assert.equal(probe.verdict, "server_error");
});

test("interpretPageProbe: critical-error marker is dead even under 200", () => {
  const probe = interpretPageProbe(200, "The website encountered an unexpected error. Please try again later.");
  assert.equal(probe.verdict, "error_page");
});

test("interpretPageProbe: tiny 200 body is suspicious", () => {
  const probe = interpretPageProbe(200, "x".repeat(54));
  assert.equal(probe.verdict, "suspicious_short");
});

test("interpretPageProbe: normal page is alive", () => {
  const probe = interpretPageProbe(200, "<!doctype html><html>" + "x".repeat(200) + "</html>");
  assert.equal(probe.verdict, "alive");
});

// --- catalog loader (packages/verify) ---

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

test("evidence status is honest: every measured row cites its sweep", () => {
  for (const row of catalog) {
    if (row.evidenceStatus === "measured") {
      assert.ok(
        row.citation && /\d{4}-\d{2}-\d{2}/.test(row.citation),
        `measured row ${row.id} must cite a dated sweep, got: ${row.citation}`,
      );
    }
  }
});

test("failure mode ids are unique", () => {
  const ids = catalog.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
});

// --- claim support (packages/verify) ---

const PHPFLOOR_DOC = JSON.stringify({
  name: "drupal/core_recommended",
  require: { php: ">=8.2", "drupal/core": "self.version" },
});

test("phpfloor regression: version-transposed evidence is unsupported, not supported", () => {
  const answer =
    "Drupal 11 requires a minimum PHP version of 8.2 as stated in composer.json (drupal://document/doc_ABC123).";
  const report = checkClaimSupport(answer, { doc_ABC123: PHPFLOOR_DOC });
  assert.equal(report.verdict, "unsupported");
  const row = report.claims.find((c) => c.verdict === "unsupported");
  assert.ok(row, "expected an unsupported claim row");
  assert.ok(row.versionConflict, "should flag the version assertion");
  assert.match(row.versionConflict, /never mentions Drupal 11|Drupal \d+, claim asserts/);
});

test("claim supported when value sits near its subject", () => {
  const answer =
    "You can show a status message with \\Drupal::messenger()->addStatus() (drupal://document/doc_MSG).";
  const doc =
    "The messenger service collects messages. \\Drupal::messenger()->addStatus('done') adds a status message for the user.";
  const report = checkClaimSupport(answer, { doc_MSG: doc });
  assert.equal(report.verdict, "supported");
});

test("value absent from cited document is unsupported", () => {
  const answer = "Drupal 10 ships with CKEditor 5 by default (drupal://document/doc_CK).";
  const doc = "This document discusses the Filter module and text formats.";
  const report = checkClaimSupport(answer, { doc_CK: doc });
  assert.equal(report.verdict, "unsupported");
  const row = report.claims.find((c) => c.verdict === "unsupported");
  assert.ok(row?.versionConflict, "version-assertion rule should catch the unbacked 'Drupal 10'");
});

test("answer without citations is flagged uncited", () => {
  const report = checkClaimSupport("Use the messenger service to add a status message in Drupal.", {});
  assert.equal(report.verdict, "uncited");
});

test("citations that cannot be resolved are flagged unresolved", () => {
  const answer = "Drupal 11 requires PHP 8.3 (drupal://document/doc_MISSING).";
  const report = checkClaimSupport(answer, {});
  assert.equal(report.verdict, "unresolvable");
});

test("best-of-cited-documents: one supporting document wins", () => {
  const answer = "The \\Drupal::messenger() service shows status messages (drupal://document/doc_A and drupal://document/doc_B).";
  const report = checkClaimSupport(answer, {
    doc_A: "Unrelated chapter about nodes and views.",
    doc_B: "Messages are collected by the messenger service: \\Drupal::messenger()->addStatus().",
  });
  assert.equal(report.verdict, "supported");
});

test("splitSentences ignores fenced code blocks", () => {
  const text = "First claim about messenger.\n```php\ndrupal_set_message('x');\n```\nSecond claim ends here. Third one too.";
  const cleaned = stripCodeBlocks(text);
  assert.ok(!cleaned.includes("drupal_set_message"));
  const sentences = splitSentences(text);
  assert.ok(!sentences.some((s) => s.includes("drupal_set_message")));
  assert.ok(sentences.some((s) => s.startsWith("First claim")));
});

test("extractValues pulls numbers and Drupal identifiers", () => {
  const values = extractValues("Drupal 11 needs PHP 8.3 and \\Drupal\\Core\\Messenger use hook_update_N too.");
  assert.ok(values.includes("8.3"));
  assert.ok(values.some((v) => v.includes("Messenger")), `got: ${JSON.stringify(values)}`);
  assert.ok(values.includes("hook_update_N"), `got: ${JSON.stringify(values)}`);
});
