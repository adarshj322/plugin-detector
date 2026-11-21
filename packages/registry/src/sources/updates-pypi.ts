import { pypiPackageUrl } from "./package-registries.js";
import {
  isoOrUndefined,
  record,
  versionOf,
} from "./updates-common.js";

// PyPI's unversioned JSON endpoint reports info.version as the current
// release; no release-list comparison is needed.
export function pypiLatestUrl(name: string): string {
  return pypiPackageUrl(name);
}

export interface PypiLatest {
  version: string;
  publishedAt?: string | undefined;
}

export function parsePypiLatest(payload: unknown): PypiLatest | null {
  const root = record(payload);
  if (root === undefined) return null;
  const version = versionOf(record(root["info"])?.["version"]);
  if (version === undefined) return null;
  const latest: PypiLatest = { version };
  const files = Array.isArray(root["urls"]) ? root["urls"] : [];
  const first = record(files[0]);
  const publishedAt = isoOrUndefined(
    first?.["upload_time_iso_8601"] ?? first?.["upload_time"],
  );
  if (publishedAt !== undefined) latest.publishedAt = publishedAt;
  return latest;
}
