// Shared readers for untrusted registry payloads. Versions and timestamps
// become CapabilityRecord fields, so bound them before they travel.

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function record(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function versionOf(value: unknown): string | undefined {
  const version = str(value);
  if (version === undefined) return undefined;
  if (version.length > 200 || /[\u0000-\u001f\u007f]/.test(version)) {
    return undefined;
  }
  return version;
}

export function isoOrUndefined(value: unknown): string | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
