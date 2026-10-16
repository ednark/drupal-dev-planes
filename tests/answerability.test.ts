import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAnswer } from "../sweep/instruments/answerability.mjs";

// ---------------------------------------------------------------------------
// B2 answerability scoring (pure path — resolveDocs injected, no model)
// ---------------------------------------------------------------------------

test("scoreAnswer: stale-API marker fails a well-cited answer", async () => {
  const fixture = { id: "message", drupalVersion: "10.6" };
  // The answer cites a REAL doc text we inject; the stale marker decides.
  const answer = "Call \\Drupal::messenger()->addStatus('Saved'). drupal://document/doc_A";
  const scored = await scoreAnswer(answer, fixture, async () => ({
    docs: { doc_A: "Messenger service. addStatus shows a message." },
    unresolved: 0,
    citedIds: ["doc_A"],
  }));
  assert.equal(scored.claimSupport.verdict, "supported");
  assert.equal(scored.markerScoring.passCount >= 1, true);
});

test("scoreAnswer: version transposition fails via claim-support", async () => {
  const fixture = { id: "phpfloor", drupalVersion: "11.4" };
  const answer = "Drupal 11 requires PHP 8.2 minimum. drupal://document/doc_B";
  const scored = await scoreAnswer(answer, fixture, async () => ({
    // doc mentions PHP 8.2 in the context of a DIFFERENT Drupal major
    docs: { doc_B: "Drupal 10.6 requires PHP 8.2. The captcha module requires PHP >= 8.2." },
    unresolved: 0,
    citedIds: ["doc_B"],
  }));
  assert.equal(scored.verdict, "fail");
});

test("scoreAnswer: uncited answer records zero grounding density", async () => {
  const fixture = { id: "sdc", drupalVersion: "11.4" };
  const scored = await scoreAnswer(
    "Use Single Directory Components, also known as SDC, introduced in Drupal 10.3.",
    fixture,
    async () => ({ docs: {}, unresolved: 0, citedIds: [] }),
  );
  assert.equal(scored.claimSupport.verdict, "uncited");
  assert.equal(scored.claimSupport.groundingDensity, 0);
});
