/**
 * Type declarations for the scratch-provisioning module (plain JS). Only the
 * pure safety helpers are typed here for the test suite; the provisioning
 * functions are side-effecting and exercised live, not in unit tests.
 */

export interface ScratchDestInput {
  scratchDir?: string | null;
  scratchProject?: string | null;
  sourceDir?: string | null;
  fixtureSite?: string;
  repoRoot?: string;
}

export type ScratchDestResult =
  | { ok: true; abs: string }
  | { ok: false; reason: string };

export function validateScratchDest(input: ScratchDestInput): ScratchDestResult;
export function isHarnessOwned(dir: string): boolean;

export const SCRATCH_PROJECT: string;
export const SCRATCH_DIR: string;
export const SCRATCH_URL: string;
