import { npmPackageUrl } from "./package-registries.js";
import {
  isoOrUndefined,
  record,
  versionOf,
} from "./updates-common.js";

// The npm dist-tag is the registry's own answer to "latest"; never sort the
// versions map locally.
export function npmLatestUrl(name: string): string {
  return npmPackageUrl(name);
}

export interface NpmLatest {
  version: string;
  publishedAt?: string | undefined;
}

export function parseNpmLatest(payload: unknown): NpmLatest | null {
  const root = record(payload);
  if (root === undefined) return null;
  const version = versionOf(record(root["dist-tags"])?.["latest"]);
  if (version === undefined) return null;
  const latest: NpmLatest = { version };
  const publishedAt = isoOrUndefined(record(root["time"])?.[version]);
  if (publishedAt !== undefined) latest.publishedAt = publishedAt;
  return latest;
}
