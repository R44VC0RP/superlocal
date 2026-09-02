import { readBrowserLogs, type BrowserLog } from "./browser-logs";

export type IssueReport = {
  id: string;
  prompt: string;
  url: string;
  title: string;
  capturedAt: string;
  updatedAt: string;
  viewport: { width: number; height: number; pixelRatio: number };
  screenshot: Blob;
  logs?: BrowserLog[];
};

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

export async function readIssueReports(): Promise<IssueReport[]> {
  const database = await openIssueDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("reports", "readonly");
      const request = transaction.objectStore("reports").getAll();
      transaction.oncomplete = () =>
        resolve(
          (request.result as IssueReport[]).sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
          ),
        );
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function captureIssueReport(
  element: HTMLElement,
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
  const logs = readBrowserLogs();
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
    prompt: "",
    url,
    title,
    capturedAt,
    updatedAt: capturedAt,
    viewport,
    screenshot,
    logs,
  };
}
