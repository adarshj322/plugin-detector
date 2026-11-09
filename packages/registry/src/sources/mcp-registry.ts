import type { RawCandidate } from "../probe.js";
import {
  httpGetText,
  type HttpGetter,
  type SourceFetch,
} from "./http.js";

export const MCP_REGISTRY_ID = "mcp-registry";
export const MCP_REGISTRY_URL =
  "https://registry.modelcontextprotocol.io/v0/servers";

// v0 registry shape (captured 2026-11-09): each item wraps the server under
// `server` and carries registry bookkeeping under `_meta`. The flat shape is
// kept as a fallback for older mirrors.
interface McpServer {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  version?: unknown;
  repository?: unknown;
  websiteUrl?: unknown;
  remotes?: unknown;
  packages?: unknown;
}

interface McpRegistryItem {
  server?: unknown;
  _meta?: unknown;
  // Legacy flat fields.
  name?: unknown;
  description?: unknown;
  repository?: unknown;
  url?: unknown;
  version?: unknown;
  license?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function repositoryUrl(v: unknown): string | undefined {
  if (typeof v === "string") return str(v);
  return str(record(v)?.["url"]);
}

function firstPackage(v: unknown): { identifier?: string; version?: string } {
  const list = Array.isArray(v) ? v : [];
  for (const item of list) {
    const entry = record(item);
    if (entry === undefined) continue;
    const identifier = str(entry["identifier"]);
    const version = str(entry["version"]);
    if (identifier === undefined) continue;
    return { identifier, ...(version === undefined ? {} : { version }) };
  }
  return {};
}

function firstRemoteUrl(v: unknown): string | undefined {
  const list = Array.isArray(v) ? v : [];
  for (const item of list) {
    const url = str(record(item)?.["url"]);
    if (url !== undefined) return url;
  }
  return undefined;
}

function isLatest(item: McpRegistryItem): boolean {
  const meta = record(item._meta);
  const official = record(meta?.["io.modelcontextprotocol.registry/official"]);
  return official?.["isLatest"] === true;
}

// Never trusts listing fields as artifact evidence: the registry entry is a
// declaration, so the normalized candidate is marked unprobed and stays out of
// recommendations until a release review probes the pinned artifact.
export function parseMcpRegistry(payload: unknown): RawCandidate[] {
  const root = record(payload);
  const items = Array.isArray(root?.["servers"]) ? root["servers"] : [];
  const byId = new Map<string, { raw: RawCandidate; latest: boolean }>();
  for (const value of items as McpRegistryItem[]) {
    const server = record(value.server);
    const id = str(server?.["name"]) ?? str(value.name);
    if (!id) continue;
    const repository = repositoryUrl(server?.["repository"] ?? value.repository);
    const pkg = firstPackage(server?.["packages"]);
    const url =
      repository ??
      firstRemoteUrl(server?.["remotes"]) ??
      str(server?.["websiteUrl"]) ??
      str(value.url);
    const version = str(server?.["version"]) ?? str(value.version);
    const raw: RawCandidate = {
      id,
      name: str(server?.["title"]) ?? id,
      artifact: { kind: "mcp", file: "server.json" },
      artifactProbed: false,
      sourceKind: "community",
      pinnedRef: version ?? pkg.version ?? "0.0.0",
      license: str(value.license) ?? "unknown",
      ...(url === undefined ? { registryUrl: MCP_REGISTRY_URL } : { repositoryUrl: url }),
      ...(pkg.identifier ? { packageName: pkg.identifier } : {}),
      ...(str(server?.["description"]) ?? str(value.description)
        ? { description: str(server?.["description"]) ?? str(value.description) }
        : {}),
    };
    const previous = byId.get(id);
    if (previous === undefined || isLatest(value)) {
      byId.set(id, { raw, latest: isLatest(value) });
    }
  }
  return [...byId.values()].map((entry) => entry.raw);
}

export async function fetchMcpRegistry(
  get: HttpGetter = (url) => httpGetText(url),
): Promise<SourceFetch> {
  const res = await get(MCP_REGISTRY_URL);
  const payload = JSON.parse(res.text) as unknown;
  const raws = parseMcpRegistry(payload);
  const root = record(payload);
  const reported = Array.isArray(root?.["servers"]) ? root["servers"].length : 0;
  // A non-empty payload that maps to zero records is a parser/schema failure,
  // not a successful empty refresh: refresh then keeps the previous entries.
  if (reported > 0 && raws.length === 0) {
    throw new Error(
      `mcp-registry: payload listed ${reported} servers but none matched the expected schema`,
    );
  }
  const fetch: SourceFetch = { raws };
  if (res.etag) fetch.etag = res.etag;
  if (res.lastModified) fetch.lastModified = res.lastModified;
  return fetch;
}
