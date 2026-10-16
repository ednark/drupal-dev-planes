// Sweep runner: pick family + targets, run, write records. One MCP client
// connection per run; fail-fast per target but continue the batch; every
// target ends in a record — including skipped, with a reason (§6).

import process from "node:process";
import { call, connectPlanes, closePlanes } from "./lib/planes.mjs";
import { healthCheck, loadFixtureEnv, MutationRegistry, teardown } from "./lib/fixture.mjs";
import { recordSweepId, writeAbortedMarker, writeRecord } from "./lib/record.mjs";
import { TARGETS } from "./instruments/failure-mode.mjs";
import { loadFixtures, runFixture } from "./instruments/corpus.mjs";
import { askAndScore, connectExpert, closeExpert, ollamaReachable } from "./instruments/answerability.mjs";
import { provisionScratch, recoverToHealthyBase, teardownScratch, SCRATCH_PROJECT, SCRATCH_URL } from "./lib/scratch.mjs";

const RECORDS_DIR = new URL("./records/", import.meta.url).pathname;

/** Module-level so signal handlers can find the active target's registry. */
const registryRef = { current: null };

function log(msg) {
  console.log(msg);
}

function buildRecord({ family, target, startedAt, fixture, registry, reproduce, detect, verdict, reason, notes }) {
  return {
    sweepId: recordSweepId(family, target),
    family,
    target,
    startedAt,
    finishedAt: new Date().toISOString(),
    fixture: { site: fixture.site, url: fixture.url, drupal: fixture.drupal, scratch: fixture.scratch ?? false },
    mutations: registry.declared.map(({ kind, detail, reverted }) => ({ kind, detail, reverted })),
    reproduce,
    detect,
    verdict,
    ...(reason ? { reason } : {}),
    notes,
    model: null,
  };
}

async function runTarget(client, fixture, config, family, target, spec) {
  const startedAt = new Date().toISOString();
  const sweepId = recordSweepId(family, target);
  const registry = new MutationRegistry();

  const gated = typeof spec.requiresExec === "function" ? spec.requiresExec(process.env) : spec.requiresExec;
  if (gated && process.env.DRUPAL_AGENT_ALLOW_EXEC !== "true") {
    return buildRecord({
      family, target, startedAt, fixture, registry,
      reproduce: { verdict: "skipped", detail: "not run" },
      detect: { verdict: "skipped", tool: "n/a", detail: "not run" },
      verdict: "skipped",
      reason: "target writes are gated: set DRUPAL_AGENT_ALLOW_EXEC=true to run this sweep",
      notes: [],
    });
  }

  // Declared mutations up front (principle #4).
  for (const { kind, detail } of spec.mutations(config)) {
    registry.declare(kind, detail);
  }
  const mutation = registry.declared[0] ?? {};
  registryRef.current = registry;

  try {
    const repro = await spec.reproduce.call(spec, {
      client, fixture, config, registry, mutation, mutations: registry.declared, env: process.env,
    });

    if (repro.skipped) {
      return buildRecord({
        family, target, startedAt, fixture, registry,
        reproduce: { verdict: "skipped", detail: repro.skipped },
        detect: { verdict: "skipped", tool: "n/a", detail: "not run — reproduce skipped" },
        verdict: "skipped",
        reason: repro.skipped,
        notes: [],
      });
    }

    const step = { url: repro.url, deadUrl: repro.deadUrl };
    let detect;
    if (repro.reproduce.verdict === "pass") {
      detect = await spec.detect.call(spec, { client, fixture, config, env: process.env }, step);
    } else {
      detect = { verdict: "skipped", tool: "n/a", detail: "not run — failure not reproduced" };
    }

    const verdict =
      repro.reproduce.verdict === "pass" && detect.verdict === "pass" ? "pass"
      : repro.reproduce.verdict === "fail" ? "inconclusive"
      : detect.verdict === "fail" ? "fail"
      : "inconclusive";

    const record = buildRecord({
      family, target, startedAt, fixture, registry,
      reproduce: repro.reproduce,
      detect,
      verdict,
      reason: verdict === "inconclusive"
        ? "failure not reproduced on this fixture — the vulnerable code path may be absent or Drupal changed; never folded into pass rates"
        : undefined,
      notes: [],
    });

    // Deferred reproduction failure detail must surface in the record.
    if (repro.reproduce.verdict === "fail") {
      record.notes.push(`reproduction attempt: ${repro.reproduce.detail}`);
    }

    // Teardown: revert applied mutations, re-verify fixture health (§7).
    const cleanup = await teardown(registry, client, fixture, log);
    record.mutations = registry.declared.map(({ kind, detail, reverted }) => ({ kind, detail, reverted }));
    if (cleanup.errors.length > 0) {
      record.notes.push(`teardown errors: ${cleanup.errors.join("; ")} — aborted marker written`);
      writeAbortedMarker(RECORDS_DIR, record.sweepId, "teardown errors", registry.unreverted());
    }
    if (!cleanup.health.healthy) {
      record.notes.push(`post-teardown fixture UNHEALTHY: ${cleanup.health.detail}`);
    }
    return record;
  } catch (error) {
    const cleanup = await teardown(registry, client, fixture, log).catch((e) => ({ errors: [e.message], health: { healthy: false } }));
    const record = buildRecord({
      family, target, startedAt, fixture, registry,
      reproduce: { verdict: "fail", detail: `instrument threw: ${error.message}`.slice(0, 400) },
      detect: { verdict: "skipped", tool: "n/a", detail: "not run — instrument error" },
      verdict: "fail",
      notes: ["instrument error — check the fixture state"],
    });
    if (cleanup.errors.length > 0) {
      writeAbortedMarker(RECORDS_DIR, record.sweepId, "instrument error during teardown", registry.unreverted());
      record.notes.push(`un-reverted mutations recorded in aborted marker`);
    }
    return record;
  } finally {
    registryRef.current = null;
  }
}

