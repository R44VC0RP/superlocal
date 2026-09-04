/// <reference types="vite/client" />
import { performanceActions, type PerformanceAction, type PerformanceSample } from "../../shared/performance.ts";
import { privateFetch } from "./application-auth.ts";

let performanceEnabled = false;
let performanceTab: string | undefined;
const performanceQueue: PerformanceSample[] = [];
let performanceTimer: ReturnType<typeof setTimeout> | undefined;
let performanceSending = false;
let inputTimings: PerformanceObserver | undefined;

async function flushPerformance(): Promise<void> {
  if (!performanceEnabled || performanceSending || !performanceQueue.length) return;
  performanceSending = true;
  const samples = performanceQueue.splice(0, 50);
  try {
    // Never await this transport from a mail action. Failed telemetry is dropped,
    // not retried, and this fetch is deliberately outside request instrumentation.
    await privateFetch("/host/performance", { method: "POST", credentials: "include", keepalive: true,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ samples }), signal: AbortSignal.timeout(3000) });
  } catch { /* Timing capture must not produce user errors or recursive logging. */ }
  finally { performanceSending = false; schedulePerformance(); }
}

function schedulePerformance() {
  if (!performanceEnabled || performanceTimer || !performanceQueue.length) return;
  performanceTimer = setTimeout(() => { performanceTimer = undefined; void flushPerformance(); }, 1000);
}

export function configurePerformanceLogging(enabled: boolean) {
  performanceEnabled = enabled;
  if (enabled) {
    performanceTab ??= crypto.randomUUID(); schedulePerformance();
    // Event Timing includes input that waited behind a busy main thread. No key,
    // DOM target, or typed value is retained. Unsupported browsers simply omit it.
    if (!inputTimings && typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("event")) {
      try {
        inputTimings = new PerformanceObserver(list => {
          for (const item of list.getEntries()) {
            const entry = item as PerformanceEventTiming & { interactionId?: number };
            if (!entry.interactionId) continue;
            enqueuePerformance({ kind: "input", outcome: "ok", at: Date.now() - Math.max(0, performance.now() - entry.startTime),
              durationMs: entry.duration, queueMs: Math.max(0, entry.processingStart - entry.startTime), processingMs: Math.max(0, entry.processingEnd - entry.processingStart) });
          }
        });
        inputTimings.observe({ type: "event", durationThreshold: 40 } as PerformanceObserverInit);
      } catch { inputTimings?.disconnect(); inputTimings = undefined; }
    }
  } else {
    clearTimeout(performanceTimer); performanceTimer = undefined; performanceQueue.length = 0;
    inputTimings?.disconnect(); inputTimings = undefined;
  }
}

type TimingFields = Omit<PerformanceSample, "tab" | "id" | "at" | "durationMs">;
const rounded = (value: number) => Math.max(0, Math.round(value * 10) / 10);
const safeAction = (action: string): PerformanceAction => performanceActions.includes(action as PerformanceAction) ? action as PerformanceAction : "other";

function enqueuePerformance(sample: Omit<PerformanceSample, "tab" | "id">) {
  if (!performanceEnabled || !performanceTab) return;
  if (performanceQueue.length >= 200) performanceQueue.shift();
  performanceQueue.push({ ...sample, tab: performanceTab, id: crypto.randomUUID() }); schedulePerformance();
}

/** Captures only whitelisted counts/enums; never accept mail objects or text. */
export function measurePerformance(fields: Omit<TimingFields, "outcome">) {
  const start = performance.now(), at = Date.now();
  let finished = false;
  return (extra: Partial<TimingFields> = {}) => {
    if (finished) return;
    finished = true;
    enqueuePerformance({ ...fields, outcome: "ok", ...extra, at, durationMs: rounded(performance.now() - start) });
  };
}

export function measureWork(action: string) { return measurePerformance({ kind: "work", action: safeAction(action) }); }

