import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Plane = "knowledge" | "state" | "verification" | "cross-plane";

export interface FailureMode {
  id: string;
  plane: Plane;
  title: string;
  symptom: string;
  rootCause: string;
  detection: string;
  evidenceStatus: "claimed" | "measured";
  citation?: string;
}

interface CatalogFile {
  version: string;
  note: string;
  failureModes: FailureMode[];
}

/** Repo-root data/ regardless of cwd (works from src via tsx and from dist). */
const DEFAULT_DATA_URL = new URL(
  "../../../data/failure-modes.json",
  import.meta.url,
);

export function loadFailureModes(dataPath?: string): FailureMode[] {
  const rows = JSON.parse(
    readFileSync(dataPath ?? fileURLToPath(DEFAULT_DATA_URL), "utf8"),
  ) as CatalogFile;
  if (!Array.isArray(rows.failureModes)) return [];
  return rows.failureModes.filter(
    (row): row is FailureMode =>
      typeof row.id === "string" &&
      typeof row.title === "string" &&
      typeof row.detection === "string" &&
      (row.evidenceStatus === "claimed" || row.evidenceStatus === "measured"),
  );
}