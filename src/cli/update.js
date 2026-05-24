// Self-update helpers for `firstpass update`. Overridable for tests via
// FIRSTPASS_LATEST_VERSION / FIRSTPASS_REGISTRY_URL / FIRSTPASS_UPDATE_DRY_RUN.

export function compareSemver(a, b) {
  const left = String(a).split("-")[0].split(".");
  const right = String(b).split("-")[0].split(".");
  for (let i = 0; i < 3; i += 1) {
    const da = Number.parseInt(left[i], 10) || 0;
    const db = Number.parseInt(right[i], 10) || 0;
    if (da !== db) {
      return da < db ? -1 : 1;
    }
  }
  return 0;
}

export async function fetchLatestVersion() {
  const override = process.env.FIRSTPASS_LATEST_VERSION;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  const registry = (
    process.env.FIRSTPASS_REGISTRY_URL || "https://registry.npmjs.org"
  ).replace(/\/$/, "");
  const response = await globalThis.fetch(`${registry}/firstpass/latest`);
  if (!response.ok) {
    throw new Error(`registry responded ${response.status}`);
  }
  const body = await response.json();
  if (!body || typeof body !== "object" || typeof body.version !== "string") {
    throw new Error("registry response missing version");
  }
  return body.version;
}

export function isUpdateDryRun() {
  const value = process.env.FIRSTPASS_UPDATE_DRY_RUN;
  return typeof value === "string" && value.length > 0 && value !== "0";
}
