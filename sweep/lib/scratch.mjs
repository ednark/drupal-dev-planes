// Scratch fixture provisioning (sweep-harness-plan §4 A2 policy): A2 sweeps
// never touch the working fixture. They run against a dedicated ddev project
// provisioned from the same repo checkout: local git clone (shared objects),
// composer install inside the container, then site:install --existing-config.
// Provisioning is 15+ minutes; a provisioned scratch is reused unless
// SWEEP_SCRATCH_FRESH=1, and torn down (ddev remove) unless --keep.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const SWEEP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH_PROFILE = process.env.SWEEP_SCRATCH_PROFILE ?? "minimal";

export const SCRATCH_PROJECT = process.env.SWEEP_SCRATCH_PROJECT ?? "usagov-sweep-scratch";
export const SCRATCH_DIR = process.env.SWEEP_SCRATCH_DIR ?? join(dirname(SWEEP_DIR), "..", "usagov-sweep-scratch");
const SOURCE_DIR = process.env.SWEEP_SITE_SOURCE_DIR ?? "";
const SCRATCH_URL = process.env.SWEEP_SCRATCH_URL ?? `https://${SCRATCH_PROJECT}.ddev.site`;

// --- Safety boundary -------------------------------------------------------
// Scratch provisioning is destructive: it can `rmSync` a directory, `ddev
// remove` a project, and DROP a database. "Scratch" must be an enforced
// boundary, not a naming convention, so three things gate every destructive
// step: (1) a pure destination validator, (2) an ownership marker proving the
// harness created the directory, (3) an explicit fresh flag for re-provision.

/** Written into a scratch dir the moment the harness claims it. */
const OWNER_MARKER = ".sweep-scratch-owned";
const REPO_ROOT = resolve(SWEEP_DIR, ".."); // the drupal-dev-planes checkout
const FIXTURE_SITE = process.env.SWEEP_FIXTURE_SITE ?? "usagov2021";

/**
 * Pure destination-safety check. Refuses any scratch destination that could be
 * a real project: a filesystem root, the source checkout (or anything nested
 * in it / containing it), the drupal-dev-planes repo itself, or a project name
 * that collides with the main fixture. Returns {ok:true, abs} or {ok:false,
 * reason}. No filesystem access — unit-testable.
 */
export function validateScratchDest({
  scratchDir,
  scratchProject,
  sourceDir,
  fixtureSite = FIXTURE_SITE,
  repoRoot = REPO_ROOT,
}) {
  if (!scratchDir || typeof scratchDir !== "string") {
    return { ok: false, reason: "scratch dir is not set" };
  }
  const abs = resolve(scratchDir);
  const repo = resolve(repoRoot);
  if (abs === sep || abs === resolve(sep)) {
    return { ok: false, reason: `refusing to use a filesystem root as scratch: ${abs}` };
  }
  if (sourceDir) {
    const src = resolve(sourceDir);
    if (abs === src || abs.startsWith(src + sep) || src.startsWith(abs + sep)) {
      return { ok: false, reason: `scratch dir ${abs} overlaps the source checkout ${src}` };
    }
  }
  if (abs === repo || abs.startsWith(repo + sep)) {
    return { ok: false, reason: `scratch dir ${abs} is inside the drupal-dev-planes repo ${repo}` };
  }
  if (scratchProject && fixtureSite && scratchProject === fixtureSite) {
    return { ok: false, reason: `scratch project '${scratchProject}' collides with the main fixture '${fixtureSite}'` };
  }
  return { ok: true, abs };
}

/** True only if the harness wrote its ownership marker into this directory. */
export function isHarnessOwned(dir) {
  try {
    return existsSync(join(resolve(dir), OWNER_MARKER));
  } catch {
    return false;
  }
}

/** Claim a scratch dir by writing the ownership marker (idempotent). */
function claimOwnership(dir) {
  mkdirSync(dir, { recursive: true });
  const m = join(dir, OWNER_MARKER);
  if (!existsSync(m)) writeFileSync(m, `created by drupal-dev-planes sweep harness ${new Date().toISOString()}\n`);
}

function sh(bin, args, opts = {}) {
  return execFileAsync(bin, args, { timeout: opts.timeoutMs ?? 600_000, ...opts });
}

async function step(label, fn, log) {
  log(`scratch: ${label}...`);
  const out = await fn();
  log(`scratch: ${label} done`);
  return out;
}

/**
 * Provision (or reuse) the scratch ddev project. Returns connection info.
 * Idempotent: a marker file with a completed install skips to reuse.
 */
