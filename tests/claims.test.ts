import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkClaimSupport,
  extractValues,
  splitSentences,
  stripCodeBlocks,
} from "../packages/verify/src/claims.js";

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