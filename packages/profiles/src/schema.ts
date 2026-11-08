import { z } from "zod";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_CAPABILITY_IDS,
  type CanonicalCapabilityId,
} from "@plugin-detector/core";

// Capability entries must be exact canonical IDs: no aliases, no local
// names, no ad-hoc additions (spec: Shared capability taxonomy).
const CanonicalCapability = z
  .string()
  .refine(
    (s): s is CanonicalCapabilityId =>
      (CANONICAL_CAPABILITY_IDS as readonly string[]).includes(s),
    { message: "capability must be a canonical capability ID" },
  );

export const UseCaseProfileSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  displayName: z.string().min(1),
  description: z.string().min(1),
  capabilities: z.array(CanonicalCapability).min(1),
  signalQueries: z.array(z.string().min(1)).min(5).max(12),
  negativeSignals: z.array(z.string().min(1)).min(1),
  defaultDomains: z.array(z.string().min(1)).min(1),
  expectedValueTiers: z.array(z.string().min(1)).min(1),
});
export type V1Profile = z.infer<typeof UseCaseProfileSchema>;

// Minimal YAML-subset parser for the profile shape only: top-level `key:
// scalar` pairs plus top-level `key:` lists of `- item` scalars, `#`
// comments, and blank lines. Anything else (nested maps, inline
// collections, tabs, multiline scalars) throws. No new runtime deps.
type YamlValue = string | number | string[];

function parseScalar(raw: string, source: string, lineNo: number): string | number {
  const value = raw.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.length === 0) throw new Error(`${source}:${lineNo}: empty scalar`);
  if (/[{}\][]/.test(value[0] ?? "")) {
    throw new Error(`${source}:${lineNo}: inline collections are not supported`);
  }
  return value;
}

function parseYamlSubset(text: string, source: string): Record<string, YamlValue> {
  const result: Record<string, YamlValue> = {};
  let currentKey: string | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    if (line.includes("\t")) {
      throw new Error(`${source}:${lineNo}: tabs are not supported`);
    }
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (trimmed.startsWith("-")) {
      if (currentKey === null || indent === 0) {
        throw new Error(`${source}:${lineNo}: list item outside a key block`);
      }
      const item = trimmed.slice(1).trim();
      const list = result[currentKey];
      if (!Array.isArray(list)) {
        throw new Error(`${source}:${lineNo}: list item under scalar key`);
      }
      const scalar = parseScalar(item, source, lineNo);
      if (typeof scalar !== "string") {
        throw new Error(`${source}:${lineNo}: list items must be strings`);
      }
      list.push(scalar);
      continue;
    }
    if (indent > 0) {
      throw new Error(`${source}:${lineNo}: nested maps are not supported`);
    }
    const colon = trimmed.indexOf(":");
    if (colon < 0) throw new Error(`${source}:${lineNo}: expected "key: value"`);
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    if (key.length === 0) throw new Error(`${source}:${lineNo}: empty key`);
    if (key in result) throw new Error(`${source}:${lineNo}: duplicate key ${key}`);
    if (rest.length === 0) {
      result[key] = [];
      currentKey = key;
    } else {
      result[key] = parseScalar(rest, source, lineNo);
      currentKey = null;
    }
  }
  return result;
}

// Parse and validate one profile document; throws on bad YAML or schema.
export function parseProfileText(text: string, source: string): V1Profile {
  return UseCaseProfileSchema.parse(parseYamlSubset(text, source));
}

function defaultProfilesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "profiles");
}

const cache = new Map<string, V1Profile[]>();

// Load every `*.yaml` profile from dir (default: bundled `profiles/`);
// results are cached per directory.
export function loadProfiles(dir: string = defaultProfilesDir()): V1Profile[] {
  const cached = cache.get(dir);
  if (cached) return cached;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  if (files.length === 0) throw new Error(`no profiles found in ${dir}`);
  const profiles = files.map((f) =>
    parseProfileText(readFileSync(join(dir, f), "utf8"), f),
  );
  cache.set(dir, profiles);
  return profiles;
}
