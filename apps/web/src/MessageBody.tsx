import { useEffectEvent, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

export type MessageCanvasColor = readonly [number, number, number];

type MessageBodyProps = {
  html: string;
  text?: string;
  format?: "html" | "text";
  styles?: string;
  fontSize: string;
  onActivate: () => void;
  onKeyboard: (event: KeyboardEvent) => void;
  onImageSettings: () => void;
  onCanvasColor: (color: MessageCanvasColor | null) => void;
};

function canvasColor(doc: Document): MessageCanvasColor | null {
  const view = doc.defaultView;
  if (!view || !doc.documentElement.clientWidth) return null;
  const width = doc.documentElement.clientWidth;
  const height = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
  const coversCanvas = (element: Element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left <= 2 && bounds.top <= 2 && bounds.right >= width - 2 && bounds.bottom >= height - 2;
  };
  const rgba = (value: string) => {
    const match = /^rgba?\(([\d.,\s]+)\)$/.exec(value);
    const channels = match?.[1].split(",").map(Number);
    if (!channels || (channels.length !== 3 && channels.length !== 4)
      || channels.some((channel, index) => !Number.isFinite(channel) || channel < 0 || channel > (index === 3 ? 1 : 255))) return null;
    return [...channels.slice(0, 3), channels[3] ?? 1];
  };
  let color: MessageCanvasColor | null = null;
  let element: Element = doc.documentElement;
  // Follow only a single full-canvas wrapper chain, never banners, links or images.
  for (let depth = 0; depth < 12; depth++) {
    const style = view.getComputedStyle(element);
    if (style.opacity !== "1" || style.filter !== "none" || style.mixBlendMode !== "normal"
      || style.transform !== "none" || style.visibility !== "visible") return null;
    const background = rgba(style.backgroundColor);
    if (!background || style.backgroundImage !== "none") color = null;
    else if (background[3] === 1) color = [background[0], background[1], background[2]];
    else if (background[3] > 0 && color) {
      const mixed: number[] = color.map((channel, index) => background[index] * background[3] + channel * (1 - background[3]));
      color = [mixed[0], mixed[1], mixed[2]];
    }
    if (element === doc.documentElement) {
      // CSS propagates the body's background to a transparent root canvas.
      if (!coversCanvas(doc.body) && !(background?.[3] === 0 && style.backgroundImage === "none")) break;
      element = doc.body;
      continue;
    }
    if (element.childElementCount > 100) break;
    const wrappers = Array.from(element.children).filter(child =>
      /^(DIV|TABLE|TBODY|TR|TD|CENTER|SECTION|MAIN|ARTICLE)$/.test(child.tagName) && coversCanvas(child));
    if (wrappers.length !== 1) break;
    const position = view.getComputedStyle(wrappers[0]).position;
    if (position === "absolute" || position === "fixed") break;
    element = wrappers[0];
  }
  return color;
}

function linkedText(text: string): ReactNode[] {
  const result: ReactNode[] = [];
  const pattern = /\bhttps?:\/\/[^\s<>"']+|\bmailto:[^\s<>"]+|[^\s<>()\[\]{},;:"]+@[^\s<>()\[\]{},;:"]+/gi;
  const address = /^[A-Z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?\.)+[A-Z]{2,}$/i;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const quoted = match[0].startsWith("'") && match[0].endsWith("'");
    const index = match.index! + (quoted ? 1 : 0);
    let value = (quoted ? match[0].slice(1, -1) : match[0]).replace(/[.,;:!?]+$/, "");
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1);
    }
    let href = value;
    if (!/^(?:https?:\/\/|mailto:)/i.test(value)) {
      if (!address.test(value)) continue;
      const at = value.lastIndexOf("@");
      href = `mailto:${encodeURIComponent(value.slice(0, at))}@${value.slice(at + 1)}`;
    }
    try {
      if (!["https:", "http:", "mailto:"].includes(new URL(href).protocol)) continue;
    } catch { continue; }
    result.push(text.slice(start, index));
    result.push(<a key={index} href={href} target="_blank" rel="noopener noreferrer">{value}</a>);
    start = index + value.length;
  }
  result.push(text.slice(start));
  return result;
}