export async function provisionScratch(log = () => {}, { fresh = false } = {}) {
  if (!SOURCE_DIR) throw new Error("SWEEP_SITE_SOURCE_DIR must point at the usagov-2021 checkout");

  // Safety boundary: refuse before touching anything if the destination could
  // be a real project (source checkout, this repo, a fixture-name collision).
  const dest = validateScratchDest({ scratchDir: SCRATCH_DIR, scratchProject: SCRATCH_PROJECT, sourceDir: SOURCE_DIR });
  if (!dest.ok) throw new Error(`scratch destination refused: ${dest.reason}`);

  const marker = join(SCRATCH_DIR, ".sweep-scratch-installed");

  if (!fresh && existsSync(marker)) {
    log(`scratch: reusing provisioned project at ${SCRATCH_DIR}`);
    // The ddev project may have been removed since; start is idempotent.
    await sh("ddev", ["start"], { cwd: SCRATCH_DIR, timeoutMs: 600_000 }).catch(() => {});
    const errFile = join(SCRATCH_DIR, ".sweep-scratch-install-error");
    const installError = existsSync(errFile) ? readFileSync(errFile, "utf8") : null;
    return { scratchDir: SCRATCH_DIR, project: SCRATCH_PROJECT, url: SCRATCH_URL, reused: true, installError };
  }
  if (fresh) {
    log("scratch: SWEEP_SCRATCH_FRESH=1 — removing previous scratch project + dir");
    // Remove by NAME even if the dir is already gone: stale docker volumes
    // from a previous crashed install would otherwise prompt/abort the new
    // site:install ("You are about to DROP all tables"). ddev only removes its
    // own projects, and the dest validator already ruled out a fixture-name
    // collision, so this cannot target the working site.
    await sh("ddev", ["remove", "-O", SCRATCH_PROJECT]).catch(() => {});
    // Recursive delete is gated on the ownership marker: the harness only
    // ever rmSync's a directory it created. A pre-existing dir without the
    // marker is someone else's project — refuse rather than delete it.
    if (existsSync(SCRATCH_DIR)) {
      if (!isHarnessOwned(SCRATCH_DIR)) {
        throw new Error(`refusing to delete ${SCRATCH_DIR}: not harness-owned (no ${OWNER_MARKER}). Remove it manually if it is safe.`);
      }
      rmSync(SCRATCH_DIR, { recursive: true, force: true });
    }
  }

  if (!existsSync(SCRATCH_DIR)) {
    await step("local clone (shared objects)", async () =>
      sh("git", ["clone", "--shared", SOURCE_DIR, SCRATCH_DIR], { timeoutMs: 600_000 }), log);
  }
  // Claim ownership now that the dir exists, so a later fresh re-provision is
  // allowed to delete it.
  claimOwnership(SCRATCH_DIR);

  if (!existsSync(join(SCRATCH_DIR, ".ddev", "config.yaml"))) {
    await step("ddev config", async () =>
      sh("ddev", [
        "config", "--project-name", SCRATCH_PROJECT,
        "--project-type", "drupal10",
        "--docroot", "web",
        "--php-version", "8.3",
        "--database", "mariadb:11.8",
      ], { cwd: SCRATCH_DIR, timeoutMs: 300_000 }), log);
    // Copy the local settings wiring the working fixture relies on.
    for (const f of ["settings.local.php"]) {
      const src = join(SOURCE_DIR, "web/sites/default", f);
      if (existsSync(src)) {
        mkdirSync(join(SCRATCH_DIR, "web/sites/default"), { recursive: true });
        // settings.local.php references $databases with the container's db
        // service name 'db' — identical in a fresh ddev project, so a plain
        // copy works. The install step will write the rest.
        const content = readSettingsLocal(src);
        writeFileSync(join(SCRATCH_DIR, "web/sites/default", f), content);
      }
    }
  }

  await step("ddev start", async () => sh("ddev", ["start"], { cwd: SCRATCH_DIR, timeoutMs: 600_000 }), log);
  // Composer first: the repo's bin/drush (a host docker-compose wrapper)
  // shadows real drush in the container PATH until vendor/bin exists.
  if (!existsSync(join(SCRATCH_DIR, "vendor", "autoload.php"))) {
    await step("composer install (inside container)", async () =>
      sh("ddev", ["composer", "install", "--no-interaction"], { cwd: SCRATCH_DIR, timeoutMs: 1_800_000 }), log);
  }
  // Guarantee an empty database so site:install never prompts (DROP tables).
  await step("sql:drop -y (guarantee empty db)", async () =>
    sh("ddev", ["exec", "drush", "sql:drop", "-y"], { cwd: SCRATCH_DIR, timeoutMs: 300_000 }), log);
  let installError = null;
  try {
    await step("site:install --existing-config", async () =>
      sh("ddev", ["exec", "drush", "site:install", SCRATCH_PROFILE, "--existing-config", "--no-interaction"], { cwd: SCRATCH_DIR, timeoutMs: 1_800_000 }), log);
    await step("cache rebuild", async () =>
      sh("ddev", ["exec", "drush", "cr"], { cwd: SCRATCH_DIR, timeoutMs: 600_000 }), log);
  } catch (error) {
    // An install crash IS a measured outcome for the install-order row —
    // do not fail provisioning; report the state and let the instrument
    // record what is reachable.
    // Keep stdout AND stderr — drush prints the DI fatal on stdout and the
    // progress notices on stderr — and keep the tail: the fatal comes last.
    const full = String(error.stdout ?? "") + "\n" + String(error.stderr ?? error.message);
    installError = (full.slice(0, 400) + "\n…\n" + full.slice(-1800)).slice(0, 2300);
    log(`scratch: site:install FAILED (recorded as reproduction state): ${installError.slice(0, 200)}`);
    writeFileSync(marker, `${new Date().toISOString()} (install error recorded)\n`);
    writeFileSync(join(SCRATCH_DIR, ".sweep-scratch-install-error"), installError);
    // NO recovery here: the bricked state is the install-order detect's
    // evidence. The runner recovers AFTER that record is written.
    return { scratchDir: SCRATCH_DIR, project: SCRATCH_PROJECT, url: SCRATCH_URL, reused: false, installError, healthyBase: false };
  }

  writeFileSync(marker, new Date().toISOString() + "\n");
  return { scratchDir: SCRATCH_DIR, project: SCRATCH_PROJECT, url: SCRATCH_URL, reused: false };
}

