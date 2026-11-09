import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_RETRY_AFTER_MS,
  GITHUB_SEARCH_REQUESTS_PER_MINUTE,
  httpGetJson,
  httpGetText,
  NotModified,
  RAW_REQUESTS_PER_MINUTE,
  RateLimiter,
  SourceHttpError,
} from "../src/sources/http.js";

const URL = "https://api.example.com/listing";

function fetchReturning(...responses: Response[]): typeof fetch {
  let index = 0;
  return async () => responses[Math.min(index++, responses.length - 1)] as Response;
}

test("sends conditional headers and returns text with validators", async () => {
  let seen: HeadersInit | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen = init?.headers;
    return new Response("payload", {
      status: 200,
      headers: {
        etag: 'W/"abc"',
        "last-modified": "Mon, 09 Nov 2026 00:00:00 GMT",
      },
    });
  };
  const result = await httpGetText(URL, {
    etag: 'W/"abc"',
    lastModified: "Mon, 09 Nov 2026 00:00:00 GMT",
    headers: { accept: "application/json" },
    fetchImpl,
  });
  assert.equal(result.text, "payload");
  assert.equal(result.etag, 'W/"abc"');
  assert.equal(result.lastModified, "Mon, 09 Nov 2026 00:00:00 GMT");
  const headers = new Headers(seen);
  assert.equal(headers.get("if-none-match"), 'W/"abc"');
  assert.equal(headers.get("if-modified-since"), "Mon, 09 Nov 2026 00:00:00 GMT");
  assert.equal(headers.get("accept"), "application/json");
});

test("304 is NotModified, not an error response", async () => {
  const fetchImpl = fetchReturning(new Response(null, { status: 304 }));
  await assert.rejects(httpGetText(URL, { fetchImpl }), (error: unknown) => {
    assert.ok(error instanceof NotModified);
    assert.equal(error.url, URL);
    return true;
  });
});

test("401 and 404 are non-retryable SourceHttpErrors", async () => {
  for (const status of [401, 404]) {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("denied", { status });
    };
    await assert.rejects(
      httpGetText(URL, { fetchImpl, retryDelayMs: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof SourceHttpError);
        assert.equal(error.status, status);
        assert.equal(error.url, URL);
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(calls, 1, `status ${status} must not be retried`);
  }
});

test("retries a 5xx twice and can still succeed", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls < 3
      ? new Response("busy", { status: 503 })
      : new Response("eventually", { status: 200 });
  };
  const result = await httpGetText(URL, { fetchImpl, retryDelayMs: 0 });
  assert.equal(result.text, "eventually");
  assert.equal(calls, 3);
});

test("gives up after two retries on a persistent 5xx", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("down", { status: 500 });
  };
  await assert.rejects(
    httpGetText(URL, { fetchImpl, retryDelayMs: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof SourceHttpError);
      assert.equal(error.status, 500);
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(calls, 3, "initial attempt plus two retries");
});

test("429 waits for a numeric Retry-After before retrying", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("slow down", {
          status: 429,
          headers: { "retry-after": "0.1" },
        })
      : new Response("ok", { status: 200 });
  };
  const started = Date.now();
  const result = await httpGetText(URL, { fetchImpl, retryDelayMs: 1 });
  assert.equal(result.text, "ok");
  assert.equal(calls, 2);
  assert.ok(
    Date.now() - started >= 80,
    "Retry-After: 0.1 must delay the retry by roughly 100ms",
  );
});

