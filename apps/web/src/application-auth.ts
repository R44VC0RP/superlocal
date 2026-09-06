import { getApplicationScope, validApplicationScope, type ApplicationScope } from "./application-scope.ts";

export type ApplicationAccess =
  | { method: "loopback" }
  | { method: "google"; authenticated: true; user: { name: string; email: string }; scope: string }
  | { method: "google"; authenticated: false; user: null; scope: null };

export const AUTH_REQUIRED_EVENT = "superlocal:auth-required";
const RECOVERY_SCOPE_KEY = "superlocal:auth-recovery-scope";
const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000];

export class ApplicationAccessUnavailable extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs = 0) {
    super("Application authentication is temporarily unavailable.");
    this.name = "ApplicationAccessUnavailable";
    this.retryAfterMs = retryAfterMs;
  }
}

export function applicationAccessRetryDelay(attempt: number, startedAt: number, now = Date.now(), retryAfterMs = 0): number | null {
  if (!Number.isInteger(attempt) || attempt < 0 || !Number.isFinite(startedAt) || !Number.isFinite(now) || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return null;
  const delay = Math.max(RETRY_DELAYS[attempt] ?? Infinity, retryAfterMs);
  return Number.isFinite(delay) && now + delay < startedAt + 120_000 ? delay : null;
}

/** Restricts the next document's route; this never authenticates a user. */
export function rememberApplicationRecoveryScope(scope: string): boolean {
  if (!validApplicationScope(scope)) return false;
  try {
    sessionStorage.setItem(RECOVERY_SCOPE_KEY, scope);
    return sessionStorage.getItem(RECOVERY_SCOPE_KEY) === scope;
  } catch { return false; }
}

/** An empty string means storage was invalid/unavailable: discard the old route. */
export function takeApplicationRecoveryScope(): string | null {
  try {
    const scope = sessionStorage.getItem(RECOVERY_SCOPE_KEY);
    sessionStorage.removeItem(RECOVERY_SCOPE_KEY);
    return scope === null ? null : validApplicationScope(scope) ? scope : "";
  } catch { return ""; }
}

function transientTransport(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException && error.name === "TimeoutError";
}

export function checkAuthenticationResponse(response: Response, binding?: ApplicationScope): void {
  if ((response.status === 401 || response.status === 409) && response.headers.get("X-Superlocal-Auth") === "required") {
    binding?.lock();
    globalThis.dispatchEvent?.(new Event(AUTH_REQUIRED_EVENT));
  }
}

/** All SDK requests (including SSE) and private host requests use this fence. */
export function createScopedFetch(binding: ApplicationScope): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    // The caller cannot replace the owner fence, even via a Request object.
    headers.delete("X-Superlocal-Scope");
    if (binding.scope !== null) headers.set("X-Superlocal-Scope", binding.scope);
    const inputSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = inputSignal ? AbortSignal.any([binding.signal, inputSignal]) : binding.signal;
    signal.throwIfAborted();
    const response = await fetch(input, { ...init, headers, signal });
    checkAuthenticationResponse(response, binding.scope === null ? undefined : binding);
    // Also fence mocked/late transports that ignore abort, before SDK caching.
    signal.throwIfAborted();
    return response;
  }) as typeof fetch;
}

export function privateFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return createScopedFetch(getApplicationScope())(input, init);
}

async function authRequest(path: string, method: "GET" | "POST", signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await fetch(path, {
      method, signal: signal ? AbortSignal.any([signal, deadline]) : deadline, credentials: "include", cache: "no-store",
      ...(method === "POST" ? { headers: { "Content-Type": "application/json", "X-Superlocal": "1",
        ...(path === "/host/auth/sign-out" && getApplicationScope().scope ? { "X-Superlocal-Scope": getApplicationScope().scope! } : {}) }, body: "{}" } : {}),
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (transientTransport(error)) throw new ApplicationAccessUnavailable();
    throw error;
  }
  signal?.throwIfAborted();
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 429 || response.status >= 500) {
      const after = response.headers.get("Retry-After");
      const wait = after === null ? 0 : /^\d+$/.test(after) ? Number(after) * 1_000 : Date.parse(after) - Date.now();
      throw new ApplicationAccessUnavailable(Number.isFinite(wait) ? Math.min(120_000, Math.max(0, wait)) : 0);
    }
    throw new Error("Application authentication could not be completed.");
  }
  return response;
}

export async function readApplicationAccess(signal?: AbortSignal): Promise<ApplicationAccess> {
  const response = await authRequest("/host/auth", "GET", signal);
  if (response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    void response.body?.cancel().catch(() => {});
    throw new ApplicationAccessUnavailable();
  }
  let value: unknown;
  try { value = await response.json(); }
  catch (error) {
    signal?.throwIfAborted();
    if (transientTransport(error)) throw new ApplicationAccessUnavailable();
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("Invalid access response.");
  }
  signal?.throwIfAborted();
  if (!value || typeof value !== "object" || !("method" in value)) throw new Error("Invalid access response.");
  if (value.method === "loopback") return { method: "loopback" };
  if (value.method !== "google" || !("authenticated" in value) || typeof value.authenticated !== "boolean") throw new Error("Invalid access response.");
  const user = "user" in value ? value.user : null;
  const scope = "scope" in value ? value.scope : null;
  if (!value.authenticated) return { method: "google", authenticated: false, user: null, scope: null };
  if (!validApplicationScope(scope) || !user || typeof user !== "object" || !("name" in user) || typeof user.name !== "string" || !("email" in user) || typeof user.email !== "string") {
    throw new Error("Invalid signed-in identity.");
  }
  return { method: "google", authenticated: true, user: user as { name: string; email: string }, scope };
}

export async function beginGoogleLogin(signal?: AbortSignal): Promise<string> {
  const value: unknown = await (await authRequest("/host/auth/sign-in", "POST", signal)).json();
  if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string") throw new Error("Invalid sign-in response.");
  const url = new URL(value.url);
  if (url.origin !== "https://accounts.google.com" || url.username || url.password) throw new Error("Unexpected sign-in destination.");
  return url.href;
}

export async function signOutApplication(signal?: AbortSignal): Promise<void> {
  await authRequest("/host/auth/sign-out", "POST", signal);
}
