export function validApplicationScope(scope: unknown): scope is string {
  return typeof scope === "string" && /^[a-f0-9]{64}$/.test(scope);
}

/** One owner for the lifetime of a document, including its delayed work. */
export function createApplicationScope(scope: string | null) {
  if (scope !== null && !validApplicationScope(scope)) throw new Error("Invalid application scope.");
  const controller = new AbortController();
  return Object.freeze({
    scope,
    signal: controller.signal,
    lock: () => controller.abort(new DOMException("Application access changed", "AbortError")),
  });
}

export type ApplicationScope = ReturnType<typeof createApplicationScope>;
const loopback = createApplicationScope(null);
let documentScope: ApplicationScope | undefined;

// Standalone/local consumers retain the original keys. The application gate
// binds before mounting any private UI; it never reads storage before access.
export function getApplicationScope(): ApplicationScope { return documentScope ?? loopback; }

export function bindApplicationScope(scope: string | null): ApplicationScope {
  if (documentScope && (documentScope.scope !== scope || documentScope.signal.aborted)) {
    throw new Error("A fresh document is required to open this inbox.");
  }
  documentScope ??= createApplicationScope(scope);
  return documentScope;
}
