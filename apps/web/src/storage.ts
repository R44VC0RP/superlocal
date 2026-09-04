import { getApplicationScope, validApplicationScope } from "./application-scope.ts";

/** Captured namespaces never follow a later browser-wide login cookie. */
export function createScopedStorage(scope: string | null) {
  if (scope !== null && !validApplicationScope(scope)) throw new Error("Invalid storage scope.");
  const prefix = scope === null ? "superlocal:" : `superlocal:user:${scope}:`;
  const read = (key: string, session = false): string | null => {
    try { return (session ? sessionStorage : localStorage).getItem(`${prefix}${key}`); }
    catch { return null; }
  };
  const write = (key: string, value: string, session = false): boolean => {
    try { (session ? sessionStorage : localStorage).setItem(`${prefix}${key}`, value); return true; }
    catch { return false; }
  };
  return Object.freeze({
    issueDatabaseName: scope === null ? "superlocal-issues" : `superlocal-issues:${scope}`,
    readText: (key: string) => read(key),
    writeText: (key: string, value: string) => write(key, value),
    readSessionText: (key: string) => read(key, true),
    writeSessionText: (key: string, value: string) => write(key, value, true),
    removeSaved(key: string): boolean {
      try { localStorage.removeItem(`${prefix}${key}`); return true; }
      catch { return false; }
    },
    readSaved<T>(key: string, fallback: T): T {
      try {
        const value = JSON.parse(read(key) || "null");
        if (value === null || fallback !== null && (typeof value !== typeof fallback || Array.isArray(value) !== Array.isArray(fallback))) return fallback;
        return value;
      } catch { return fallback; }
    },
    writeSaved(key: string, value: unknown): boolean {
      try { return write(key, JSON.stringify(value)); }
      catch { return false; }
    },
  });
}

let documentStorage: ReturnType<typeof createScopedStorage> | undefined;
export function getApplicationStorage() {
  // The gate binds the document before the first private read. Never reset this
  // on sign-out: old callbacks may still save A's drafts, but never B's keys.
  return documentStorage ??= createScopedStorage(getApplicationScope().scope);
}
export const readSaved = <T>(key: string, fallback: T): T => getApplicationStorage().readSaved(key, fallback);
export const readText = (key: string) => getApplicationStorage().readText(key);
export const writeText = (key: string, value: string) => getApplicationStorage().writeText(key, value);
export const removeSaved = (key: string) => getApplicationStorage().removeSaved(key);
export const writeSaved = (key: string, value: unknown) => getApplicationStorage().writeSaved(key, value);
export const readSessionText = (key: string) => getApplicationStorage().readSessionText(key);
export const writeSessionText = (key: string, value: string) => getApplicationStorage().writeSessionText(key, value);
