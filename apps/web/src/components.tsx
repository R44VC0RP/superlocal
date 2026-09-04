import {
  useEffect,
  useEffectEvent,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import icons from "./icons.json";

// Keep SVG subtrees stable across renders, including between pointer down and up.
const iconMarkup: Record<string, { __html: string }> = Object.fromEntries(
  Object.entries(icons).map(([name, html]) => [name, { __html: html }]),
);

const paths: Record<string, ReactNode> = {
  Back: <path d="M16 10H4m5-5-5 5 5 5" />,
  Refresh: <path d="M17 8a7 7 0 1 0 0 4M17 3v5h-5" />,
  ChevronDown: <path d="m5 7 5 5 5-5" />,
  ChevronUp: <path d="m5 12 5-5 5 5" />,
  ChevronLeft: <path d="m12 5-5 5 5 5" />,
  ChevronRight: <path d="m7 5 5 5-5 5" />,
  Close: <path d="m5 5 10 10M15 5 5 15" />,
  Plus: <path d="M10 3v14M3 10h14" />,
  Minus: <path d="M4 10h12" />,
  Star: (
    <path d="m10 2 2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8Z" />
  ),
  Inbox: (
    <>
      <path d="M4 3h12l2 10v4H2v-4Z" />
      <path d="M2 12h5l1 2h4l1-2h5" />
    </>
  ),
  Send: <path d="m2 3 16 7-16 7 3-7Zm3 7h13" />,
  Trash: (
    <>
      <path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6m4-6v6" />
    </>
  ),
  Reply: <path d="m7 5-5 5 5 5M2 10h10q5 0 5 6" />,
  ReplyAll: (
    <>
      <path d="m10 5-5 5 5 5M5 10h8q5 0 5 6M5 5l-4 5 4 5" />
    </>
  ),
  Forward: <path d="m13 5 5 5-5 5m5-5H8q-5 0-5 6" />,
  More: (
    <>
      <circle cx="4" cy="10" r="1" />
      <circle cx="10" cy="10" r="1" />
      <circle cx="16" cy="10" r="1" />
    </>
  ),
  Label: <path d="M2 3h8l8 8-7 7-9-9Zm4 3h.01" />,
  Shield: (
    <>
      <path d="m10 2 7 3v5q0 5-7 8-7-3-7-8V5Z" />
      <path d="M10 6v5m0 3h.01" />
    </>
  ),
  Paperclip: (
    <path d="m8 12 6-6a2 2 0 0 1 3 3l-7 7a4 4 0 0 1-6-6l8-8a3 3 0 0 1 4 4l-8 8a1.4 1.4 0 0 1-2-2l7-7" />
  ),
  Link: (
    <>
      <path d="m8 7 3-3a4 4 0 0 1 6 6l-3 3M12 13l-3 3a4 4 0 0 1-6-6l3-3M7 13l6-6" />
    </>
  ),
  Eye: (
    <>
      <path d="M1 10s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6Z" />
      <circle cx="10" cy="10" r="2.5" />
    </>
  ),
  Snippet: (
    <>
      <path d="M7 3H5v5l-2 2 2 2v5h2M13 3h2v5l2 2-2 2v5h-2" />
    </>
  ),
  PopOut: (
    <>
      <path d="M11 2h7v7m0-7-9 9M8 3H3v14h14v-5" />
    </>
  ),
  Download: (
    <>
      <path d="M10 2v11m-4-4 4 4 4-4M3 13v4h14v-4" />
    </>
  ),
  Format: (
    <>
      <path d="M2 5h12M8 5v12M5 17h6M13 10h6m-3 0v7" />
    </>
  ),
  User: (
    <>
      <circle cx="10" cy="6" r="3" />
      <path d="M3 18v-2a7 7 0 0 1 14 0v2" />
    </>
  ),
  CheckSquare: (
    <>
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <path d="m6 10 3 3 6-6" />
    </>
  ),
  Keyboard: (
    <>
      <rect x="1" y="4" width="18" height="12" rx="2" />
      <path d="M4 7h1m2 0h1m2 0h1m2 0h1m2 0h1M4 10h1m2 0h1m2 0h1m2 0h1m2 0h1M5 13h10" />
    </>
  ),
};
export function Icon({
  name,
  size = 16,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const markup = iconMarkup[name];
  if (markup)
    return (
      <span
        aria-hidden="true"
        className={`icon ${className}`}
        style={{ width: size, height: size }}
        dangerouslySetInnerHTML={markup}
      />
    );
  return (
    <svg
      aria-hidden="true"
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] || paths.More}
    </svg>
  );
}
export function IconButton({
  name,
  title,
  size,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  name: string;
  title: string;
  size?: number;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      className={`icon-button ${className}`}
      {...props}
    >
      <Icon name={name} size={size} />
    </button>
  );
}
export function Key({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
export function Modal({
  children,
  onClose,
  label,
  className = "",
  initialFocus = "input",
}: {
  children: ReactNode;
  onClose: () => void;
  label: string;
  className?: string;
  /** "input" focuses the first text field (or first control); "dialog" focuses the dialog itself so no control shows a focus ring on open. */
  initialFocus?: "input" | "dialog";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,textarea,select,[tabindex="0"],[contenteditable="true"]',
        ) || []),
      ].filter((e) => e.offsetParent !== null);
    if (initialFocus === "dialog") {
      ref.current?.focus({ preventScroll: true });
    } else {
      const items = focusable();
      (
        items.find(
          (e) =>
            e.tagName === "INPUT" &&
            !["radio", "checkbox"].includes((e as HTMLInputElement).type),
        ) || items[0]
      )?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
      if (e.key === "Tab") {
        const items = focusable(),
          first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`modal ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