function unavailableImage(image: HTMLImageElement, reason: "inline image unavailable" | "image unavailable") {
  if (image.dataset.inboxImageError) return;
  image.dataset.inboxImageError = reason;
  const style = image.ownerDocument.defaultView?.getComputedStyle(image);
  if (image.getAttribute("alt") === "" || style?.display === "none" || style?.visibility === "hidden") {
    image.style.setProperty("opacity", "0", "important");
    return;
  }
  const missing = image.ownerDocument.createElement("span");
  const bounds = image.getBoundingClientRect();
  const width = bounds.width || image.width;
  const height = bounds.height || image.height;
  const compact = width > 0 && width <= 64;
  const label = image.alt ? `${image.alt} (${reason})` : reason === "image unavailable" ? "Image unavailable" : "Inline image unavailable";
  missing.setAttribute("role", "img");
  missing.setAttribute("aria-label", label);
  missing.title = label;
  missing.dataset.inboxImageError = reason;
  missing.textContent = compact ? "×" : label;
  missing.style.cssText = 'display:inline-block;box-sizing:border-box;max-width:100%;padding:6px 8px;background:#f1f1f1;color:#555;font:13px/1.5 "Helvetica Neue",sans-serif;letter-spacing:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle';
  if (compact) {
    missing.style.width = `${width}px`;
    missing.style.height = missing.style.lineHeight = `${height || width}px`;
    missing.style.padding = "0";
    missing.style.textAlign = "center";
  }
  image.replaceWith(missing);
}

function emailDocument(html: string, styles: string, fontSize: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const id = crypto.randomUUID();
  doc.documentElement.dataset.inboxDocument = id;
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const referrer = doc.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  const viewport = doc.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  const defaults = doc.createElement("style");
  const size = fontSize === "Large" ? 17 : fontSize === "Small" ? 14 : 15;
  defaults.textContent = `
    :where(html) { color-scheme: light; color: #222; background: #fff; font: ${size}px/1.6 "Helvetica Neue", sans-serif; -webkit-font-smoothing: antialiased; }
    :where(body) { margin: 0; overflow-wrap: anywhere; }
    :where(img, table) { max-width: 100%; }
    :where(img) { height: auto; }
    :where(pre) { white-space: pre-wrap; overflow-wrap: anywhere; }
    :where(pre, code) { font-family: "Berkeley Mono", monospace; }
    :where(a) { color: #3859a7; }
    :where(a:focus-visible) { outline: 2px solid currentColor; outline-offset: 2px; }
    html { overflow-y: hidden; }
  `;
  const author = doc.createElement("style");
  // The SDK allowlists this CSS; raw-text escaping also keeps it inside its style element.
  author.textContent = styles.replace(/<\/style/gi, "<\\/style");
  doc.head.replaceChildren(charset, policy, referrer, viewport, defaults, author);
  for (const image of doc.querySelectorAll('img[data-inbox-tracking="true"]')) image.remove();
  for (const image of doc.querySelectorAll<HTMLImageElement>('img[src^="cid:" i]')) {
    unavailableImage(image, "inline image unavailable");
  }
  let blockedImages = 0;
  for (const image of doc.querySelectorAll<HTMLImageElement>("img[data-openmail-src]:not([src])")) {
    const pixel = Number(image.getAttribute("width")) === 1 && Number(image.getAttribute("height")) === 1;
    if (pixel || image.style.display === "none" || image.style.visibility === "hidden" || image.style.opacity === "0") {
      image.remove();
      continue;
    }
    if (image.getAttribute("alt") !== "") blockedImages++;
    // Keep image selectors, dimensions and alt semantics without a broken-image icon.
    image.style.setProperty("opacity", "0", "important");
  }
  return { id, html: `<!doctype html>${doc.documentElement.outerHTML}`, blockedImages };
}

