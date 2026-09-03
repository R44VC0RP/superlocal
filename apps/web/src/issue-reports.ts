import { readBrowserLogs, type BrowserLog } from "./browser-logs.ts";
import {
  ISSUE_LIMITS,
  type IssueBuild,
  type IssueCapture,
  type IssueDetail,
  type IssueFrame,
  type IssuePage,
  type IssueSummary,
  type IssueWrite,
} from "../../shared/issue-reports.ts";

export type IssueReport = IssueCapture & {
  screenshot: Blob;
  logs?: BrowserLog[];
  revision?: number;
  pending?: { token: string; write: IssueWrite };
};

export type IssueListEntry = IssueCapture & {
  storage: "browser" | "repo";
  pending?: boolean;
};

// Keep this projection explicit: repo response fields and browser bookkeeping are
// not part of the host's strict write contract.
function captureFields(report: IssueCapture): IssueCapture {
  return {
    id: report.id, scope: report.scope, prompt: report.prompt,
    url: report.url, title: report.title,
    capturedAt: report.capturedAt, updatedAt: report.updatedAt,
    viewport: { ...report.viewport },
    ...(report.build ? { build: { ...report.build, assets: [...report.build.assets] } } : {}),
    ...(report.rendering ? { rendering: report.rendering.map(frame => ({ ...frame })) } : {}),
  };
}

async function openIssueDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("superlocal-issues", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("reports", { keyPath: "id" });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      request.onsuccess = () => request.result.close();
      reject(new Error("Issue storage is blocked by another tab."));
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function saveIssueReport(report: IssueReport): Promise<void> {
  const database = await openIssueDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("reports", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
      transaction.objectStore("reports").put(report);
    });
  } finally {
    database.close();
  }
}