/** Handler-to-next-frame estimate, not a browser paint/INP measurement. */
export function measureAction(action: string, conversations = 0) {
  const start = performance.now();
  const finish = measurePerformance({ kind: "action", action: safeAction(action), conversations });
  let acceptedMs: number | undefined;
  return {
    accepted() { acceptedMs = rounded(performance.now() - start); },
    finish(outcome: PerformanceSample["outcome"] = "ok") {
      if (!performanceEnabled || outcome === "ignored" || typeof requestAnimationFrame !== "function") { finish({ outcome, acceptedMs }); return; }
      if (document.visibilityState !== "visible") { finish({ outcome: "hidden", acceptedMs }); return; }
      let first = 0, second = 0;
      const fallback = setTimeout(() => { cancelAnimationFrame(first); cancelAnimationFrame(second); finish({ outcome: "hidden", acceptedMs }); }, 2000);
      first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { clearTimeout(fallback); finish({ outcome, acceptedMs }); }); });
    },
  };
}

export function measureRequest(path: string, method: string) {
  const route: PerformanceSample["route"] = ["/v1/mailbox-messages", "/v1/mailbox-snapshot", "/v1/mailbox-changes"].includes(path) ? "mailbox-page"
    : path.includes("/mailbox-actions") || path.endsWith("/state") ? "mailbox-action"
    : path.startsWith("/host/attention-feedback") ? "feedback"
    : path.startsWith("/v1/operations") ? "operation"
    : /\/messages\/[^/]+$/.test(path) ? "message-body"
    : path.startsWith("/v1/drafts") ? "draft"
    : path === "/v1/mailboxes" ? "mailboxes" : "other";
  const finish = measurePerformance({ kind: "request", route,
    method: (["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD"].includes(method) ? method : "GET") as PerformanceSample["method"] });
  const start = performance.now();
  return (status: number) => {
    // Refresh summaries retain page/network totals; don't log every fast GET.
    if (method !== "GET" && route !== "mailbox-page" || status >= 400 || performance.now() - start >= 100) finish({ status, outcome: status && status < 400 ? "ok" : "error" });
  };
}

const levels = ["debug", "log", "info", "warn", "error"] as const;

export type BrowserLog = {
  time: string;
  level: (typeof levels)[number];
  message: string;
};

const logs: BrowserLog[] = [];
const maxMessageLength = 4000;
const credentialKey = /authorization|password|token|secret|cookie|api[-_]?key/i;
const nativeStackGetter = Object.getOwnPropertyDescriptor(
  new Error(),
  "stack",
)?.get;
let stopCapture: (() => void) | undefined;
let recording = false;

