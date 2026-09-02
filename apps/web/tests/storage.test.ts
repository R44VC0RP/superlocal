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
