import type { RawCandidate } from "../probe.js";

// Shared HTTP surface for public source listings: timeout, bounded body,
// conditional requests (ETag / last-modified), retries for throttle/server
// errors, and request pacing. Per-source failure isolation stays with the
// caller. No new runtime deps: global fetch only.

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 500;
export const MAX_RETRY_DELAY_MS = 5_000;
export const DEFAULT_CONCURRENCY = 5;
export const GITHUB_SEARCH_REQUESTS_PER_MINUTE = 10;
export const RAW_REQUESTS_PER_MINUTE = 60;

export class NotModified extends Error {
  constructor(readonly url: string) {
    super(`not modified: ${url}`);
    this.name = "NotModified";
  }
}

export class SourceHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly retryable: boolean,
    message: string,
    readonly retryAfterMs: number | undefined = undefined,
  ) {
    super(message);
    this.name = "SourceHttpError";
  }
}

export interface HttpResult {
  text: string;
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export interface HttpJsonResult<T> {
  data: T;
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export type HttpGetter = (url: string) => Promise<HttpResult>;

export interface SourceFetch {
  raws: RawCandidate[];
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export interface RateLimiterOptions {
  concurrency?: number | undefined;
  requestsPerMinute?: number | undefined;
  // Window used for requestsPerMinute; exposed so tests need not wait a minute.
  windowMs?: number | undefined;
}

// FIFO limiter: acquire() holds one concurrency slot until release(). Callers
// should prefer run(), or wire the limiter into HttpOptions, so slots always
// come back even when the request throws.
export class RateLimiter {
  readonly concurrency: number;
  private readonly requestsPerMinute: number | undefined;
  private readonly windowMs: number;
  private active = 0;
  private readonly starts: number[] = [];
  private readonly waiters: Array<() => void> = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions = {}) {
    this.concurrency = Math.max(
      1,
      Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY),
    );
    this.requestsPerMinute =
      opts.requestsPerMinute !== undefined && opts.requestsPerMinute > 0
        ? opts.requestsPerMinute
        : undefined;
    this.windowMs = opts.windowMs ?? 60_000;
  }

  acquire(): Promise<void> {
    const turn = this.queue.then(() => this.take());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  release(): void {
    if (this.active > 0) this.active -= 1;
    this.waiters.shift()?.();
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async take(): Promise<void> {
    while (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.requestsPerMinute !== undefined) {
      for (;;) {
        const now = Date.now();
        while (
          this.starts.length > 0 &&
          now - (this.starts[0] ?? 0) >= this.windowMs
        ) {
          this.starts.shift();
        }
        if (this.starts.length < this.requestsPerMinute) break;
        const oldest = this.starts[0] ?? now;
        await sleep(Math.max(1, this.windowMs - (now - oldest)));
      }
      this.starts.push(Date.now());
    }
    this.active += 1;
  }
}

const defaultLimiter = new RateLimiter();

export interface HttpOptions {
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  // Base delay for bounded exponential backoff between retries.
  retryDelayMs?: number | undefined;
  // Pinned when the caller expects a specific response media type.
  contentType?: string | RegExp | undefined;
  limiter?: RateLimiter | undefined;
  etag?: string | undefined;
  lastModified?: string | undefined;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export async function httpGetText(
  url: string,
  opts: HttpOptions = {},
): Promise<HttpResult> {
  return (opts.limiter ?? defaultLimiter).run(() => requestText(url, opts));
}

export async function httpGetJson<T>(
  url: string,
  opts: HttpOptions = {},
): Promise<HttpJsonResult<T>> {
  const res = await httpGetText(url, opts);
  let data: T;
  try {
    data = JSON.parse(res.text) as T;
  } catch (error) {
    throw new Error(
      `GET ${url} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const out: HttpJsonResult<T> = { data };
  if (res.etag) out.etag = res.etag;
  if (res.lastModified) out.lastModified = res.lastModified;
  return out;
}

async function requestText(url: string, opts: HttpOptions): Promise<HttpResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestOnce(url, opts);
    } catch (error) {
      // Only throttle/server statuses are retried here; network and timeout
      // failures surface as retryable for the caller to decide.
      const retry =
        error instanceof SourceHttpError &&
        error.retryable &&
        error.status > 0 &&
        attempt < DEFAULT_RETRIES;
      if (!retry) throw error;
      const base = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
      const delay =
        error.retryAfterMs ??
        Math.min(base * 2 ** attempt, MAX_RETRY_DELAY_MS);
      await sleep(delay);
    }
  }
}

async function requestOnce(
  url: string,
  opts: HttpOptions,
): Promise<HttpResult> {
  const impl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.etag) headers["if-none-match"] = opts.etag;
  if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await impl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    const message = timedOut
      ? `GET ${url} timed out after ${timeoutMs}ms`
      : `GET ${url} failed: ${redactSecrets(
          error instanceof Error ? error.message : String(error),
          headers,
        )}`;
    throw new SourceHttpError(url, 0, true, message);
  }
  if (res.status === 304) throw new NotModified(url);
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    const retryable = res.status === 429 || res.status >= 500;
    throw new SourceHttpError(
      url,
      res.status,
      retryable,
      `GET ${url} failed with status ${res.status}`,
      retryable ? parseRetryAfter(res.headers.get("retry-after")) : undefined,
    );
  }
  try {
    checkContentType(url, res, opts.contentType);
  } catch (error) {
    await res.body?.cancel().catch(() => undefined);
    throw error;
  }
  const text = await readCappedText(url, res, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  const out: HttpResult = { text };
  const etag = res.headers.get("etag");
  if (etag) out.etag = etag;
  const lastModified = res.headers.get("last-modified");
  if (lastModified) out.lastModified = lastModified;
  return out;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : undefined;
}

function checkContentType(
  url: string,
  res: Response,
  expected: string | RegExp | undefined,
): void {
  if (expected === undefined) return;
  const actual = res.headers.get("content-type");
  const matches =
    actual !== null &&
    (typeof expected === "string"
      ? actual.toLowerCase().includes(expected.toLowerCase())
      : expected.test(actual));
  if (!matches) {
    throw new Error(
      `GET ${url} returned content-type ${actual ?? "none"}, expected ${
        expected instanceof RegExp ? expected.source : expected
      }`,
    );
  }
}

async function readCappedText(
  url: string,
  res: Response,
  maxBytes: number,
): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`GET ${url} response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const SECRET_HEADER = /authorization|cookie|token|api[-_]?key|secret/i;

function redactSecrets(
  text: string,
  headers: Record<string, string>,
): string {
  let out = text;
  for (const [name, value] of Object.entries(headers)) {
    if (!SECRET_HEADER.test(name) || value.length === 0) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
