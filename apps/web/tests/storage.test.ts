import test from "node:test";
import assert from "node:assert/strict";
import {
  readSaved,
  readText,
  removeSaved,
  writeSaved,
  writeText,
} from "../src/storage.ts";
import {
  IssueRequestError,
  issueScriptPaths,
  prepareIssueAttempt,
  readRepoIssuePage,
  readRepoIssueReport,
  writeRepoIssueReport,
  type IssueReport,
} from "../src/issue-reports.ts";
import { ISSUE_LIMITS, type IssueSummary } from "../../shared/issue-reports.ts";

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

test("issue build diagnostics contain bounded same-origin script paths, not credentials or query strings", () => {
  const origin = "http://localhost:5173";
  const paths = issueScriptPaths([
    `${origin}/assets/app.js?token=private#fragment`,
    `${origin}/assets/app.js?second=query`,
    `${origin}/src/main.tsx?t=123`,
    "https://elsewhere.test/third-party.js",
    "http://user:password@localhost:5173/private.js",
    "data:text/javascript,private",
    `${origin}/${"x".repeat(600)}.js`,
    `${origin}/private%20content.js`,
    `${origin}/api/config`,
    ...Array.from({ length: 100 }, (_, index) => `${origin}/assets/chunk-${index}.mjs?secret=hidden`),
  ], origin);
  assert.deepEqual(paths.slice(0, 2), ["/assets/app.js", "/src/main.tsx"]);
  assert.equal(paths.length, 20);
  assert.equal(paths.some(path => /private|token|secret|\?|#|password/.test(path)), false);
});

test("issue retries freeze the original write revision and capture while each attempt has a unique cleanup token", () => {
  const report: IssueReport = {
    id: "ea5b8e3d-4e21-491c-a6b6-2af594fd2ac8", scope: "scope-a", prompt: "Before",
    title: "Fictional inbox", url: "http://localhost:5173/inbox",
    capturedAt: "2026-09-03T10:00:00.000Z", updatedAt: "2026-09-03T10:00:00.000Z",
    viewport: { width: 1440, height: 900, pixelRatio: 2 }, revision: 4,
    screenshot: new Blob(["image"], { type: "image/jpeg" }),
    logs: [{ time: "2026-09-03T10:00:00.000Z", level: "info", message: "Captured diagnostic" }],
    build: { mode: "optimized", assets: ["/assets/app.js"] },
    rendering: [{ width: 800, height: 600, scrollWidth: 900, bodyScrollWidth: 1200, scale: 0.75 }],
  };
  const attempt = prepareIssueAttempt(report, " After ");
  const retry = prepareIssueAttempt({ ...attempt, updatedAt: "2026-09-04T10:00:00.000Z" }, "After");
  assert.deepEqual(retry.pending?.write, attempt.pending?.write);
  assert.notEqual(retry.pending?.token, attempt.pending?.token);
  assert.equal(retry.pending?.write.revision, 4);
  assert.equal(retry.updatedAt, attempt.updatedAt);
  assert.equal(retry.screenshot, report.screenshot);
  assert.deepEqual(retry.pending?.write.rendering, report.rendering);
  assert.equal("pending" in attempt.pending!.write, false);
  assert.equal("screenshot" in attempt.pending!.write, false);
  const edited = prepareIssueAttempt(retry, "Another edit");
  assert.equal(edited.pending?.write.revision, 4, "changing a prompt never blindly rebases a stale revision");
  assert.equal(edited.pending?.write.capturedAt, report.capturedAt);
  assert.deepEqual(edited.pending?.write.logs, report.logs);
  assert.throws(() => prepareIssueAttempt(report, "x".repeat(ISSUE_LIMITS.promptCharacters + 1)), /10,000/);
  assert.throws(() => prepareIssueAttempt({ ...report, scope: undefined }, "Legacy"), /browser-only/);
});

test("repo lists are metadata-only and paginated; opening one issue lazily fetches its detail and screenshot", async () => {
  const originalFetch = globalThis.fetch;
  const image = new Blob(["fictional screenshot"], { type: "image/png" });
  const summary: IssueSummary = {
    id: "ea5b8e3d-4e21-491c-a6b6-2af594fd2ac8", scope: "scope-a", prompt: "Fictional layout issue",
    title: "Fictional inbox", url: "http://localhost:5173/inbox",
    capturedAt: "2026-09-03T10:00:00.000Z", updatedAt: "2026-09-03T10:00:00.000Z",
    viewport: { width: 1440, height: 900, pixelRatio: 2 }, revision: 1, storage: "repo", status: "new",
    image: { contentType: "image/png", bytes: image.size, width: 1440, height: 900, sha256: "0".repeat(64) },
    logCount: 1, timingCount: 0,
  };
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "include");
    if (url.startsWith("/host/issues?")) return Response.json({ scope: "scope-a", items: [summary], nextCursor: "page 2" });
    if (url.endsWith("/screenshot")) return new Response(image);
    return Response.json({ ...summary, logs: [{ time: summary.capturedAt, level: "info", message: "Captured" }] });
  }) as typeof fetch;
  try {
    const first = await readRepoIssuePage("scope-a");
    assert.equal(first.items.length, 1);
    assert.deepEqual(requests, [`/host/issues?limit=${ISSUE_LIMITS.pageSize}`]);
    assert.equal("screenshot" in first.items[0], false);
    await readRepoIssuePage("scope-a", first.nextCursor!);
    assert.equal(requests[1], `/host/issues?limit=${ISSUE_LIMITS.pageSize}&cursor=page+2`);
    const report = await readRepoIssueReport(summary.id, "scope-a");
    assert.deepEqual(requests.slice(2), [`/host/issues/${summary.id}`, `/host/issues/${summary.id}/screenshot`]);
    assert.equal(report.screenshot.size, image.size);
    assert.equal(report.revision, 1);
    assert.equal(report.logs?.length, 1);
    await assert.rejects(readRepoIssuePage("scope-b"), /invalid issue list/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("repo writes use exactly two multipart fields, require acknowledgement, and do not retry revision conflicts", async () => {
  const originalFetch = globalThis.fetch;
  const report: IssueReport = {
    id: "ea5b8e3d-4e21-491c-a6b6-2af594fd2ac8", scope: "scope-a", prompt: "",
    title: "Fictional inbox", url: "http://localhost:5173/inbox",
    capturedAt: "2026-09-03T10:00:00.000Z", updatedAt: "2026-09-03T10:00:00.000Z",
    viewport: { width: 1440, height: 900, pixelRatio: 2 },
    screenshot: new Blob(["fictional screenshot"], { type: "image/jpeg" }),
  };
  const attempt = prepareIssueAttempt(report, "A description");
  let requests = 0;
  let status = 200;
  globalThis.fetch = (async (input, init) => {
    requests++;
    assert.equal(String(input), `/host/issues/${report.id}`);
    assert.equal(init?.method, "PUT");
    assert.deepEqual(init?.headers, { "X-Superlocal": "1" });
    assert.ok(init?.body instanceof FormData);
    assert.deepEqual([...init.body.keys()], ["report", "screenshot"]);
    const write = JSON.parse(String(init.body.get("report")));
    assert.deepEqual(write, attempt.pending?.write);
    assert.equal(write.revision, 0);
    assert.equal("screenshot" in write, false);
    assert.equal("pending" in write, false);
    assert.ok(init.body.get("screenshot") instanceof Blob);
    if (status !== 200) return Response.json({ error: "Revision conflict" }, { status });
    return Response.json({
      ...write, revision: 1, storage: "repo", status: "new", logCount: 0, timingCount: 0,
      image: { contentType: "image/jpeg", bytes: report.screenshot.size, width: 1440, height: 900, sha256: "0".repeat(64) },
    });
  }) as typeof fetch;
  try {
    const saved = await writeRepoIssueReport(attempt, "scope-a");
    assert.equal(saved.revision, 1);
    assert.equal(requests, 1);
    status = 412;
    await assert.rejects(writeRepoIssueReport(attempt, "scope-a"), error => error instanceof IssueRequestError && error.status === 412);
    assert.equal(requests, 2, "a conflict must not trigger an automatic read/rebase/retry");
    await assert.rejects(writeRepoIssueReport(attempt, "scope-b"), /another host context/);
    await assert.rejects(writeRepoIssueReport({ ...attempt, screenshot: new Blob([new Uint8Array(ISSUE_LIMITS.screenshotBytes + 1)], { type: "image/jpeg" }) }, "scope-a"), /8 MB/);
    await assert.rejects(writeRepoIssueReport({ ...attempt, pending: {
      token: attempt.pending!.token,
      write: { ...attempt.pending!.write, logs: [{ time: report.capturedAt, level: "info", message: "x".repeat(ISSUE_LIMITS.metadataBytes) }] },
    } }, "scope-a"), /diagnostics exceed/);
    assert.equal(requests, 2, "oversized reports and other scopes must not reach the host");
    globalThis.fetch = (async () => Response.json({ storage: "repo" })) as typeof fetch;
    await assert.rejects(writeRepoIssueReport(attempt, "scope-a"), /did not acknowledge/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