function redact(text: string): string {
  return text.replace(
    /([?&])([^=&#\s?]+)=([^&#\s"'<>]*)/g,
    (match, separator: string, key: string) => {
      try {
        return credentialKey.test(decodeURIComponent(key))
          ? `${separator}${key}=[REDACTED]`
          : match;
      } catch {
        return credentialKey.test(key)
          ? `${separator}${key}=[REDACTED]`
          : match;
      }
    },
  );
}

function record(level: BrowserLog["level"], values: unknown[]): void {
  // Proxies can themselves log while being inspected. Never recurse into capture.
  if (recording) return;
  recording = true;
  try {
    const seen = new WeakSet<object>();
    let remainingValues = 100;

    function format(value: unknown, depth = 0): string {
      if (--remainingValues < 0) return "[Truncated]";
      try {
        if (typeof value === "string")
          return redact(value.slice(0, maxMessageLength));
        if (
          value === null ||
          (typeof value !== "object" && typeof value !== "function")
        ) {
          return typeof value === "bigint" ? `${value}n` : String(value);
        }
        if (typeof value === "function") return "[Function]";
        if (typeof Node !== "undefined" && value instanceof Node)
          return "[DOM node]";
        if (seen.has(value)) return "[Circular]";
        if (depth >= 4) return "[Object]";
        seen.add(value);
        try {
          const isArray = Array.isArray(value);
          const keys =
            value instanceof Error
              ? [
                  ...new Set([
                    "name",
                    "message",
                    "stack",
                    "cause",
                    ...Object.keys(value),
                  ]),
                ]
              : Object.keys(value);
          const parts: string[] = [];
          for (const key of keys.slice(0, 20)) {
            if (remainingValues <= 0) break;
            if (credentialKey.test(key)) {
              parts.push(`${JSON.stringify(key.slice(0, 100))}: [REDACTED]`);
              continue;
            }
            // Never invoke application getters, toJSON, or read DOM contents.
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor) continue;
            let content =
              "value" in descriptor
                ? format(descriptor.value, depth + 1)
                : "[Getter]";
            if (
              key === "stack" &&
              nativeStackGetter &&
              descriptor.get === nativeStackGetter &&
              !Object.getOwnPropertyDescriptor(Error, "prepareStackTrace")
            ) {
              // V8 lazily formats stacks through a native getter, reading name/message.
              const safeErrorText = ["name", "message"].every((field) => {
                let target: object | null = value;
                for (let hop = 0; target && hop < 5; hop++) {
                  const property = Object.getOwnPropertyDescriptor(
                    target,
                    field,
                  );
                  if (property)
                    return (
                      "value" in property &&
                      (property.value === undefined ||
                        typeof property.value === "string")
                    );
                  target = Object.getPrototypeOf(target);
                }
                return target === null;
              });
              if (safeErrorText)
                content = format(
                  Reflect.apply(nativeStackGetter, value, []),
                  depth + 1,
                );
            }
            parts.push(
              isArray
                ? content
                : `${JSON.stringify(redact(key.slice(0, 100)))}: ${content}`,
            );
          }
          if (keys.length > 20 || remainingValues <= 0)
            parts.push("[Truncated]");
          return isArray ? `[${parts.join(", ")}]` : `{${parts.join(", ")}}`;
        } finally {
          seen.delete(value);
        }
      } catch {
        return "[Uninspectable]";
      }
    }

    let message = values
      .slice(0, 30)
      .map((value) => format(value))
      .join(" ");
    if (values.length > 30) message += " [Truncated]";
    if (message.length > maxMessageLength)
      message = `${message.slice(0, maxMessageLength - 12)} [Truncated]`;
    logs.push({ time: new Date().toISOString(), level, message });
    if (logs.length > 200) logs.shift();
  } catch {
    // Capturing must never prevent the original console call or error handling.
  } finally {
    recording = false;
  }
}

export function readBrowserLogs(): BrowserLog[] {
  return logs.map((entry) => ({ ...entry }));
}

export function startBrowserLogCapture(): () => void {
  if (stopCapture) return stopCapture;
  let active = true;
  const installed = levels.map((level) => {
    const original = console[level];
    const wrapper = function (this: unknown, ...values: unknown[]) {
      if (active) record(level, values);
      return Reflect.apply(original, this, values);
    };
    console[level] = wrapper;
    return { level, original, wrapper };
  });

  function onError(event: ErrorEvent): void {
    try {
      record("error", [
        event.message,
        `${event.filename}:${event.lineno}:${event.colno}`,
        event.error,
      ]);
    } catch {
      // Custom events may expose throwing accessors.
    }
  }

  function onRejection(event: PromiseRejectionEvent): void {
    try {
      record("error", ["Unhandled rejection:", event.reason]);
    } catch {
      // Custom events may expose throwing accessors.
    }
  }

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const cleanup = () => {
    if (stopCapture !== cleanup) return;
    active = false;
    for (const { level, original, wrapper } of installed) {
      if (console[level] === wrapper) console[level] = original;
    }
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    stopCapture = undefined;
  };
  stopCapture = cleanup;
  return cleanup;
}

if (import.meta.hot) {
  // Iterating on the dev app must not silently turn an active timing session off.
  performanceTab = import.meta.hot.data.performanceTab;
  if (import.meta.hot.data.performanceEnabled === true) configurePerformanceLogging(true);
  import.meta.hot.dispose(data => {
    data.performanceEnabled = performanceEnabled; data.performanceTab = performanceTab;
    stopCapture?.(); configurePerformanceLogging(false);
  });
}
