export type HostProvider = {
  id: string;
  name: string;
  connection: "oauth" | "credentials" | "none";
  enabled: boolean;
  ready: boolean;
  setupMessage?: string;
  actionLabel?: string;
  fields?: Array<{ name: string; label: string; type: "password" | "text"; required: boolean }>;
  connectionIds: string[];
};

export type HostConfiguration = {
  mode: "mock" | "real";
  allowProviderWrites: boolean;
  providers: HostProvider[];
};

async function request<T>(path: string, signal: AbortSignal, credentials?: Record<string, string>): Promise<T> {
  const response = await fetch(path, {
    method: credentials === undefined ? "GET" : "POST",
    credentials: "include", cache: "no-store", signal,
    ...(credentials === undefined ? {} : {
      headers: { "Content-Type": "application/json", "X-Superlocal": "1" },
      body: JSON.stringify(Object.keys(credentials).length ? { credentials } : {}),
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "The host could not complete account setup.");
  if (!result || typeof result !== "object") throw new Error("The host returned an invalid setup response.");
  return result as T;
}

export async function readHostConfiguration(signal: AbortSignal): Promise<HostConfiguration> {
  const config = await request<HostConfiguration>("/host/config", signal);
  if (!["mock", "real"].includes(config.mode) || typeof config.allowProviderWrites !== "boolean" || !Array.isArray(config.providers)) {
    throw new Error("The host did not provide a valid provider configuration.");
  }
  return config;
}

export function connectHostProvider(id: string, credentials: Record<string, string>, signal: AbortSignal) {
  return request<{ connectionId?: string; authorizeUrl?: string }>(`/host/providers/${encodeURIComponent(id)}/connect`, signal, credentials);
}