test("Retry-After falls back to backoff when invalid or over the cap", async () => {
  assert.equal(DEFAULT_MAX_RETRY_AFTER_MS, 60_000);
  const cases = [
    { header: "0", maxRetryAfterMs: undefined, maxElapsed: 250 },
    { header: "-5", maxRetryAfterMs: undefined, maxElapsed: 250 },
    { header: "later", maxRetryAfterMs: undefined, maxElapsed: 250 },
    // 500ms is larger than the 100ms cap, so the 1ms backoff must win.
    { header: "0.5", maxRetryAfterMs: 100, maxElapsed: 400 },
  ];
  for (const item of cases) {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response("throttled", {
            status: 429,
            headers: { "retry-after": item.header },
          })
        : new Response("ok", { status: 200 });
    };
    const started = Date.now();
    const result = await httpGetText(URL, {
      fetchImpl,
      retryDelayMs: 1,
      maxRetryAfterMs: item.maxRetryAfterMs,
    });
    assert.equal(result.text, "ok", `header ${item.header}`);
    assert.equal(calls, 2, `header ${item.header}`);
    assert.ok(
      Date.now() - started < item.maxElapsed,
      `header ${item.header} must not stall the retry`,
    );
  }
});

test("timeouts become retryable SourceHttpErrors naming the timeout", async () => {
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason);
      });
    });
  await assert.rejects(
    httpGetText(URL, { fetchImpl, timeoutMs: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof SourceHttpError);
      assert.equal(error.status, 0);
      assert.equal(error.url, URL);
      assert.equal(error.retryable, true);
      assert.match(error.message, /timed out after 10ms/);
      return true;
    },
  );
});

test("a stalled response body times out as a SourceHttpError", async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => {
          controller.error(init.signal?.reason);
        });
      },
    });
    return new Response(stream, { status: 200 });
  };
  await assert.rejects(
    httpGetText(URL, { fetchImpl, timeoutMs: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof SourceHttpError);
      assert.equal(error.status, 0);
      assert.equal(error.url, URL);
      assert.equal(error.retryable, true);
      assert.match(error.message, /timed out after 10ms/);
      return true;
    },
  );
});

test("a body stream error is a SourceHttpError without echoing body data", async () => {
  const token = "sekret-body-value";
  const fetchImpl: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error(`payload ${token}`));
        },
      }),
      { status: 200 },
    );
  await assert.rejects(
    httpGetText(URL, { fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof SourceHttpError);
      assert.equal(error.status, 0);
      assert.equal(error.retryable, true);
      assert.ok(!error.message.includes(token));
      return true;
    },
  );
});

test("rejects and cancels a body larger than maxBytes", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(64)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl = fetchReturning(new Response(stream, { status: 200 }));
  await assert.rejects(
    httpGetText(URL, { fetchImpl, maxBytes: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof SourceHttpError);
      assert.equal(error.status, 0);
      assert.equal(error.retryable, false);
      assert.match(error.message, /exceeded 10 bytes/);
      return true;
    },
  );
  assert.equal(cancelled, true, "the over-limit stream must be cancelled");
});