export async function removeIssueAttempt(id: string, scope: string, token: string): Promise<void> {
  const database = await openIssueDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("reports", "readwrite");
      const store = transaction.objectStore("reports");
      const request = store.get(id);
      request.onsuccess = () => {
        const current = request.result as IssueReport | undefined;
        // An older acknowledgement must never delete a later edit from another tab.
        if (current?.scope === scope && current.pending?.token === token) store.delete(id);
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function readIssueReports(scope?: string): Promise<IssueListEntry[]> {
  const database = await openIssueDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const reports: IssueListEntry[] = [];
      const transaction = database.transaction("reports", "readonly");
      const request = transaction.objectStore("reports").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const report = cursor.value as IssueReport;
        // Legacy records never acquire a scope; another context's pending reports
        // stay in the original store, but are not shown or uploaded here.
        if (!report.scope || report.scope === scope) {
          reports.push({ ...captureFields(report), storage: "browser", pending: !!report.scope });
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(reports.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function readBrowserIssueReport(id: string, scope?: string): Promise<IssueReport> {
  const database = await openIssueDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("reports", "readonly");
      const request = transaction.objectStore("reports").get(id);
      transaction.oncomplete = () => {
        const report = request.result as IssueReport | undefined;
        if (report && (!report.scope || report.scope === scope)) resolve(report);
        else reject(new Error("This browser copy is no longer available in this host context."));
      };
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export function prepareIssueAttempt(report: IssueReport, prompt: string): IssueReport {
  const text = prompt.trim();
  if (!report.scope) throw new Error("This capture is browser-only.");
  if (!text || text.length > ISSUE_LIMITS.promptCharacters) throw new Error("Describe the issue in 10,000 characters or fewer.");
  // A lost acknowledgement is retried with the original revision and payload,
  // even after reload. Editing the prompt is a new CAS attempt, never a rebase.
  const write = report.pending?.write.prompt === text ? report.pending.write : {
    ...captureFields(report), scope: report.scope,
    prompt: text, updatedAt: new Date().toISOString(), revision: report.revision ?? 0,
    ...(report.logs ? { logs: report.logs.map(entry => ({ ...entry })) } : {}),
  };
  return { ...report, prompt: text, updatedAt: write.updatedAt, pending: { token: crypto.randomUUID(), write } };
}

export class IssueRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "IssueRequestError";
    this.status = status;
  }
}

async function issueResponse(response: Response): Promise<unknown> {
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    throw new IssueRequestError(response.status === 412
      ? "This report changed in the repo. Your edit was not applied; open the repo copy to review it before editing again."
      : "The local host could not complete this issue request.", response.status);
  }
  return value;
}

function isIssueSummary(value: unknown, scope: string): value is IssueSummary {
  if (!value || typeof value !== "object") return false;
  const report = value as IssueSummary;
  return typeof report.id === "string" && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(report.id) &&
    report.scope === scope && report.storage === "repo" && Number.isSafeInteger(report.revision) && report.revision > 0 &&
    typeof report.prompt === "string" && typeof report.title === "string" && typeof report.url === "string" &&
    typeof report.capturedAt === "string" && typeof report.updatedAt === "string" &&
    !!report.viewport && Number.isFinite(report.viewport.width) && Number.isFinite(report.viewport.height) &&
    !!report.image && ["image/jpeg", "image/png"].includes(report.image.contentType) &&
    report.image.bytes > 0 && report.image.bytes <= ISSUE_LIMITS.screenshotBytes;
}

export async function readRepoIssuePage(scope: string, cursor?: string, signal?: AbortSignal): Promise<IssuePage> {
  const query = new URLSearchParams({ limit: String(ISSUE_LIMITS.pageSize) });
  if (cursor) query.set("cursor", cursor);
  const value = await issueResponse(await fetch(`/host/issues?${query}`, { credentials: "include", cache: "no-store", signal }));
  const page = value as IssuePage | null;
  if (!page || page.scope !== scope || !Array.isArray(page.items) || page.items.length > ISSUE_LIMITS.maxPageSize ||
    !page.items.every(item => isIssueSummary(item, scope)) || !(page.nextCursor === null || typeof page.nextCursor === "string")) {
    throw new Error("The local host returned an invalid issue list.");
  }
  return page;
}

export async function readRepoIssueReport(id: string, scope: string, signal?: AbortSignal): Promise<IssueReport> {
  const path = `/host/issues/${encodeURIComponent(id)}`;
  const detail = await issueResponse(await fetch(path, { credentials: "include", cache: "no-store", signal })) as IssueDetail;
  if (!isIssueSummary(detail, scope) || detail.id !== id || !Array.isArray(detail.logs) || detail.logs.length > ISSUE_LIMITS.logs) {
    throw new Error("The local host returned an invalid issue report.");
  }
  const response = await fetch(`${path}/screenshot`, { credentials: "include", cache: "no-store", signal });
  if (!response.ok) throw new Error("Could not load this report's screenshot. Try opening it again.");
  const screenshot = await response.blob();
  if (screenshot.type !== detail.image.contentType || screenshot.size !== detail.image.bytes) throw new Error("The report's screenshot was incomplete.");
  return { ...captureFields(detail), revision: detail.revision, logs: detail.logs, screenshot };
}

export async function writeRepoIssueReport(report: IssueReport, scope: string): Promise<IssueSummary> {
  const write = report.pending?.write;
  if (!write || write.scope !== scope || report.scope !== scope) throw new Error("This capture belongs to another host context.");
  const json = JSON.stringify(write);
  if (new Blob([json]).size > ISSUE_LIMITS.metadataBytes) throw new Error("This report's diagnostics exceed the local issue limit.");
  if (!["image/jpeg", "image/png"].includes(report.screenshot.type) || !report.screenshot.size || report.screenshot.size > ISSUE_LIMITS.screenshotBytes) {
    throw new Error("The screenshot must be a JPEG or PNG no larger than 8 MB.");
  }
  const body = new FormData();
  body.set("report", json);
  body.set("screenshot", report.screenshot, report.screenshot.type === "image/jpeg" ? "screenshot.jpg" : "screenshot.png");
  const saved = await issueResponse(await fetch(`/host/issues/${encodeURIComponent(write.id)}`, {
    method: "PUT", credentials: "include", cache: "no-store", headers: { "X-Superlocal": "1" }, body,
  }));
  if (!isIssueSummary(saved, scope) || saved.id !== write.id) throw new Error("The local host did not acknowledge this report. Retry to confirm the save.");
  return saved;
}

export function issueScriptPaths(sources: string[], origin: string): string[] {
  const paths = new Set<string>();
  for (const source of sources) {
    try {
      const url = new URL(source, origin);
      if (url.origin === origin && !url.username && !url.password && url.pathname.length <= 512 &&
        /^\/[A-Za-z0-9_./@-]+\.(?:js|mjs|cjs|ts|tsx)$/.test(url.pathname) && !url.pathname.split("/").includes("..")) paths.add(url.pathname);
    } catch { /* Invalid script URLs carry no useful build metadata. */ }
    if (paths.size === 20) break;
  }
  return [...paths];
}

function captureRendering(element: HTMLElement): IssueFrame[] {
  const bounded = (value: number) => Math.max(0, Math.min(100000, Number.isFinite(value) ? value : 0));
  return Array.from(element.querySelectorAll("iframe")).slice(0, ISSUE_LIMITS.frames).map(frame => {
    const rect = frame.getBoundingClientRect();
    const result: IssueFrame = { width: bounded(rect.width), height: bounded(rect.height) };
    try {
      const root = frame.contentDocument?.documentElement;
      const body = frame.contentDocument?.body;
      if (root) {
        result.scrollWidth = bounded(root.scrollWidth);
        const scale = Number.parseFloat(root.style.zoom) || 1;
        if (scale > 0) result.scale = Math.min(100, scale);
      }
      if (body) result.bodyScrollWidth = bounded(body.scrollWidth);
    } catch { /* Cross-origin frames expose only their outer dimensions. */ }
    return result;
  });
}

export async function captureIssueReport(
  element: HTMLElement,
  issueScope?: string,
): Promise<IssueReport> {
  // Let the command palette unmount and its focus cleanup settle before cloning.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  const { domToBlob } = await import("modern-screenshot");
  const capturedAt = new Date().toISOString();
  const viewport = {
    width: innerWidth,
    height: innerHeight,
    pixelRatio: devicePixelRatio,
  };
  const url = location.href;
  const title = document.title;
  const logs = readBrowserLogs().slice(-ISSUE_LIMITS.logs).map(entry => ({
    ...entry, message: entry.message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, ISSUE_LIMITS.logCharacters),
  }));
  const build: IssueBuild = {
    mode: import.meta.env?.PROD ? "optimized" : import.meta.env?.DEV ? "development" : "unknown",
    assets: issueScriptPaths(Array.from(document.scripts, script => script.src).filter(Boolean), location.origin),
  };
  const rendering = captureRendering(element);
  const backdrop = getComputedStyle(element, "::before");
  const screenshot = await domToBlob(element, {
    type: "image/jpeg",
    quality: 0.92,
    width: viewport.width,
    height: viewport.height,
    scale: 1,
    timeout: 15000,
    features: { restoreScrollPosition: true, copyScrollbar: false },
    filter: (node) =>
      !(
        node instanceof Element &&
        (node.matches(
          "[data-issue-ui], .modal-backdrop:has(> .command-modal), [hidden], [inert]",
        ) ||
          getComputedStyle(node).display === "none")
      ),
    onCloneNode: (clone) => {
      if (!(clone instanceof HTMLElement)) return;
      // Fixed clone heights suppress the collapsing margins between recent items.
      clone
        .querySelectorAll<HTMLElement>(".recent-list > div")
        .forEach((item) => {
          item.style.height = "auto";
          item.style.blockSize = "auto";
        });
      // Pseudo-element image URLs are not embedded by the renderer. Materialize
      // the backdrop only in the clone so its photo and current transform survive.
      if (backdrop.content !== "none" && backdrop.backgroundImage !== "none") {
        const layer = document.createElement("div");
        for (const property of [
          "position",
          "inset",
          "width",
          "height",
          "z-index",
          "background",
          "transform",
          "transform-origin",
          "opacity",
        ]) {
          layer.style.setProperty(
            property,
            backdrop.getPropertyValue(property),
          );
        }
        clone.prepend(layer);
        const style = document.createElement("style");
        style.textContent = ".app::before { content: none !important; }";
        clone.appendChild(style);
      }
    },
  });
  if (!screenshot?.size) throw new Error("The screenshot was empty.");
  return {
    id: crypto.randomUUID(),
    ...(issueScope ? { scope: issueScope } : {}),
    prompt: "",
    url,
    title,
    capturedAt,
    updatedAt: capturedAt,
    viewport,
    screenshot,
    logs,
    build,
    rendering,
  };
}
