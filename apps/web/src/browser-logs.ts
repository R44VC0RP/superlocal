/// <reference types="vite/client" />

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

if (import.meta.hot) import.meta.hot.dispose(() => stopCapture?.());
