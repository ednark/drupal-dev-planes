// Fixture connection and mutation registry. Sweeps assume a healthy fixture;
// every mutation is declared up front, reverted in teardown, and a crashed
// sweep leaves an aborted marker listing what is un-reverted (§7).

import { call } from "./planes.mjs";

export function loadFixtureEnv(env = process.env) {
  const url = env.SWEEP_FIXTURE_URL ?? "https://usagov2021.ddev.site";
  return {
    site: env.SWEEP_FIXTURE_SITE ?? "usagov2021",
    url,
    healthUrl: env.SWEEP_HEALTH_URL ?? url,
    drupal: env.SWEEP_FIXTURE_DRUPAL ?? "10.6",
    sourceDir: env.SWEEP_SITE_SOURCE_DIR ?? null, // host-side checkout, for bad-patches
  };
}

export async function healthCheck(client, fixture) {
  const probe = await call(client, "verify_page", { url: fixture.healthUrl });
  const verdict = probe?.data?.verdict;
  return {
    healthy: verdict === "alive",
    verdict,
    detail: `health probe on ${fixture.healthUrl} -> ${probe?.status}/${verdict}`,
  };
}

/**
 * Mutations are declared before any apply. Each entry carries its kind,
 * detail, and a revert() closure; teardown reverts all applied mutations,
 * re-declares nothing, and reports what could not be reverted.
 */
export class MutationRegistry {
  constructor() {
    this.declared = [];
    this.appliedEntries = [];
  }

  declare(kind, detail) {
    this.declared.push({ kind, detail, reverted: false });
    return this.declared[this.declared.length - 1];
  }

  /** Record that a declared mutation was applied, with its revert closure. */
  markApplied(entry, revertFn) {
    entry.revert = revertFn;
    this.appliedEntries.push(entry);
    return entry;
  }

  markReverted(entry) {
    entry.reverted = true;
  }

  unreverted() {
    return this.appliedEntries.filter((m) => !m.reverted).map(({ kind, detail }) => ({ kind, detail }));
  }
}

export async function teardown(registry, client, fixture, log = () => {}) {
  const errors = [];
  for (const entry of [...registry.appliedEntries].reverse()) {
    if (entry.reverted) continue;
    try {
      await entry.revert(client, fixture);
      registry.markReverted(entry);
      log(`reverted: ${entry.kind} — ${entry.detail}`);
    } catch (error) {
      errors.push(`${entry.kind}: ${error.message}`);
    }
  }
  let health = await healthCheck(client, fixture);
  if (!health.healthy) {
    // Restore + cache rebuild can leave the first probe settling (opcache /
    // page cache); retry once before declaring the fixture unhealthy.
    await new Promise((r) => setTimeout(r, 2000));
    health = await healthCheck(client, fixture);
  }
  return { errors, health };
}