function readSettingsLocal(path) {
  return readFileSync(path, "utf8");
}

/**
 * Recover a HEALTHY base for the stub-module targets: the config-sync
 * install crash is the install-order row's evidence, but half-install and
 * undeclared need a working site. Drop the half-installed DB and do a plain
 * minimal install (no config sync).
 */
export async function recoverToHealthyBase(log = () => {}) {
  // Defense-in-depth: re-validate before dropping the database. The DROP runs
  // inside the scratch container (cwd SCRATCH_DIR), so it can only touch the
  // scratch DB — but never assume the destination is still safe.
  const dest = validateScratchDest({ scratchDir: SCRATCH_DIR, scratchProject: SCRATCH_PROJECT, sourceDir: SOURCE_DIR });
  if (!dest.ok) throw new Error(`scratch recovery refused: ${dest.reason}`);
  await step("recover: drop broken db + plain minimal install", async () => {
    await sh("ddev", ["exec", "mysql", "-hdb", "-udb", "-pdb", "-e", "DROP DATABASE IF EXISTS db; CREATE DATABASE db;"], { cwd: SCRATCH_DIR, timeoutMs: 300_000 });
    await sh("ddev", ["exec", "drush", "site:install", "minimal", "--no-interaction"], { cwd: SCRATCH_DIR, timeoutMs: 1_200_000 });
    await sh("ddev", ["exec", "drush", "cr"], { cwd: SCRATCH_DIR, timeoutMs: 600_000 });
  }, log);
  return true;
}

/** Tear down the scratch project unless kept. */
export async function teardownScratch(log = () => {}, { keep = false } = {}) {
  if (keep) {
    log("scratch: kept (SWEEP_SCRATCH_KEEP=1)");
    return { kept: true };
  }
  // Defense-in-depth: validate the project name before removing it.
  const dest = validateScratchDest({ scratchDir: SCRATCH_DIR, scratchProject: SCRATCH_PROJECT, sourceDir: SOURCE_DIR });
  if (!dest.ok) {
    log(`scratch: teardown refused (${dest.reason}) — leaving the project in place`);
    return { kept: true, refused: dest.reason };
  }
  await sh("ddev", ["remove", "-O", SCRATCH_PROJECT]).catch((e) => {
    log(`scratch: ddev remove failed (${e.message.slice(0, 120)})`);
  });
  log("scratch: ddev project removed (scratch dir kept for reuse; delete it to reclaim disk)");
  return { kept: false };
}

export { SCRATCH_URL };
