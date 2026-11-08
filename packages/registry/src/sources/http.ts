import type { RawCandidate } from "../probe.js";

// Shared HTTP surface for public source listings: timeout + conditional
// requests (ETag / last-modified) with per-source failure isolation handled
// by the caller. No new runtime deps: global fetch only.
export class NotModified extends Error {
  constructor(readonly url: string) {
    super(`not modified: ${url}`);
    this.name = "NotModified";
  }
}

export interface HttpResult {
  text: string;
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export type HttpGetter = (url: string) => Promise<HttpResult>;

export interface SourceFetch {
  raws: RawCandidate[];
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export interface HttpOptions {
  timeoutMs?: number | undefined;
  etag?: string | undefined;
  lastModified?: string | undefined;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export async function httpGetText(
  url: string,
  opts: HttpOptions = {},
): Promise<HttpResult> {
  const impl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.etag) headers["if-none-match"] = opts.etag;
  if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;
  const res = await impl(url, {
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
  });
  if (res.status === 304) throw new NotModified(url);
  if (!res.ok) throw new Error(`GET ${url} failed with status ${res.status}`);
  const out: HttpResult = { text: await res.text() };
  const etag = res.headers.get("etag");
  if (etag) out.etag = etag;
  const lastModified = res.headers.get("last-modified");
  if (lastModified) out.lastModified = lastModified;
  return out;
}
