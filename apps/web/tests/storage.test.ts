import test from "node:test";
import assert from "node:assert/strict";
import {
  createScopedStorage,
  readSaved,
  readText,
  removeSaved,
  writeSaved,
  writeText,
} from "../src/storage.ts";
import { AUTH_REQUIRED_EVENT, beginGoogleLogin, checkAuthenticationResponse, createScopedFetch, readApplicationAccess, signOutApplication } from "../src/application-auth.ts";
import { bindApplicationScope, createApplicationScope } from "../src/application-scope.ts";

const scopeA = "a".repeat(64), scopeB = "b".repeat(64);

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
    assert.deepEqual(await readApplicationAccess(), { method: "google", authenticated: false, user: null, scope: null });
    payload = { method: "google", authenticated: true, user: { name: "Approved", email: "approved@example.test" }, scope: scopeA };
    assert.deepEqual(await readApplicationAccess(), payload);
    const identity = payload;
    for (const scope of [undefined, null, "", "a".repeat(63), "b".repeat(65), "G".repeat(64), "approved@example.test", {}, 42]) {
      payload = { ...identity as object, scope };
      await assert.rejects(readApplicationAccess());
    }
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
    checkAuthenticationResponse(new Response(null, { status: 409 }));
    checkAuthenticationResponse(new Response(null, { status: 409, headers: { "X-Superlocal-Auth": "required" } }));
    assert.deepEqual(events, [AUTH_REQUIRED_EVENT, AUTH_REQUIRED_EVENT]);
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

test("Google storage isolates every private helper without importing legacy values", async () => {
  const previousLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const local = new Map<string, string>([["superlocal:preferences", '{"theme":"Light"}'], ["superlocal:profile", '{"name":"Local person"}'], ["unrelated", "keep"]]);
  const session = new Map<string, string>([["superlocal:read-only-notice", "dismissed"]]);
  const storage = (values: Map<string, string>) => ({ getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage(local) });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage(session) });
  try {
    const a = createScopedStorage(scopeA), b = createScopedStorage(scopeB), legacy = createScopedStorage(null);
    for (const owner of [a, b]) {
      assert.deepEqual(owner.readSaved("preferences", {}), {});
      assert.equal(owner.readText("profile"), null);
      assert.equal(owner.readSessionText("read-only-notice"), null);
    }
    for (const key of ["preferences", "profile", "drafts", "sdk-draft-recovery", "sdk-outbox-references", "searches", "snippets", "snippet-metrics", "calendar:account", "calendar-sources:account", "calendar-bookings:account", "comments:mailbox:thread", "invitation:thread", "unsubscribed:sender", "draft-reminder:draft"]) {
      assert.equal(a.writeSaved(key, { owner: "A" }), true);
      assert.deepEqual(b.readSaved(key, {}), {});
      assert.equal(b.writeText(key, JSON.stringify({ owner: "B" })), true);
      assert.deepEqual(a.readSaved(key, {}), { owner: "A" });
      assert.deepEqual(b.readSaved(key, {}), { owner: "B" });
      assert.equal(a.removeSaved(key), true);
      assert.equal(a.readText(key), null);
      assert.equal(b.readText(key), '{"owner":"B"}');
    }
    assert.equal(a.writeSessionText("read-only-notice", "dismissed"), true);
    assert.equal(b.readSessionText("read-only-notice"), null);
    assert.equal(b.writeSessionText("read-only-notice", "B"), true);
    assert.equal(a.readSessionText("read-only-notice"), "dismissed");
    // Capture an A writer, then complete it after a B context already exists.
    const delayedWriter = a.writeSaved;
    await Promise.resolve();
    assert.equal(delayedWriter("drafts", [{ body: "Late A draft" }]), true);
    assert.deepEqual(a.readSaved("drafts", []), [{ body: "Late A draft" }]);
    assert.deepEqual(b.readSaved("drafts", {}), { owner: "B" });
    assert.deepEqual(legacy.readSaved("preferences", {}), { theme: "Light" });
    assert.deepEqual(legacy.readSaved("profile", {}), { name: "Local person" });
    assert.equal(legacy.readSessionText("read-only-notice"), "dismissed");
    assert.equal(legacy.issueDatabaseName, "superlocal-issues");
    assert.notEqual(a.issueDatabaseName, b.issueDatabaseName);
    assert.notEqual(a.issueDatabaseName, legacy.issueDatabaseName);
    assert.equal(local.get("unrelated"), "keep");
    assert.throws(() => createScopedStorage("not-a-private-scope"));
  } finally {
    if (previousLocal) Object.defineProperty(globalThis, "localStorage", previousLocal); else Reflect.deleteProperty(globalThis, "localStorage");
    if (previousSession) Object.defineProperty(globalThis, "sessionStorage", previousSession); else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("issue reports keep pending writes and cached database handles in their captured owner", async () => {
  const { readIssueReports, saveIssueReport } = await import("../src/issue-reports.ts");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const a = createScopedStorage(scopeA), b = createScopedStorage(scopeB);
  const values = new Map<string, Map<string, { id: string; updatedAt: string; prompt: string }>>();
  const opened: string[] = [];
  const release = new Map<string, () => void>();
  const legacy = new Map([["legacy", { id: "legacy", updatedAt: "2026-01-01", prompt: "Local only" }]]);
  values.set("superlocal-issues", legacy);
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open(name: string) {
    opened.push(name);
    const rows = values.get(name) ?? new Map(); values.set(name, rows);
    const request: { result: unknown; onsuccess?: () => void } = { result: {
      close() {},
      transaction() {
        const transaction: { oncomplete?: () => void; objectStore: () => unknown } = { objectStore: () => ({
          put(report: { id: string }) { rows.set(report.id, report); queueMicrotask(() => transaction.oncomplete?.()); },
          getAll() { const result = { result: [...rows.values()] }; queueMicrotask(() => transaction.oncomplete?.()); return result; },
        }) };
        return transaction;
      },
    } };
    release.set(name, () => request.onsuccess?.());
    return request;
  } } });
  try {
    const report = (prompt: string) => ({ id: "same-id", prompt, updatedAt: "2026-09-03", capturedAt: "2026-09-03", url: "https://mail.example.test/", title: "Fictional", viewport: { width: 100, height: 100, pixelRatio: 1 }, screenshot: new Blob([prompt]) });
    const pendingA = saveIssueReport(report("A"), a);
    const pendingB = saveIssueReport(report("B"), b);
    release.get(b.issueDatabaseName)!();
    await pendingB;
    assert.equal((await readIssueReports(b))[0]!.prompt, "B");
    release.get(a.issueDatabaseName)!();
    await pendingA;
    assert.equal((await readIssueReports(a))[0]!.prompt, "A");
    assert.equal((await readIssueReports(b))[0]!.prompt, "B");
    assert.deepEqual(opened, [a.issueDatabaseName, b.issueDatabaseName], "reuse is by immutable database name, never a global A/B handle");
    assert.deepEqual([...legacy.values()], [{ id: "legacy", updatedAt: "2026-01-01", prompt: "Local only" }]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous); else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});

