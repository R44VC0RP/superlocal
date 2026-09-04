import test from "node:test";
import assert from "node:assert/strict";
import {
  readSaved,
  readText,
  removeSaved,
  writeSaved,
  writeText,
} from "../src/storage.ts";
import { AUTH_REQUIRED_EVENT, beginGoogleLogin, checkAuthenticationResponse, readApplicationAccess, signOutApplication } from "../src/application-auth.ts";

test("application access fails closed and never infers a local session from invalid responses", async () => {
  const original = globalThis.fetch;
  let payload: unknown = { method: "loopback" };
  globalThis.fetch = (async (_input, init) => {
    assert.equal(init?.credentials, "include");
    assert.equal(init?.cache, "no-store");
    return Response.json(payload);
  }) as typeof fetch;
  try {
    assert.deepEqual(await readApplicationAccess(), { method: "loopback" });
    payload = { method: "google", authenticated: false, user: { email: "hidden@example.test" } };
    assert.deepEqual(await readApplicationAccess(), { method: "google", authenticated: false, user: null });
    payload = { method: "google", authenticated: true, user: { name: "Approved", email: "approved@example.test" } };
    assert.deepEqual(await readApplicationAccess(), payload);
    for (const invalid of [{}, null, { method: "google", authenticated: "true" }, { method: "google", authenticated: true }, { method: "google", authenticated: true, user: { email: "approved@example.test" } }]) {
      payload = invalid;
      await assert.rejects(readApplicationAccess());
    }
    globalThis.fetch = (async () => Response.json({ method: "loopback" }, { status: 503 })) as typeof fetch;
    await assert.rejects(readApplicationAccess());
  } finally { globalThis.fetch = original; }
});

test("Google login uses only the host flow and rejects unexpected destinations", async () => {
  const original = globalThis.fetch;
  let destination = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fictional";
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ path: String(input), init });
    return String(input).endsWith("sign-out") ? new Response(null, { status: 204 }) : Response.json({ url: destination });
  }) as typeof fetch;
  try {
    assert.equal(await beginGoogleLogin(), destination);
    assert.equal(requests[0]!.path, "/host/auth/sign-in");
    assert.equal(requests[0]!.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)), {});
    for (const url of ["https://accounts.google.com.evil.test/login", "http://accounts.google.com/login", "https://user@accounts.google.com/login", "javascript:alert(1)", "/arbitrary-login"]) {
      destination = url;
      await assert.rejects(beginGoogleLogin());
    }
    await signOutApplication();
    assert.equal(requests.at(-1)!.path, "/host/auth/sign-out");
    assert.equal(requests.at(-1)!.init?.method, "POST");
  } finally { globalThis.fetch = original; }
});

test("only an explicit host authentication challenge locks the application", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "dispatchEvent");
  const events: string[] = [];
  Object.defineProperty(globalThis, "dispatchEvent", { configurable: true, value: (event: Event) => { events.push(event.type); return true; } });
  try {
    checkAuthenticationResponse(new Response(null, { status: 401 }));
    checkAuthenticationResponse(new Response(null, { status: 500, headers: { "X-Superlocal-Auth": "required" } }));
    assert.deepEqual(events, []);
    checkAuthenticationResponse(new Response(null, { status: 401, headers: { "X-Superlocal-Auth": "required" } }));
    assert.deepEqual(events, [AUTH_REQUIRED_EVENT]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "dispatchEvent", previous);
    else Reflect.deleteProperty(globalThis, "dispatchEvent");
  }
});

test("stored state round-trips without affecting other keys", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>([["unrelated", "keep"]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  try {
    assert.equal(
      writeSaved("drafts", [{ id: "saved", body: "Keep my text" }]),
      true,
    );
    assert.deepEqual(readSaved("drafts", []), [
      { id: "saved", body: "Keep my text" },
    ]);
    assert.equal(writeText("draft-reminder:saved", "tomorrow"), true);
    assert.equal(readText("draft-reminder:saved"), "tomorrow");
    assert.equal(removeSaved("draft-reminder:saved"), true);
    assert.equal(readText("draft-reminder:saved"), null);
    assert.equal(values.get("unrelated"), "keep");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("quota failures preserve the previously saved draft and report failure", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const saved = [{ id: "saved", body: "Last saved text" }];
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => JSON.stringify(saved),
      setItem: () => {
        throw new DOMException("Storage is full", "QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("Storage unavailable");
      },
    },
  });
  try {
    assert.equal(
      writeSaved("drafts", [{ id: "saved", body: "Unsaved text" }]),
      false,
    );
    assert.equal(writeSaved("labels", ["New label"]), false);
    assert.equal(writeSaved("preferences", { theme: "Light" }), false);
    assert.deepEqual(readSaved("drafts", []), saved);
    assert.equal(removeSaved("drafts"), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("unavailable or malformed storage falls back without crashing initialization", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let value = "not-json";
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => value },
  });
  try {
    const fallback = ["existing label"];
    assert.equal(readSaved("labels", fallback), fallback);
    value = JSON.stringify({ not: "an array" });
    assert.equal(readSaved("labels", fallback), fallback);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("Storage blocked");
      },
    });
    assert.equal(readSaved("labels", fallback), fallback);
    assert.equal(writeSaved("labels", ["new"]), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("local timing capture batches bounded metadata without blocking actions or retrying failed logging", async () => {
  const { configurePerformanceLogging, measureAction, measurePerformance, measureRequest } = await import("../src/browser-logs.ts");
  const originalFetch = globalThis.fetch;
  let resolveBatch!: (input: { url: string; body: string }) => void;
  const batch = new Promise<{ url: string; body: string }>(resolve => { resolveBatch = resolve; });
  let release!: () => void, requests = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    requests++;
    resolveBatch({ url: String(input), body: String(init?.body) });
    await pending;
    throw new Error("Diagnostic transport unavailable");
  }) as typeof fetch;
  try {
    configurePerformanceLogging(true);
    const action = measureAction("private search text must never be logged", 2);
    action.accepted(); action.finish();
    measureRequest("/v1/mailboxes/private-source/messages/private-message", "PATCH")(200);
    measureRequest("/v1/mailbox-snapshot", "POST")(200);
    measureRequest("/v1/mailbox-changes", "POST")(200);
    measurePerformance({ kind: "refresh" })({ pages: 66, messages: 6560, networkMs: 1400 });
    assert.equal(requests, 0, "timing capture never sends synchronously in the action");
    const received = await batch;
    const { samples } = JSON.parse(received.body);
    assert.equal(received.url, "/host/performance");
    assert.equal(samples.length, 3, "fast body-free POST reads are not logged as mutations");
    assert.equal(samples[0].action, "other");
    assert.equal(samples[1].route, "message-body");
    assert.equal(samples[2].pages, 66);
    assert.ok(samples.every((sample: { durationMs: number }) => Number.isFinite(sample.durationMs)));
    assert.ok(!received.body.includes("private"));
    configurePerformanceLogging(false);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1, "a failed diagnostic batch is not retried");
  } finally {
    configurePerformanceLogging(false); release(); globalThis.fetch = originalFetch;
  }
});
