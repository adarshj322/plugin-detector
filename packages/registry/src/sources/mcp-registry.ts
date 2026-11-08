import type { RawCandidate } from "../probe.js";
import {
  httpGetText,
  type HttpGetter,
  type SourceFetch,
} from "./http.js";

export const MCP_REGISTRY_ID = "mcp-registry";
export const MCP_REGISTRY_URL =
  "https://registry.modelcontextprotocol.io/v0/servers";

interface McpServerItem {
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

// shortcut: listings without a version pin to 0.0.0 (unknown, never a
// branch); upgrade when a source publishes immutable refs we can carry over.
export function parseMcpRegistry(payload: unknown): RawCandidate[] {
  const root = payload as { servers?: unknown };
  const items = Array.isArray(root?.servers) ? root.servers : [];
  const out: RawCandidate[] = [];
  for (const item of items as McpServerItem[]) {
    const id = str(item.name);
    const url = str(item.repository) ?? str(item.url);
    if (!id || !url) continue;
    out.push({
      id,
      name: id,
      artifact: { kind: "mcp", file: "server.json" },
      sourceKind: "community",
      pinnedRef: str(item.version) ?? "0.0.0",
      license: str(item.license) ?? "unknown",
      repositoryUrl: url,
      description: str(item.description),
    });
  }
  return out;
}

export async function fetchMcpRegistry(
  get: HttpGetter = (url) => httpGetText(url),
): Promise<SourceFetch> {
  const res = await get(MCP_REGISTRY_URL);
  const fetch: SourceFetch = { raws: parseMcpRegistry(JSON.parse(res.text)) };
  if (res.etag) fetch.etag = res.etag;
  if (res.lastModified) fetch.lastModified = res.lastModified;
  return fetch;
}