test("scoped fetches preserve their owner across cookie changes and caller header overrides", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ path: string; scope: string | null; accept: string | null }> = [];
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ path: input instanceof Request ? input.url : String(input), scope: headers.get("X-Superlocal-Scope"), accept: headers.get("Accept") });
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const a = createScopedFetch(createApplicationScope(scopeA));
    const b = createScopedFetch(createApplicationScope(scopeB));
    for (const path of ["/v1/drafts", "/v1/events", "/v1/mailbox-changes", "/session", "/host/config", "/host/performance"]) {
      await a(path, { headers: { "X-Superlocal-Scope": scopeB, Accept: path.endsWith("events") ? "text/event-stream" : "application/json" } });
      assert.equal(requests.at(-1)!.scope, scopeA);
    }
    await b("/host/config");
    assert.equal(requests.at(-1)!.scope, scopeB);
    await a(new Request("https://mail.example.test/v1/drafts", { headers: { "X-Superlocal-Scope": scopeB, Accept: "application/json" } }));
    assert.equal(requests.at(-1)!.scope, scopeA);
    assert.equal(requests.at(-1)!.accept, "application/json");
    assert.equal(requests[1]!.accept, "text/event-stream");
    await createScopedFetch(createApplicationScope(null))("/v1/accounts", { headers: { "X-Superlocal-Scope": scopeB } });
    assert.equal(requests.at(-1)!.scope, null, "loopback keeps its original transport contract");
  } finally { globalThis.fetch = original; }
});

test("a 409 scope challenge locks its transport and late responses never reach the SDK", async () => {
  const original = globalThis.fetch;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "dispatchEvent");
  const events: string[] = [];
  Object.defineProperty(globalThis, "dispatchEvent", { configurable: true, value: (event: Event) => { events.push(event.type); return true; } });
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({ code: "HOST_SCOPE_CHANGED" }, { status: 409, headers: { "X-Superlocal-Auth": "required" } }); }) as typeof fetch;
  try {
    const binding = createApplicationScope(scopeA), fetchA = createScopedFetch(binding);
    await assert.rejects(fetchA("/v1/drafts", { method: "POST", body: "A draft" }), { name: "AbortError" });
    assert.equal(binding.signal.aborted, true);
    assert.deepEqual(events, [AUTH_REQUIRED_EVENT]);
    await assert.rejects(fetchA("/v1/drafts"), { name: "AbortError" });
    assert.equal(requests, 1, "a locked document cannot start another private request");
    const late = createApplicationScope(scopeB);
    let release!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch;
    const pending = createScopedFetch(late)("/v1/accounts");
    late.lock();
    release(Response.json([{ name: "Stale B" }]));
    await assert.rejects(pending, { name: "AbortError" });
  } finally {
    globalThis.fetch = original;
    if (previous) Object.defineProperty(globalThis, "dispatchEvent", previous); else Reflect.deleteProperty(globalThis, "dispatchEvent");
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

test("a document keeps its application owner and cannot unlock or switch owners in place", () => {
  const bound = bindApplicationScope(scopeA);
  assert.equal(bindApplicationScope(scopeA), bound);
  assert.throws(() => bindApplicationScope(scopeB), /fresh document/);
  assert.throws(() => bindApplicationScope(null), /fresh document/);
  assert.equal(bound.scope, scopeA);
  bound.lock();
  assert.throws(() => bindApplicationScope(scopeA), /fresh document/);
});
