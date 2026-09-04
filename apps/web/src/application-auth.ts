export type ApplicationAccess =
  | { method: "loopback" }
  | { method: "google"; authenticated: boolean; user: { name: string; email: string } | null };

export const AUTH_REQUIRED_EVENT = "superlocal:auth-required";

export function checkAuthenticationResponse(response: Response): void {
  if (response.status === 401 && response.headers.get("X-Superlocal-Auth") === "required") {
    globalThis.dispatchEvent?.(new Event(AUTH_REQUIRED_EVENT));
  }
}

async function authRequest(path: string, method: "GET" | "POST", signal?: AbortSignal): Promise<Response> {
  const deadline = AbortSignal.timeout(10_000);
  const response = await fetch(path, {
    method, signal: signal ? AbortSignal.any([signal, deadline]) : deadline, credentials: "include", cache: "no-store",
    ...(method === "POST" ? { headers: { "Content-Type": "application/json", "X-Superlocal": "1" }, body: "{}" } : {}),
  });
  if (!response.ok) throw new Error("Application authentication could not be completed.");
  return response;
}

export async function readApplicationAccess(signal?: AbortSignal): Promise<ApplicationAccess> {
  const value: unknown = await (await authRequest("/host/auth", "GET", signal)).json();
  if (!value || typeof value !== "object" || !("method" in value)) throw new Error("Invalid access response.");
  if (value.method === "loopback") return { method: "loopback" };
  if (value.method !== "google" || !("authenticated" in value) || typeof value.authenticated !== "boolean") throw new Error("Invalid access response.");
  const user = "user" in value ? value.user : null;
  if (value.authenticated && (!user || typeof user !== "object" || !("name" in user) || typeof user.name !== "string" || !("email" in user) || typeof user.email !== "string")) {
    throw new Error("Invalid signed-in identity.");
  }
  return { method: "google", authenticated: value.authenticated, user: value.authenticated ? user as { name: string; email: string } : null };
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