test("rejects an unexpected content-type when the caller pins one", async () => {
  const fetchImpl = fetchReturning(
    new Response("<html>nope</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  );
  await assert.rejects(
    httpGetText(URL, { fetchImpl, contentType: "application/json" }),
    (error: unknown) => {
      assert.ok(error instanceof SourceHttpError);
      assert.equal(error.status, 0);
      assert.equal(error.retryable, false);
      assert.match(error.message, /content-type text\/html/);
      return true;
    },
  );
});

test("content-type matching ignores parameters but not lookalikes", async () => {
  const result = await httpGetText(URL, {
    fetchImpl: async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    contentType: "application/json",
  });
  assert.equal(result.text, "{}");

  await assert.rejects(
    httpGetText(URL, {
      fetchImpl: async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/jsonp" },
        }),
      contentType: "application/json",
    }),
    (error: unknown) => {
      assert.ok(error instanceof SourceHttpError);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("authorization header values never leak into thrown messages", async () => {
  const token = "Bearer sekret-token-value";
  const fetchImpl: typeof fetch = async () => {
    throw new Error(`request failed while sending ${token}`);
  };
  await assert.rejects(
    httpGetText(URL, {
      fetchImpl,
      headers: { authorization: token },
      retryDelayMs: 0,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SourceHttpError);
      assert.ok(!error.message.includes("sekret-token-value"));
      assert.ok(!String(error.stack).includes("sekret-token-value"));
      return true;
    },
  );
});

test("httpGetJson parses the payload and carries validators", async () => {
  const fetchImpl = fetchReturning(
    new Response(JSON.stringify({ items: [1, 2] }), {
      status: 200,
      headers: { "content-type": "application/json", etag: 'W/"json"' },
    }),
  );
  const result = await httpGetJson<{ items: number[] }>(URL, { fetchImpl });
  assert.deepEqual(result.data, { items: [1, 2] });
  assert.equal(result.etag, 'W/"json"');
});

test("invalid JSON is a SourceHttpError without echoing body data", async () => {
  const fetchImpl = fetchReturning(
    new Response('{"secret":"sekret-body-value",}', { status: 200 }),
  );
  await assert.rejects(
    httpGetJson(URL, { fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof SourceHttpError);
      assert.equal(error.status, 0);
      assert.equal(error.retryable, false);
      assert.ok(!error.message.includes("sekret-body-value"));
      return true;
    },
  );
});

test("strips a leading UTF-8 BOM from text and JSON", async () => {
  const text = await httpGetText(URL, {
    fetchImpl: fetchReturning(new Response("\uFEFFhello")),
  });
  assert.equal(text.text, "hello");

  const json = await httpGetJson<{ ok: boolean }>(URL, {
    fetchImpl: fetchReturning(
      new Response('\uFEFF{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  });
  assert.deepEqual(json.data, { ok: true });
});

test("source rate constants are published and usable", async () => {
  assert.equal(GITHUB_SEARCH_REQUESTS_PER_MINUTE, 10);
  assert.equal(RAW_REQUESTS_PER_MINUTE, 60);
  const limiter = new RateLimiter({
    requestsPerMinute: GITHUB_SEARCH_REQUESTS_PER_MINUTE,
  });
  assert.equal(limiter.concurrency, 5);
  await limiter.acquire();
  limiter.release();
});

test("RateLimiter defaults to five concurrent slots", async () => {
  const limiter = new RateLimiter();
  for (let index = 0; index < 5; index += 1) await limiter.acquire();
  let sixthAcquired = false;
  const pending = limiter.acquire().then(() => {
    sixthAcquired = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sixthAcquired, false);
  limiter.release();
  await pending;
  assert.equal(sixthAcquired, true);
  for (let index = 0; index < 5; index += 1) limiter.release();
});

test("RateLimiter caps concurrent acquisitions", async () => {
  const limiter = new RateLimiter({ concurrency: 2 });
  await limiter.acquire();
  await limiter.acquire();
  let thirdAcquired = false;
  const pending = limiter.acquire().then(() => {
    thirdAcquired = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(thirdAcquired, false);
  limiter.release();
  await pending;
  assert.equal(thirdAcquired, true);
  limiter.release();
  limiter.release();
});

test("RateLimiter paces requests per window", async () => {
  const limiter = new RateLimiter({ requestsPerMinute: 2, windowMs: 200 });
  await limiter.acquire();
  await limiter.acquire();
  const started = Date.now();
  await limiter.acquire();
  assert.ok(Date.now() - started >= 150, "third request must wait for the window");
  limiter.release();
  limiter.release();
  limiter.release();
});

test("httpGetText waits for the supplied limiter", async () => {
  const limiter = new RateLimiter({ concurrency: 1 });
  await limiter.acquire();
  let called = false;
  const pending = httpGetText(URL, {
    limiter,
    fetchImpl: async () => {
      called = true;
      return new Response("ok", { status: 200 });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(called, false, "request must not start while the slot is held");
  limiter.release();
  const result = await pending;
  assert.equal(result.text, "ok");
});

test("httpGetText releases its limiter slot when the request fails", async () => {
  const limiter = new RateLimiter({ concurrency: 1 });
  await assert.rejects(
    httpGetText(URL, {
      limiter,
      fetchImpl: async () => {
        throw new Error("network down");
      },
      retryDelayMs: 0,
    }),
    SourceHttpError,
  );
  const result = await httpGetText(URL, {
    limiter,
    fetchImpl: async () => new Response("after failure", { status: 200 }),
  });
  assert.equal(result.text, "after failure");
});
