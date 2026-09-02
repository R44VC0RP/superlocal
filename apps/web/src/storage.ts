export function readSaved<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(
      localStorage.getItem(`superlocal:${key}`) || "null",
    );
    if (value === null) return fallback;
    if (
      fallback !== null &&
      (typeof value !== typeof fallback ||
        Array.isArray(value) !== Array.isArray(fallback))
    )
      return fallback;
    return value;
  } catch {
    return fallback;
  }
}

export function readText(key: string): string | null {
  try {
    return localStorage.getItem(`superlocal:${key}`);
  } catch {
    return null;
  }
}

export function writeText(key: string, value: string): boolean {
  try {
    localStorage.setItem(`superlocal:${key}`, value);
    return true;
  } catch {
    return false;
  }
}

export function removeSaved(key: string): boolean {
  try {
    localStorage.removeItem(`superlocal:${key}`);
    return true;
  } catch {
    return false;
  }
}

export function writeSaved(key: string, value: unknown): boolean {
  try {
    return writeText(key, JSON.stringify(value));
  } catch {
    return false;
  }
}
