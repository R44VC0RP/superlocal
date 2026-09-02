import { useEffectEvent, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

type MessageBodyProps = {
  html: string;
  text?: string;
  format?: "html" | "text";
  styles?: string;
  fontSize: string;
  onActivate: () => void;
  onKeyboard: (event: KeyboardEvent) => void;
  onImageSettings: () => void;
};

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
    const missing = doc.createElement("span");
    missing.setAttribute("role", "img");
    missing.textContent = image.alt ? `${image.alt} (inline image unavailable)` : "Inline image unavailable";
    missing.style.cssText = 'display:inline-block;max-width:100%;padding:6px 8px;background:#f1f1f1;color:#555;font:13px/1.5 "Helvetica Neue",sans-serif;overflow-wrap:anywhere';
    image.replaceWith(missing);
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

export default function MessageBody({ html, text = "", format, styles = "", fontSize, onActivate, onKeyboard, onImageSettings }: MessageBodyProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const cleanup = useRef<() => void>(() => {});
  const activate = useEffectEvent(onActivate);
  const keyboard = useEffectEvent(onKeyboard);
  const plain = format === "text";
  const document = useMemo(() => plain ? null : emailDocument(html, styles, fontSize), [plain, html, styles, fontSize]);
  const content = useMemo(() => plain ? linkedText(text) : null, [plain, text]);

  useLayoutEffect(() => {
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
    const measure = () => {
      pending = 0;
      if (disposed || !element.isConnected) return;
      // Measure at a small viewport so shorter content can shrink after a resize.
      element.style.height = "1px";
      const height = Math.ceil(Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 1));
      element.style.height = `${height}px`;
      const scrollbar = Math.max(0, (element.contentWindow?.innerHeight ?? height) - doc.documentElement.clientHeight);
      if (scrollbar) element.style.height = `${height + scrollbar}px`;
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
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("pointerdown", onFocus, true);
    doc.addEventListener("focusin", onFocus, true);
    doc.addEventListener("load", schedule, true);
    doc.addEventListener("error", schedule, true);
    void doc.fonts.ready.then(schedule);
    measure();
    cleanup.current = () => {
      disposed = true;
      cancelAnimationFrame(pending);
      bodySize.disconnect();
      frameSize.disconnect();
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("pointerdown", onFocus, true);
      doc.removeEventListener("focusin", onFocus, true);
      doc.removeEventListener("load", schedule, true);
      doc.removeEventListener("error", schedule, true);
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
