import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, diffConfig, interpretPageProbe } from "../packages/verify/src/index.js";

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