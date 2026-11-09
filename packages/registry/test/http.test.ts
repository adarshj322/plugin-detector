import test from "node:test";
import assert from "node:assert/strict";
import {
  httpGetJson,
  httpGetText,
  NotModified,
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

test("rejects a body larger than maxBytes", async () => {
  const fetchImpl = fetchReturning(new Response("x".repeat(100)));
  await assert.rejects(
    httpGetText(URL, { fetchImpl, maxBytes: 10 }),
    /exceeded 10 bytes/,
  );
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
    /content-type text\/html/,
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
