// Family A instrument: reproduce → detect → assert, per catalog target.
//
// reproduce: make the failure EXIST on the fixture (raw primitives, below
//   the guarded write surface — the sweep is the one legitimate user of the
//   escape hatch; the guarded surface exists to protect agents, not sweeps).
// detect: run the catalog row's detection recipe through the real plane
//   tools. A sweep that bypasses the planes tests nothing about them.
//
// Verdict semantics (closed enum):
//   record.verdict "pass"         — failure reproduced AND recipe caught it
//   record.verdict "inconclusive" — failure NOT reproduced (fixture lacks the
//                                   vulnerable path, or Drupal changed);
//                                   never folded into pass rates
//   record.verdict "fail"         — failure existed but the recipe MISSED it
//   record.verdict "skipped"      — target preconditions unmet, reason given

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { call, exitOf, envelopeDiag } from "../lib/planes.mjs";
import { SCRATCH_PROJECT as SCRATCH_PROJECT_NAME, SCRATCH_DIR as SCRATCH_PROJECT_DIR } from "../lib/scratch.mjs";

const execFileAsync = promisify(execFile);
const SWEEP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BAD_PATCH = join(SWEEP_DIR, "bad-patches", "usagov-carousel-css-category.patch");

// Fixture-specific reproduction constants (usagov-2021); overridable via env.
const MODULE_FILE =
  process.env.SWEEP_FM_MODULE_FILE ??
  "web/modules/custom/usagov_benefit_category_search/usagov_benefit_category_search.module";
const GUARD_PARENT =
  process.env.SWEEP_FM_GUARD_PARENT ?? "0023e7e5d3ae4423d6f1db1d6c309cd74b7c0c57";

async function cr(client) {
  return call(client, "drush_dispatch", { args: ["cr"], timeout_ms: 120_000 });
}

// ---------------------------------------------------------------------------
// Target: unpopulated-field-fatal (measured row — re-prove + re-graduate).
// The fixture carries the upstream guard commit, so full reproduction needs
// unpatch mode: SWEEP_FM_UNPATCH=1 checks out the pre-guard module file
// (declared file-edit mutation), reproduces the fatal, and restores it in
// teardown. Without unpatch mode the sweep records `inconclusive` honestly:
// the fix is present, the failure is historical.
// ---------------------------------------------------------------------------

const unpopulatedFieldFatal = {
  requiresExec: true,
  canRun: (env) => env.SWEEP_FM_UNPATCH === "1" && Boolean(env.SWEEP_SITE_SOURCE_DIR),
  mutations: () => [
    {
      kind: "file-edit",
      detail: `checkout pre-guard version of ${MODULE_FILE} (guard parent ${GUARD_PARENT.slice(0, 7)})`,
    },
  ],
  async reproduce(ctx) {
    if (process.env.SWEEP_FM_UNPATCH !== "1" || !ctx.config.sourceDir) {
      return { skipped: "this fixture carries the guard fix; set SWEEP_FM_UNPATCH=1 to check out the pre-guard module file" };
    }
    try {
      await execFileAsync("git", ["checkout", GUARD_PARENT, "--", MODULE_FILE], {
        cwd: ctx.config.sourceDir,
      });
    } catch (error) {
      return { skipped: `unpatch checkout failed: ${error.stderr ?? error.message}`.slice(0, 300) };
    }
    await ctx.registry.markApplied(ctx.mutations[0], async (client) => {
      await execFileAsync("git", ["checkout", "HEAD", "--", MODULE_FILE], {
        cwd: ctx.config.sourceDir,
      });
      await cr(client);
    });
    await cr(ctx.client);
    const crResult = await cr(ctx.client); // second rebuild for good measure
    const crDetail = `cr exit=${crResult?.data?.exitCode} stderr=${(crResult?.data?.stderr ?? "").slice(0, 100)}`;
    // Fixture drift since the 2026-09-26 citation: field_page_type is now
    // REQUIRED on basic_page and content_moderation drafts fresh nodes (403
    // for anonymous), so creating a fresh node no longer triggers the fatal.
    // The trigger is now render-path-shaped: ANY published basic_page with an
    // empty field_page_type fatals sitewide under the unguarded code — the
    // fixture's five rebuilt pages all have the field empty.
    const probe = await call(ctx.client, "verify_page", { url: ctx.fixture.url });
    const verdict = probe?.data?.verdict;
    return {
      ok: true,
      deadUrl: ctx.fixture.url,
      reproduce: {
        verdict: verdict === "server_error" ? "pass" : "fail",
        detail: `pre-guard code + cr (${crDetail}), front page (basic_page, empty field_page_type) probe -> ${probe?.status}/${verdict} (citation: 500 2090-2229B sitewide)`,
      },
    };
  },
  async detect(ctx, step) {
    const probe = await call(ctx.client, "verify_page", { url: step.deadUrl });
    const verdict = probe?.data?.verdict;
    return {
      verdict: verdict === "server_error" ? "pass" : "fail",
      tool: "verify_page",
      detail: `detection recipe on ${step.deadUrl} -> verdict=${verdict} (recipe must flag the page dead)`,
    };
  },
};