export default function MessageBody({ html, text = "", format, styles = "", fontSize, onActivate, onKeyboard, onImageSettings, onCanvasColor }: MessageBodyProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const cleanup = useRef<() => void>(() => {});
  const activate = useEffectEvent(onActivate);
  const keyboard = useEffectEvent(onKeyboard);
  const reportCanvas = useEffectEvent(onCanvasColor);
  const plain = format === "text";
  const document = useMemo(() => plain ? null : emailDocument(html, styles, fontSize), [plain, html, styles, fontSize]);
  const content = useMemo(() => plain ? linkedText(text) : null, [plain, text]);

  useLayoutEffect(() => {
    reportCanvas(null);
    if (!document) return;
    let waiting = 0;
    const attach = () => {
      const doc = frame.current?.contentDocument;
      if (doc?.body && doc.documentElement?.dataset.inboxDocument === document.id && doc.readyState !== "loading") loaded();
      else waiting = requestAnimationFrame(attach);
    };
    waiting = requestAnimationFrame(attach);
    return () => { cancelAnimationFrame(waiting); cleanup.current(); };
  }, [document]);

  function loaded() {
    const element = frame.current, doc = element?.contentDocument;
    if (!element || !doc?.body || doc.documentElement.dataset.inboxDocument !== document?.id) return;
    cleanup.current();
    let pending = 0;
    let width = element.clientWidth;
    let disposed = false;
    const root = doc.documentElement;
    const originalZoom = root.style.getPropertyValue("zoom"), originalPriority = root.style.getPropertyPriority("zoom");
    const restoreZoom = () => {
      if (originalZoom) root.style.setProperty("zoom", originalZoom, originalPriority);
      else root.style.removeProperty("zoom");
    };
    const measure = () => {
      pending = 0;
      if (disposed || !element.isConnected || width <= 0) return;
      // Measure the authored canvas afresh, never an already-scaled width.
      // Scale the whole document so rigid tables, padding, text and images keep
      // their proportions; changing individual widths cannot fit those layouts.
      restoreZoom();
      // Measure at a small viewport so shorter content can shrink after a resize.
      element.style.height = "1px";
      const contentWidth = Math.max(doc.body.scrollWidth, root.scrollWidth, width);
      const scale = Math.min(1, width / contentWidth);
      if (scale < 1) root.style.setProperty("zoom", String(scale), "important");
      // Body scroll dimensions remain in unscaled CSS pixels; the root's scroll
      // height includes the scaled layout. Do not leave an unscaled blank tail.
      const height = Math.ceil(Math.max(doc.body.scrollHeight * scale, root.scrollHeight, doc.body.getBoundingClientRect().bottom + (element.contentWindow?.scrollY ?? 0), 1));
      element.style.height = `${height}px`;
      const scrollbar = Math.max(0, (element.contentWindow?.innerHeight ?? height) - doc.documentElement.clientHeight);
      if (scrollbar) element.style.height = `${height + scrollbar}px`;
      reportCanvas(canvasColor(doc));
    };
    const schedule = () => { if (!pending && !disposed) pending = requestAnimationFrame(measure); };
    const bodySize = new ResizeObserver(schedule);
    bodySize.observe(doc.body);
    const frameSize = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      schedule();
    });
    frameSize.observe(element);
    const onKey = (event: KeyboardEvent) => { activate(); keyboard(event); };
    const onFocus = () => activate();
    const onError = (event: Event) => {
      const image = event.target as HTMLImageElement | null;
      if (image?.tagName === "IMG" && image.hasAttribute("src")) unavailableImage(image, "image unavailable");
      schedule();
    };
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("pointerdown", onFocus, true);
    doc.addEventListener("focusin", onFocus, true);
    doc.addEventListener("load", schedule, true);
    doc.addEventListener("error", onError, true);
    for (const image of Array.from(doc.images)) {
      if (image.hasAttribute("src") && image.complete && !image.naturalWidth) unavailableImage(image, "image unavailable");
    }
    void doc.fonts.ready.then(schedule);
    measure();
    cleanup.current = () => {
      disposed = true;
      cancelAnimationFrame(pending);
      bodySize.disconnect();
      frameSize.disconnect();
      restoreZoom();
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("pointerdown", onFocus, true);
      doc.removeEventListener("focusin", onFocus, true);
      doc.removeEventListener("load", schedule, true);
      doc.removeEventListener("error", onError, true);
    };
  }

  const sizeClass = fontSize === "Large" ? "message-large-text" : fontSize === "Small" ? "message-small-text" : "";
  return (
    <div className={`message-body thread-body ${plain ? "message-plain-text" : "message-html-body"} ${sizeClass}`}>
      {plain ? <div dir="auto">{content}</div> : <>
        {!!document?.blockedImages && <div className="message-image-policy">
          <span>Remote images are blocked.</span>
          <button type="button" onClick={onImageSettings}>Image settings</button>
        </div>}
        <iframe
          ref={frame}
          className="message-html-frame"
          title="Email content"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={document?.html}
          onLoad={loaded}
        />
      </>}
    </div>
  );
}