async function main() {
  const [familyArg, targetArg] = process.argv.slice(2);
  if (familyArg === "scratch") {
    await runScratchMode(targetArg);
    return;
  }
  const fixture = loadFixtureEnv();
  const allowExec = process.env.DRUPAL_AGENT_ALLOW_EXEC === "true";

  const phaseOneTargets = ["unpopulated-field-fatal", "library-css-category-assertion", "critical-error-page"];

  let plan;
  if (familyArg === "fm") {
    plan = [{ family: "failure-mode", target: targetArg ?? "all" }];
  } else if (familyArg === "corpus") {
    plan = [{ family: "corpus", target: targetArg ?? "all" }];
  } else {
    plan = [{ family: "failure-mode", target: "all" }, { family: "corpus", target: "all" }];
  }

  // Expand the plan into concrete entries and classify runnability up front,
  // so gated/unavailable targets still end in records without spawning the
  // planes or touching the fixture (§6: every target ends in a record).
  const entries = [];
  for (const item of plan) {
    if (item.family === "corpus") {
      entries.push({ family: "corpus", target: item.target, spec: null });
      continue;
    }
    const targets = item.target === "all" ? phaseOneTargets : [item.target];
    for (const target of targets) {
      const spec = TARGETS[target];
      if (!spec) {
        console.error(`unknown failure-mode target: ${target}`);
        process.exit(1);
      }
      entries.push({ family: "failure-mode", target, spec });
    }
  }

  const execGated = (spec) => {
    const gated = typeof spec.requiresExec === "function" ? spec.requiresExec(process.env) : spec.requiresExec;
    return gated && !allowExec;
  };
  const knowledgeConfigured = Boolean(process.env.DRUPAL_DEV_MCP_COMMAND);
  const corpusRunnable = (e) => e.family === "corpus" && knowledgeConfigured;
  const notRunnable = (spec) => execGated(spec) || (spec.canRun ? !spec.canRun(process.env) : false);
  const runnable = entries.filter((e) => (e.spec && !notRunnable(e.spec)) || corpusRunnable(e));

  const onSignal = (signal) => {
    const unreverted = registryRef.current?.unreverted?.() ?? [];
    if (unreverted.length > 0) {
      const path = writeAbortedMarker(RECORDS_DIR, "session", `received ${signal}`, unreverted);
      console.error(`\naborted marker written: ${path}`);
    }
    process.exit(1);
  };

  // No target will actually run: write skip records and exit without
  // touching the fixture.
  if (runnable.length === 0) {
    for (const e of entries) {
      const record = e.spec
        ? buildRecord({
            family: e.family, target: e.target, startedAt: new Date().toISOString(),
            fixture, registry: new MutationRegistry(),
            reproduce: { verdict: "skipped", detail: "not run" },
            detect: { verdict: "skipped", tool: "n/a", detail: "not run" },
            verdict: "skipped",
            reason: execGated(e.spec)
              ? "target writes are gated: set DRUPAL_AGENT_ALLOW_EXEC=true to run this sweep"
              : "target preconditions unmet (see instruments/failure-mode.mjs canRun)",
            notes: [],
          })
        : {
            sweepId: recordSweepId("corpus", e.target),
            family: "corpus",
            target: e.target,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            fixture: { site: "corpus", url: "drupal-dev-mcp index", drupal: "unknown" },
            mutations: [],
            queries: [],
            retrieval: { verdict: "skipped", detail: "knowledge plane not configured" },
            locatedDocIds: [],
            ledgerProposals: [],
            verdict: "skipped",
            reason: "corpus retrieval requires the knowledge plane: configure DRUPAL_DEV_MCP_COMMAND (see .env.example)",
            notes: [],
            model: null,
          };
      log(`skipped: ${e.target} — ${record.reason}`);
      log(`wrote ${writeRecord(RECORDS_DIR, record)}`);
    }
    log("\nnothing runnable (all targets gated or unavailable) — see sweep/README.md for env setup");
    return;
  }

  const client = await connectPlanes();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const health = await healthCheck(client, fixture);
    if (!health.healthy) {
      console.error(`fixture is unhealthy — refusing to sweep (${health.detail})`);
      process.exit(1);
    }
    log(`fixture ${fixture.site} healthy (${health.detail})`);

    for (const e of entries) {
      if (e.family === "corpus") {
        const { config: corpusConfig, fixtures } = loadFixtures();
        const chosen = e.target === "all" ? fixtures : fixtures.filter((f) => f.id === e.target);
        if (chosen.length === 0) {
          console.error(`unknown corpus fixture: ${e.target}`);
          process.exit(1);
        }

        // B1: deterministic retrieval per fixture.
        const results = new Map();
        for (const fixtureDef of chosen) {
          log(`\n=== corpus ${fixtureDef.id} ===`);
          const startedAt = new Date().toISOString();
          let result;
          try {
            result = await runFixture(client, fixtureDef, corpusConfig);
          } catch (error) {
            result = {
              startedAt,
              fixture: { site: "corpus", url: "drupal-dev-mcp index", drupal: fixtureDef.drupalVersion },
              mutations: [],
              queries: [],
              retrieval: { verdict: "fail", detail: `instrument threw: ${error.message}`.slice(0, 400) },
              locatedDocIds: [],
              ledgerProposals: [],
              answerability: [],
            };
          }
          if (!result.answerability) result.answerability = [];
          results.set(fixtureDef.id, { fixtureDef, startedAt, result, answerability: [] });
          log(`retrieval: ${result.retrieval.verdict} — ${result.retrieval.detail.slice(0, 200)}`);
        }

        // B2: answerability matrix, when models are configured (ask mode by
        // default; research is 4x slower — set SWEEP_ANSWERABILITY_DEPTH=research on demand).
        const b2Models = (process.env.SWEEP_ANSWERABILITY_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (b2Models.length > 0) {
          for (const model of b2Models) {
            const available = await ollamaReachable(process.env);
            const bare = model.replace(/:latest$/, "");
            if (!available || !(available.has(bare) || available.has(model))) {
              for (const { result } of results.values()) {
                result.answerability.push({
                  model, depth: process.env.SWEEP_ANSWERABILITY_DEPTH ?? "ask",
                  verdict: "skipped",
                  reason: `model-server-unavailable (${model})`,
                });
              }
              log(`b2: skipped ${model} — model-server-unavailable`);
              continue;
            }
            log(`\n=== b2 matrix: ${model} ===`);
            const expert = await connectExpert({ ...process.env, OPENAI_AGENT_MODEL: model });
            try {
              for (const { fixtureDef, result } of results.values()) {
                let row;
                try {
                  row = await askAndScore(expert, fixtureDef, model, process.env);
                } catch (error) {
                  row = { model, depth: process.env.SWEEP_ANSWERABILITY_DEPTH ?? "ask", verdict: "error", reason: error.message.slice(0, 200) };
                }
                result.answerability.push(row);
                log(`b2 ${fixtureDef.id}: ${row.verdict}${row.markerScoring ? ` (markers pass=${row.markerScoring.passCount} fail=[${row.markerScoring.failHits}] claims=${row.claimSupport.verdict} density=${row.claimSupport.groundingDensity})` : row.reason ? ` — ${row.reason}` : ""}`);
              }
            } finally {
              await closeExpert(expert);
            }
          }
        } else {
          log("\nb2: SWEEP_ANSWERABILITY_MODELS not set — answerability matrix skipped (run sweep:answerability)");
        }

        for (const { fixtureDef, startedAt, result } of results.values()) {
          const record = {
            sweepId: recordSweepId("corpus", fixtureDef.id),
            family: "corpus",
            target: fixtureDef.id,
            startedAt,
            finishedAt: new Date().toISOString(),
            fixture: result.fixture,
            mutations: result.mutations,
            queries: result.queries,
            retrieval: result.retrieval,
            locatedDocIds: result.locatedDocIds,
            ledgerProposals: result.ledgerProposals,
            answerability: result.answerability,
            verdict: result.retrieval.verdict,
            notes: [],
            model: b2Models.length > 0 ? b2Models : null,
          };
          log(`wrote ${writeRecord(RECORDS_DIR, record)}`);
        }
        continue;
      }
      if (execGated(e.spec) || (e.spec.canRun && !e.spec.canRun(process.env))) {
        const record = buildRecord({
          family: e.family, target: e.target, startedAt: new Date().toISOString(),
          fixture, registry: new MutationRegistry(),
          reproduce: { verdict: "skipped", detail: "not run" },
          detect: { verdict: "skipped", tool: "n/a", detail: "not run" },
          verdict: "skipped",
          reason: execGated(e.spec)
            ? "target writes are gated: set DRUPAL_AGENT_ALLOW_EXEC=true to run this sweep"
            : "target preconditions unmet (see instruments/failure-mode.mjs canRun)",
          notes: [],
        });
        log(`skipped: ${e.target} — ${record.reason}`);
        log(`wrote ${writeRecord(RECORDS_DIR, record)}`);
        continue;
      }
      log(`\n=== sweep ${e.target} ===`);
      const record = await runTarget(client, fixture, fixture, e.family, e.target, e.spec);
      log(`verdict: ${record.verdict}${record.reason ? ` — ${record.reason}` : ""}`);
      log(`wrote ${writeRecord(RECORDS_DIR, record)}`);
    }

    const postHealth = await healthCheck(client, fixture);
    log(`\npost-sweep fixture health: ${postHealth.healthy ? "healthy" : `UNHEALTHY (${postHealth.detail})`}`);
  } finally {
    await closePlanes(client);
  }
}