// ---------------------------------------------------------------------------
// Target: library-css-category-assertion (measured row — bad-patch + revert)
// ---------------------------------------------------------------------------

const libraryCssCategoryAssertion = {
  requiresExec: true,
  canRun: (env) => Boolean(env.SWEEP_SITE_SOURCE_DIR) && existsSync(BAD_PATCH),
  mutations: () => [
    {
      kind: "file-edit",
      detail: "git apply carousel css-category bad patch (induced sitewide 500)",
    },
  ],
  async reproduce(ctx) {
    if (!ctx.config.sourceDir || !existsSync(BAD_PATCH)) {
      return { skipped: `bad-patch ${BAD_PATCH} or SWEEP_SITE_SOURCE_DIR unavailable` };
    }
    try {
      await execFileAsync("git", ["apply", BAD_PATCH], { cwd: ctx.config.sourceDir });
    } catch (error) {
      return { skipped: `git apply failed (already applied?): ${error.stderr ?? error.message}`.slice(0, 300) };
    }
    await ctx.registry.markApplied(ctx.mutations[0], async (client) => {
      await execFileAsync("git", ["apply", "-R", BAD_PATCH], { cwd: ctx.config.sourceDir });
      await cr(client);
    });
    const crResult = await cr(ctx.client);
    const crDetail = `cr exit=${crResult?.data?.exitCode} stderr=${(crResult?.data?.stderr ?? "").slice(0, 120)}`;
    let probe = await call(ctx.client, "verify_page", { url: ctx.fixture.url });
    let verdict = probe?.data?.verdict;
    // Page cache can serve a pre-patch 200 on the first probe; retry once
    // after a fresh cache rebuild before declaring the failure absent.
    if (verdict === "alive") {
      await cr(ctx.client);
      probe = await call(ctx.client, "verify_page", { url: ctx.fixture.url });
      verdict = probe?.data?.verdict;
    }
    return {
      ok: true,
      deadUrl: ctx.fixture.url,
      reproduce: {
        verdict: verdict === "server_error" || verdict === "error_page" ? "pass" : "fail",
        detail: `after bad patch + cr (${crDetail}), front page probe -> ${probe?.status}/${verdict} (citation: 500/3745B before fix)`,
      },
    };
  },
  async detect(ctx, step) {
    const probe = await call(ctx.client, "verify_page", { url: step.deadUrl });
    const verdict = probe?.data?.verdict;
    return {
      verdict: verdict === "server_error" || verdict === "error_page" ? "pass" : "fail",
      tool: "verify_page",
      detail: `detection recipe on the patched front page -> verdict=${verdict}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Target: critical-error-page (claimed row — threshold re-measurement).
// Two reproduction paths: a controlled SWEEP_DEAD_URL, or (default) the
// carousel bad patch as the induced dead page. Both revert in teardown.
// ---------------------------------------------------------------------------

const criticalErrorPage = {
  requiresExec: (env) => !env.SWEEP_DEAD_URL, // patch path needs drush_dispatch cr
  canRun: (env) => Boolean(env.SWEEP_DEAD_URL) || (Boolean(env.SWEEP_SITE_SOURCE_DIR) && existsSync(BAD_PATCH)),
  mutations: () =>
    process.env.SWEEP_DEAD_URL
      ? []
      : [
          {
            kind: "file-edit",
            detail: "git apply carousel bad patch (controlled dead page for threshold re-measurement)",
          },
        ],
  async reproduce(ctx) {
    let deadUrl = ctx.env.SWEEP_DEAD_URL;
    if (!deadUrl) {
      if (!ctx.config.sourceDir || !existsSync(BAD_PATCH)) {
        return { skipped: `needs SWEEP_DEAD_URL or the bad patch (${BAD_PATCH}) with SWEEP_SITE_SOURCE_DIR` };
      }
      try {
        await execFileAsync("git", ["apply", BAD_PATCH], { cwd: ctx.config.sourceDir });
      } catch (error) {
        return { skipped: `git apply failed: ${error.stderr ?? error.message}`.slice(0, 300) };
      }
      await ctx.registry.markApplied(ctx.mutations[0], async (client) => {
        await execFileAsync("git", ["apply", "-R", BAD_PATCH], { cwd: ctx.config.sourceDir });
        await cr(client);
      });
      await cr(ctx.client);
      deadUrl = ctx.fixture.url;
    }
    const probe = await call(ctx.client, "verify_page", { url: deadUrl });
    const verdict = probe?.data?.verdict;
    return {
      ok: true,
      deadUrl,
      reproduce: {
        verdict: ["server_error", "error_page", "suspicious_short"].includes(verdict) ? "pass" : "fail",
        detail: `controlled dead page ${deadUrl} -> ${probe?.status}/${verdict} (byteSize=${probe?.data?.byteSize})`,
      },
    };
  },
  async detect(ctx, step) {
    const probe = await call(ctx.client, "verify_page", { url: step.deadUrl });
    const verdict = probe?.data?.verdict;
    return {
      verdict: ["server_error", "error_page", "suspicious_short"].includes(verdict) ? "pass" : "fail",
      tool: "verify_page",
      detail: `thresholds re-measured: 5xx=dead, marker=dead, <64B-200=suspicious -> got ${verdict} (byteSize=${probe?.data?.byteSize})`,
    };
  },
};

// ---------------------------------------------------------------------------
// A2 targets (scratch fixture required — sweep-harness-plan §4 A2 policy).
// Each declares `scratch: true`; the runner provisions the scratch ddev
// project and connects a dedicated planes client bound to it. These are
// run on demand via `npm run sweep:scratch -- <target>`, never per-run.
// ---------------------------------------------------------------------------

const CRASH_RE = /non-existent service|ServiceNotFoundException|has a dependency on a non-existent/i;

const installOrderSubscriberCrash = {
  scratch: true,
  requiresExec: true,
  mutations: () => [
    { kind: "scratch-install", detail: "fresh site:install --existing-config on the scratch project (usagov_benefit_finder_api enabled in the config sync's core.extension before `file` is available)" },
  ],
  async reproduce(ctx) {
    // The provisioning IS the reproduction: the install crashes half-way with
    // a container-compile fatal when the enabled-in-config module's services
    // reference a not-yet-available dependency. The runner hands the captured
    // install error through ctx.fixture.installError.
    const err = ctx.fixture.installError ?? "";
    if (!err) {
      return {
        ok: false,
        reproduce: { verdict: "inconclusive", detail: "no install error captured — the scratch install completed; the crash did not reproduce" },
      };
    }
    return {
      ok: true,
      reproduce: {
        verdict: CRASH_RE.test(err) ? "pass" : "fail",
        detail: `site:install crashed mid-install: ${err.slice(0, 260).replace(/\n/g, " ")}`,
      },
    };
  },
  async detect(ctx) {
    // Detection recipe: bootstrap is degraded while the module remains in
    // core.extension — the planes' state plane reports it honestly.
    const status = await call(ctx.client, "get_site_status", {});
    const degraded = status.status !== "ok";
    const probe = await call(ctx.client, "verify_page", { url: ctx.fixture.url });
    const dead = ["server_error", "error_page", "fetch_failed"].includes(probe?.data?.verdict);
    return {
      verdict: degraded || dead ? "pass" : "fail",
      tool: "get_site_status + verify_page",
      detail: `bootstrap=${status?.status ?? "unavailable"}, front page=${probe?.data?.verdict ?? "unavailable"} (recipe must catch the half-installed state)`,
    };
  },
};

const STUB_SRC = join(SWEEP_DIR, "bad-patches", "stub-undeclared-module");
const STUB_DEST = "web/modules/custom/sweep_stub_dep";
const STUB_MODULE = "sweep_stub_dep";

async function installStub(ctx) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  await run("cp", ["-r", STUB_SRC, join(SCRATCH_PROJECT_DIR, STUB_DEST)], { timeout: 60_000 });
  return async () => {
    await run("rm", ["-rf", join(SCRATCH_PROJECT_DIR, STUB_DEST)], { timeout: 60_000 });
  };
}

const halfInstallState = {
  scratch: true,
  requiresExec: true,
  mutations: () => [
    { kind: "stub-module", detail: `copy sweep_stub_dep (service references non-existent sweep.missing_service) into the scratch site, then pm:enable it (bricks bootstrap)` },
  ],
  async reproduce(ctx) {
    const revert = await installStub(ctx);
    await ctx.registry.markApplied(ctx.mutations[0], revert);
    const enable = await call(ctx.client, "drush_dispatch", {
      args: ["pm:enable", STUB_MODULE, "-y"], timeout_ms: 120_000,
    });
    const status = await call(ctx.client, "get_site_status", {});
    const modules = await call(ctx.client, "list_site_modules", {});
    const enableExit = exitOf(enable);
    const bricked = enableExit !== 0 || status.status !== "ok";
    return {
      ok: true,
      reproduce: {
        verdict: bricked ? "pass" : "fail",
        detail: `pm:enable stub exit=${enableExit}${envelopeDiag(enable)}, stderr=${(enable?.data?.stderr ?? "").slice(0, 150).replace(/\n/g, " ")}; bootstrap=${status?.status ?? "unavailable"}, pm:list=${modules?.status ?? "unavailable"} (bricked=${bricked})`,
      },
    };
  },
  async detect(ctx) {
    // Detection recipe: the repair script removes the half-installed module
    // from core.extension via DIRECT DB access (PDO — no Drupal bootstrap).
    // It must run through plain `ddev exec php`, NOT through drush_dispatch:
    // drush boots first and dies on a bricked site. The sweep is the
    // legitimate user of this escape hatch; recovery is then verified through
    // the planes — including a DEEP check (pm:list), because get_site_status
    // alone reported "recovered" on a site whose module handler was broken.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    let repairExit = "?";
    try {
      await run("ddev", ["-p", SCRATCH_PROJECT_NAME, "exec", "php", "scripts/agent-planes/repair-core-extension.php", STUB_MODULE], { timeout: 300_000 });
      repairExit = 0;
    } catch (e) {
      repairExit = e.code ?? 1;
    }
    const cr = await call(ctx.client, "drush_dispatch", { args: ["cr"], timeout_ms: 120_000 });
    const status = await call(ctx.client, "get_site_status", {});
    const modules = await call(ctx.client, "list_site_modules", {});
    const recovered = status.status === "ok" && modules.status === "ok";
    return {
      verdict: recovered ? "pass" : "fail",
      tool: "repair script (ddev exec php, PDO-direct) + cr + get_site_status + list_site_modules",
      detail: `repair exit=${repairExit}, cr exit=${cr?.data?.exitCode}, bootstrap=${status?.status}, pm:list=${modules?.status} (deep recovery check; recipe must unbrick)`,
    };
  },
};

const undeclaredServiceDependency = {
  scratch: true,
  requiresExec: true,
  mutations: () => [
    { kind: "pm-enable-attempt", detail: `pm:enable sweep_stub_dep (declares no dependency; its service references a non-existent one)` },
  ],
  async reproduce(ctx) {
    // On the healthy scratch: the enable attempt must fatal at container
    // compile, naming the missing service (the measured failure class of
    // usagov_benefit_finder_api's undeclared file.repository dependency,
    // captured at install time in the install-order record).
    const revert = await installStub(ctx);
    await ctx.registry.markApplied(ctx.mutations[0], revert);
    const attempt = await call(ctx.client, "drush_dispatch", {
      args: ["pm:enable", STUB_MODULE, "-y"], timeout_ms: 120_000,
    });
    const stderr = String(attempt?.data?.stderr ?? "") + String(attempt?.data?.stdout ?? "");
    return {
      ok: true,
      reproduce: {
        verdict: exitOf(attempt) !== 0 && CRASH_RE.test(stderr) ? "pass" : "fail",
        detail: `pm:enable stub exit=${exitOf(attempt)}${envelopeDiag(attempt)}, fatal=${(stderr.match(CRASH_RE) ? "named missing service" : "not captured")}, stderr=${stderr.slice(0, 180).replace(/\n/g, " ")}`,
      },
    };
  },
  async detect(ctx) {
    // Detection recipe, measured 2026-10-16: the failed enable HALF-COMMITS —
    // the module remains in core.extension even though pm:enable fataled.
    // The hazard is the NEXT container rebuild: `drush cr` must fatal naming
    // the missing service, which proves the half-commit is live and dangerous.
    const cr = await call(ctx.client, "drush_dispatch", { args: ["cr"], timeout_ms: 120_000 });
    const out = String(cr?.data?.stderr ?? "") + String(cr?.data?.stdout ?? "");
    const crFailed = cr?.data?.exitCode !== 0;
    const caught = crFailed && CRASH_RE.test(out);
    return {
      verdict: caught ? "pass" : "fail",
      tool: "drush_dispatch(cr) — half-commit hazard check",
      detail: `post-failed-enable cr exit=${exitOf(cr)}, fatal=${CRASH_RE.test(out) ? "named the missing service" : "not captured"} (recipe must catch the half-committed module)`,
    };
  },
};

export const TARGETS = {
  "unpopulated-field-fatal": unpopulatedFieldFatal,
  "library-css-category-assertion": libraryCssCategoryAssertion,
  "critical-error-page": criticalErrorPage,
  "install-order-subscriber-crash": installOrderSubscriberCrash,
  "half-install-state": halfInstallState,
  "undeclared-service-dependency": undeclaredServiceDependency,
};
