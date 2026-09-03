import test from "node:test";
import assert from "node:assert/strict";
import {
  readSaved,
  readText,
  removeSaved,
  writeSaved,
  writeText,
} from "../src/storage.ts";

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
    measurePerformance({ kind: "refresh" })({ pages: 66, messages: 6560, networkMs: 1400 });
    assert.equal(requests, 0, "timing capture never sends synchronously in the action");
    const received = await batch;
    const { samples } = JSON.parse(received.body);
    assert.equal(received.url, "/host/performance");
    assert.equal(samples.length, 3);
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