main().catch((error) => {
  console.error("sweep runner failed:", error);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Scratch mode (A2): provision the dedicated scratch ddev project, connect a
// planes client bound to it, run the A2 targets, tear down per policy.
// Target order matters: install-order needs a FRESH install (it IS the
// reproduction); undeclared + half-install run on the post-install scratch.
// ---------------------------------------------------------------------------

async function runScratchMode(targetArg) {
  const order = ["install-order-subscriber-crash", "half-install-state", "undeclared-service-dependency"];
  const targets = targetArg && targetArg !== "all" ? [targetArg] : order;
  const needsFresh = targets.includes("install-order-subscriber-crash");

  log(`scratch mode: project ${SCRATCH_PROJECT} at ${SCRATCH_URL} (targets: ${targets.join(", ")})`);
  const scratch = await provisionScratch(log, { fresh: needsFresh || process.env.SWEEP_SCRATCH_FRESH === "1" });

  const fixture = {
    site: SCRATCH_PROJECT,
    url: SCRATCH_URL,
    drupal: process.env.SWEEP_FIXTURE_DRUPAL ?? "10.6",
    scratch: true,
    installError: scratch.installError ?? null,
  };

  const client = await connectPlanes({
    DDEV_PROJECT: scratch.project,
    SWEEP_FIXTURE_URL: scratch.url,
    SWEEP_HEALTH_URL: scratch.url,
  });
  const registryRefLocal = { current: null };
  const onSignalScratch = (signal) => {
    const unreverted = registryRefLocal.current?.unreverted?.() ?? [];
    if (unreverted.length > 0) {
      writeAbortedMarker(RECORDS_DIR, "scratch-session", `received ${signal}`, unreverted);
    }
    process.exit(1);
  };
  process.on("SIGINT", () => onSignalScratch("SIGINT"));
  process.on("SIGTERM", () => onSignalScratch("SIGTERM"));

  try {
    // Health is recorded, not gating: A2 targets EXPECT broken states.
    const health = await healthCheck(client, fixture);
    log(`scratch health (informational): ${health.healthy ? "healthy" : health.verdict}`);

    // install-order runs against the CRASHED state (its detect reads the
    // half-installed bootstrap); everything after it needs the healthy base.
    if (fixture.installError) {
      const idx = targets.indexOf("install-order-subscriber-crash");
      if (idx !== -1) {
        const spec = TARGETS["install-order-subscriber-crash"];
        log(`\n=== scratch sweep install-order-subscriber-crash ===`);
        const record = await runTarget(client, fixture, fixture, "failure-mode", "install-order-subscriber-crash", spec);
        log(`verdict: ${record.verdict}${record.reason ? ` — ${record.reason}` : ""}`);
        log(`wrote ${writeRecord(RECORDS_DIR, record)}`);
        targets.splice(idx, 1);
      }
      await recoverToHealthyBase(log);
    }

    for (const target of targets) {
      const spec = TARGETS[target];
      if (!spec?.scratch) {
        console.error(`unknown or non-scratch target: ${target}`);
        process.exit(1);
      }
      log(`\n=== scratch sweep ${target} ===`);
      const record = await runTarget(client, fixture, fixture, "failure-mode", target, spec);
      log(`verdict: ${record.verdict}${record.reason ? ` — ${record.reason}` : ""}`);
      log(`wrote ${writeRecord(RECORDS_DIR, record)}`);
    }
  } finally {
    await closePlanes(client);
    await teardownScratch(log, { keep: process.env.SWEEP_SCRATCH_KEEP === "1" });
  }
}
