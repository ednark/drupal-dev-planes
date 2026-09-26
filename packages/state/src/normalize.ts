/**
 * Normalizers for drush output. Written defensively against Drush 12 shapes
 * (which vary between commands and between human/JSON formats) and NOT yet
 * swept against a live install — see docs/architecture.md "Honest status".
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface SiteStatus {
  drupalVersion?: string;
  phpVersion?: string;
  databaseDriver?: string;
  siteRoot?: string;
  siteName?: string;
  bootstrap?: string;
}

export function normalizeStatus(raw: unknown): SiteStatus {
  const json = asRecord(raw);
  return {
    drupalVersion: str(json["drupal-version"] ?? json["Drupal version"]),
    phpVersion: str(json["php-version"] ?? json["PHP CLI"] ?? json["php"]),
    databaseDriver: str(json["db-driver"] ?? json["Database driver"]),
    siteRoot: str(json["root"] ?? json["Drupal root"]),
    siteName: str(json["site"] ?? json["Site name"]),
    bootstrap: str(json["bootstrap"] ?? json["Drupal bootstrap"]),
  };
}

export interface SiteModule {
  machineName: string;
  label?: string;
  package?: string;
  version?: string;
  status: "enabled" | "disabled" | "unknown";
}

/** Accepts both the array shape and the object-keyed-by-project shape. */
export function normalizeModules(raw: unknown): SiteModule[] {
  let rows: unknown[] = [];
  if (Array.isArray(raw)) {
    rows = raw;
  } else {
    const record = asRecord(raw);
    rows = Object.entries(record).map(([key, value]) => ({
      name: key,
      ...(asRecord(value)),
    }));
  }

  return rows
    .map((row) => {
      const r = asRecord(row);
      const machineName = str(r["name"] ?? r["machine_name"] ?? r["id"]) ?? "";
      const statusRaw = (str(r["status"]) ?? "").toLowerCase();
      const status: SiteModule["status"] = statusRaw.includes("enabl")
        ? "enabled"
        : statusRaw.includes("disabl") || statusRaw === "uninstalled"
          ? "disabled"
          : "unknown";
      return {
        machineName,
        label: str(r["label"] ?? r["title"]),
        package: str(r["package"] ?? r["provider"]),
        version: str(r["version"]),
        status,
      };
    })
    .filter((m) => m.machineName !== "");
}

/**
 * drush config:get KEY.SUBKEY --format=json sometimes returns the bare value
 * and sometimes { "KEY.SUBKEY": value }. Unwrap the single-key wrapper when
 * it matches what was requested; otherwise pass through.
 */
export function normalizeConfigValue(raw: unknown, requestedKey?: string): unknown {
  if (requestedKey === undefined) return raw;
  const record = asRecord(raw);
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === requestedKey) return record[requestedKey];
  return raw;
}

const SECRET_KEY =
  /(^|[_\-.])(pass(word)?|secret|token|credential|auth|api[_\-.]?key)([_\-.]|$)|api[_\-.]?key/i;

/** Recursively mask credential-looking keys before anything leaves the server. */
export function maskSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[masked]" : maskSecrets(val, depth + 1);
    }
    return out;
  }
  return value;
}