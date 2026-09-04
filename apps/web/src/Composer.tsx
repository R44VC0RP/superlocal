import { readText, removeSaved, writeText } from "./storage";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import { Icon, IconButton, Key, Modal } from "./components";
import {
  type Attachment,
  type Draft,
  type Preferences,
  type SendOptions,
  type MailboxOption,
} from "./data";
import "./message.css";
import { escapeHTML, plainText } from "./mail-text";
import { loadSnippets } from "./Snippets";
import {
  canUseQuickReplies,
  quickReplyBody,
  type QuickReply,
} from "./quick-replies";

type ComposerProps = {
  draft: Draft;
  preferences: Preferences;
  accounts: MailboxOption[];
  contacts?: Array<{ name: string; email: string }>;
  onChange: (draft: Draft) => void;
  onSend: (draft: Draft, when?: string, options?: SendOptions) => Promise<boolean>;
  onDiscard: () => Promise<boolean>;
  onReload?: () => void;
  onClose: () => void;
  inline?: boolean;
  onPopOut?: () => void;
  onSearch?: () => void;
  onToggleFocus?: () => void;
  focusRequest?: number;
  snippetRequest?: number;
  availabilityRequest?: number;
  onNavigate?: (delta: number) => void;
  quickReplies?: QuickReply[];
  autoFocus?: boolean;
  onFocusChange?: (focused: boolean) => void;
};

const addresses = (value: string) =>
  value
    .split(/[,;\n]+/)
    .map((value) => value.trim())
    .filter(Boolean);
const emailAddress = (value: string) =>
  value.match(/<([^>]+)>/)?.[1] || value.trim();
const validAddress = (value: string) =>
  /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(emailAddress(value));

function RecipientField({
  label,
  value,
  onChange,
  onExpand,
  contacts,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onExpand: () => void;
  contacts: Array<{ name: string; email: string }>;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const all = addresses(value);
  const chips = query.trim()
    ? all.slice(0, Math.max(0, all.length - addresses(query).length))
    : all;
  const results = contacts
    .filter(
      (contact) =>
        `${contact.name} ${contact.email}`
          .toLowerCase()
          .includes(query.toLowerCase().trim()) &&
        !chips.some(
          (chip) => emailAddress(chip).toLowerCase() === contact.email,
        ),
    )
    .slice(0, 5);
  const showResults = focused && !!query.trim() && results.length > 0;

  function commit(recipient = query) {
    onChange([...new Set([...chips, ...addresses(recipient)])].join(", "));
    setQuery("");
    setActive(0);
  }

  return (
    <div className="compose-recipient-row">
      <button
        type="button"
        className="compose-recipient-label"
        onClick={() => {
          onExpand();
          input.current?.focus();
        }}
      >
        {label}
      </button>
      <div
        className="compose-recipients"
        onClick={(event) => {
          if (event.target === event.currentTarget) input.current?.focus();
        }}
      >
        {chips.map((recipient, index) => (
          <span
            className={`compose-chip ${validAddress(recipient) ? "" : "is-invalid"}`}
            title={recipient}
            key={`${recipient}-${index}`}
          >
            <span>
              {contacts.find(
                (contact) => contact.email === emailAddress(recipient),
              )?.name || recipient.replace(/\s*<[^>]*>/, "")}
            </span>
            <button
              type="button"
              aria-label={`Remove ${recipient}`}
              onClick={() =>
                onChange(
                  [...chips.filter((_, i) => i !== index), query]
                    .filter(Boolean)
                    .join(", "),
                )
              }
            >
              <Icon name="Close" size={10} />
            </button>
          </span>
        ))}
        <div className="compose-recipient-input-wrap">
          <input
            ref={input}
            id={id}
            aria-label={label}
            role="combobox"
            aria-expanded={showResults}
            aria-controls={`${id}-contacts`}
            aria-autocomplete="list"
            aria-activedescendant={
              showResults ? `${id}-contact-${active}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
            value={query}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              if (query.trim()) commit();
            }}
            onChange={(event) => {
              const next = event.target.value;
              setActive(0);
              if (/[,;\n]$/.test(next)) {
                commit(next);
                return;
              }
              setQuery(next);
              onChange([...chips, next].filter(Boolean).join(", "));
            }}
            onKeyDown={(event) => {
              if (
                event.defaultPrevented ||
                event.nativeEvent.isComposing ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey
              )
                return;
              if (
                showResults &&
                (event.key === "ArrowDown" || event.key === "ArrowUp")
              ) {
                event.preventDefault();
                setActive(
                  (active +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    results.length) %
                    results.length,
                );
              } else if (
                event.key === "Enter" ||
                (event.key === "Tab" && query.trim())
              ) {
                if (event.key === "Enter") event.preventDefault();
                commit(
                  showResults
                    ? results[Math.min(active, results.length - 1)].email
                    : query,
                );
              } else if (event.key === "Backspace" && !query && chips.length) {
                event.preventDefault();
                const last = chips.at(-1)!;
                setQuery(last);
              } else if (event.key === "Escape" && showResults) {
                event.preventDefault();
                event.stopPropagation();
                setFocused(false);
              }
            }}
          />
          {showResults && (
            <div
              className="compose-contacts message-menu"
              id={`${id}-contacts`}
              role="listbox"
            >
              {results.map((contact, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  id={`${id}-contact-${index}`}
                  key={contact.email}
                  className={index === active ? "is-active" : ""}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    commit(contact.email);
                    input.current?.focus();
                  }}
                >
                  <span className="compose-contact-avatar">
                    <Icon name="User" size={18} />
                  </span>
                  <span>
                    <strong>{contact.name}</strong>
                    <small>{contact.email}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Composer({
  draft,
  preferences,
  accounts,
  contacts = [],
  onChange,
  onSend,
  onDiscard,
  onReload,
  onClose,
  inline = false,
  onPopOut,
  onSearch,
  onToggleFocus,
  focusRequest = 0,
  snippetRequest,
  availabilityRequest,
  onNavigate,
  quickReplies = [],
  autoFocus = true,
  onFocusChange,
}: ComposerProps) {
  const editor = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const colorInput = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const current = useRef(draft);
  const initialized = useRef("");
  const mounted = useRef(true);
  const selection = useRef<Range | null>(null);
  const emojiTrigger = useRef<Range | null>(null);
  const pendingFiles = useRef(0);
  const [expanded, setExpanded] = useState(!!(draft.cc || draft.bcc));
  const [formatting, setFormatting] = useState(false);
  const [menu, setMenu] = useState<
    "schedule" | "remind" | "snippets" | "availability" | "emoji" | null
  >(null);
  const [dialog, setDialog] = useState<"link" | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [reminder, setReminder] = useState(() => {
    try {
      return (
        readText(`draft-reminder:${draft.id}`) || ""
      );
    } catch {
      return "";
    }
  });
  const [schedule, setSchedule] = useState("");
  const [link, setLink] = useState("");
  const [linkText, setLinkText] = useState("");
  const [snippetSearch, setSnippetSearch] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const [color, setColor] = useState("#000000");
  const [previewReply, setPreviewReply] = useState<QuickReply | null>(null);
  const showQuickReplies =
    inline &&
    !draft.popOut &&
    quickReplies.length > 0 &&
    canUseQuickReplies(draft);
  const floating = !inline && !!draft.popOut;
  const closeDialog = useCallback(() => setDialog(null), []);
  current.current = draft;
  const signatures = preferences.signaturesByAccount as
    Record<string, string> | undefined;
  const signature = signatures?.[draft.account] ?? preferences.signature;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function update(patch: Partial<Draft>) {
    if (patch.body !== undefined) setPreviewReply(null);
    const next = { ...current.current, ...patch, updated: Date.now() };
    current.current = next;
    onChange(next);
    setError("");
    return next;
  }
  function insertQuickReply(reply: QuickReply) {
    const body = quickReplyBody(
      {
        ...current.current,
        body: editor.current?.innerHTML ?? current.current.body,
      },
      reply,
    );
    if (body === null || !editor.current) return;
    editor.current.innerHTML = body;
    const range = document.createRange();
    range.selectNodeContents(editor.current);
    range.collapse(false);
    selection.current = range;
    const selected = window.getSelection();
    selected?.removeAllRanges();
    selected?.addRange(range);
    update({ body: editor.current.innerHTML });
    focusComposer();
  }

  function focusComposer() {
    const target =
      !current.current.to && (!inline || current.current.mode === "forward")
        ? card.current?.querySelector<HTMLInputElement>('[aria-label="To"]')
        : editor.current;
    if (!target) return;
    if (target === editor.current) rememberSelection();
    target.focus({ preventScroll: true });
    if (
      target === editor.current &&
      selection.current &&
      target.contains(selection.current.commonAncestorContainer)
    ) {
      const selected = window.getSelection();
      selected?.removeAllRanges();
      selected?.addRange(selection.current);
    }
    target.scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  useLayoutEffect(() => {
    if (!editor.current) return;
    let body = draft.body;
    const opened = initialized.current !== draft.id;
    if (opened) {
      initialized.current = draft.id;
      selection.current = null;
      setExpanded(!!(draft.cc || draft.bcc));
      setError("");
      setStatus("");
      setMenu(null);
      try {
        setReminder(
          readText(`draft-reminder:${draft.id}`) || "",
        );
      } catch {
        setReminder("");
      }
      if (
        !body &&
        preferences.signatureEnabled &&
        signature &&
        (draft.mode === "new" || preferences.signatureReplies !== false)
      ) {
        body = `<div><br></div><div><br></div><div>${escapeHTML(signature).replaceAll("\n", "<br>")}</div>`;
        update({ body });
      }
    }
    // Do not replace the editable DOM on each keystroke: that would reset its caret.
    if (editor.current.innerHTML !== body) editor.current.innerHTML = body;
    if (opened && autoFocus) focusComposer();
  }, [draft.id, draft.body]);

  useLayoutEffect(() => {
    if (focusRequest > 0) focusComposer();
  }, [focusRequest]);

  useEffect(() => {
    if (!snippetRequest) return;
    rememberSelection();
    setMenu("snippets");
  }, [snippetRequest]);

  useEffect(() => {
    if (!availabilityRequest) return;
    rememberSelection();
    setMenu("availability");
  }, [availabilityRequest]);

  useEffect(() => {
    if (menu !== "emoji") emojiTrigger.current = null;
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as Element).closest(".compose-menu-anchor"))
        setMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => {
      document.removeEventListener("mousedown", close);
    };
  }, [menu]);

  function rememberSelection() {
    const selected = window.getSelection();
    if (
      selected?.rangeCount &&
      editor.current?.contains(selected.anchorNode) &&
      editor.current.contains(selected.focusNode)
    )
      selection.current = selected.getRangeAt(0).cloneRange();
  }

  function format(command: string, value?: string) {
    editor.current?.focus();
    const selected = window.getSelection();
    if (
      selection.current &&
      editor.current?.contains(selection.current.commonAncestorContainer)
    ) {
      selected?.removeAllRanges();
      selected?.addRange(selection.current);
    }
    document.execCommand(command, false, value);
    rememberSelection();
    update({ body: editor.current?.innerHTML || "" });
  }

  function paste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    rememberSelection();
    format("insertText", event.clipboardData.getData("text/plain"));
  }

  async function submit(when?: string, options?: SendOptions) {
    if (submitting.current) return;
    if (options?.instant) when = undefined;
    const next = {
      ...current.current,
      body: editor.current?.innerHTML ?? current.current.body,
      updated: Date.now(),
    };
    const recipients = [
      ...addresses(next.to),
      ...addresses(next.cc),
      ...addresses(next.bcc),
    ];
    if (!recipients.length) {
      setError("Add at least one recipient.");
      card.current
        ?.querySelector<HTMLInputElement>('[aria-label="To"]')
        ?.focus();
      return;
    }
    const invalid = recipients.find((recipient) => !validAddress(recipient));
    if (invalid) {
      setError(`Check the email address: ${invalid}`);
      setExpanded(true);
      return;
    }
    if (!plainText(next.body).trim() && !next.attachments.length) {
      setError("Write a message or attach a file before sending.");
      editor.current?.focus();
      return;
    }
    if (pendingFiles.current) {
      setError("Wait for your attachments to finish loading.");
      return;
    }
    if (
      when &&
      (!Number.isFinite(Date.parse(when)) || Date.parse(when) <= Date.now())
    ) {
      setError("Choose a date and time in the future.");
      return;
    }
    onChange(next);
    submitting.current = true;
    setSending(true);
    try {
      if (await onSend(next, when ? new Date(when).toISOString() : undefined, options)) setMenu(null);
    } catch (error) { setError(error instanceof Error ? error.message : "The send could not be queued. Your draft has been kept."); }
    finally { submitting.current = false; if (mounted.current) setSending(false); }
  }

  function popOut() {
    if (onPopOut) onPopOut();
    else if (!inline) update({ popOut: !current.current.popOut });
  }

  function insertLink() {
    rememberSelection();
    setMenu(null);
    setError("");
    setLink("");
    setLinkText(window.getSelection()?.toString() || "");
    setDialog("link");
  }

  async function attach(files: File[]) {
    if (!files.length) return;
    const draftId = current.current.id;
    pendingFiles.current += 1;
    setAttaching(true);
    try {
      const attachments = await Promise.all(
        files.map(
          (file) =>
            new Promise<Attachment>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve({
                  name: file.name,
                  type: file.type || "application/octet-stream",
                  size: file.size,
                  data: String(reader.result),
                });
              reader.onerror = () =>
                reject(new Error(`Could not read ${file.name}.`));
              reader.readAsDataURL(file);
            }),
        ),
      );
      if (mounted.current && current.current.id === draftId)
        update({
          attachments: [...current.current.attachments, ...attachments],
        });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not attach this file.",
      );
    } finally {
      pendingFiles.current -= 1;
      setAttaching(pendingFiles.current > 0);
    }
  }

  function chooseReminder(value: string) {
    setReminder(value);
    setMenu(null);
    update({});
    if (!(value ? writeText(`draft-reminder:${draft.id}`, value) : removeSaved(`draft-reminder:${draft.id}`))) {
      setError("Your browser could not save the reminder.");
    }
  }

  function quickDate(days: number, hour: number) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    date.setHours(hour, 0, 0, 0);
    if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
    return date.toISOString();
  }

  const snippets = [
    ...(menu === "snippets" ? loadSnippets() : []).map((snippet) => ({
      name: snippet.title,
      body: /<\/?[a-z][\s\S]*>/i.test(snippet.body)
        ? snippet.body
        : `<p>${escapeHTML(snippet.body).replaceAll("\n", "<br>")}</p>`,
    })),
    ...(signature ? [{
      name: "Signature",
      body: `<p>${escapeHTML(signature).replaceAll("\n", "<br>")}</p>`,
    }] : []),
  ];

  return (
    <section
      className={`compose-view ${inline ? "compose-inline" : "message-view"} ${floating ? "compose-floating" : ""}`}
      aria-label={inline ? "Reply composer" : "New message"}
      tabIndex={-1}
      onFocusCapture={() => onFocusChange?.(true)}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setPreviewReply(null);
          onFocusChange?.(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || dialog)
          return;

        const command = event.metaKey || event.ctrlKey;
        const inEditor = !!editor.current?.contains(event.target as Node);
        const matches = (key: string, code: string) =>
          event.key.toLowerCase() === key || event.code === code;
        let action: (() => void) | undefined;

        if (event.key === "Escape") {
          action = menu
            ? () => {
                setMenu(null);
                editor.current?.focus();
                if (
                  selection.current &&
                  editor.current?.contains(
                    selection.current.commonAncestorContainer,
                  )
                ) {
                  const selected = window.getSelection();
                  selected?.removeAllRanges();
                  selected?.addRange(selection.current);
                }
              }
            : onClose;
        } else if (command && !event.altKey) {
          if (event.key === "Enter") {
            action = () =>
              submit(
                undefined,
                event.shiftKey ? { markDone: true } : undefined,
              );
          } else if (event.shiftKey) {
            const field = matches("o", "KeyO")
              ? "To"
              : matches("c", "KeyC")
                ? "Cc"
                : matches("b", "KeyB")
                  ? "Bcc"
                  : matches("f", "KeyF")
                    ? "From account"
                    : matches("s", "KeyS")
                      ? "Subject"
                      : null;
            if (field) {
              action = () => {
                setExpanded(true);
                requestAnimationFrame(() =>
                  card.current
                    ?.querySelector<HTMLElement>(`[aria-label="${field}"]`)
                    ?.focus(),
                );
              };
            } else if (matches("u", "KeyU") && fileInput.current) {
              action = () => fileInput.current?.click();
            } else if (matches(",", "Comma")) {
              action = onDiscard;
            } else if (matches("i", "KeyI")) {
              action = () => {
                // Commit any recipient being edited before moving the addresses.
                editor.current?.focus();
                const recipients = [
                  ...addresses(current.current.bcc),
                  ...addresses(current.current.to),
                ];
                const seen = new Set<string>();
                const bcc = recipients
                  .filter((recipient) => {
                    const email = emailAddress(recipient).toLowerCase();
                    if (seen.has(email)) return false;
                    seen.add(email);
                    return true;
                  })
                  .join(", ");
                setExpanded(true);
                update({ to: "", bcc });
              };
            } else if (matches("h", "KeyH")) {
              action = () => setMenu(menu === "remind" ? null : "remind");
            } else if (matches("l", "KeyL")) {
              action = () => setMenu(menu === "schedule" ? null : "schedule");
            } else if (matches("z", "KeyZ")) {
              action = () => submit(undefined, { instant: true });
            } else if (matches("p", "KeyP") && (!inline || onPopOut)) {
              action = popOut;
            } else if (inEditor) {
              if (matches("x", "KeyX")) action = () => format("strikeThrough");
              else if (matches("7", "Digit7"))
                action = () => format("insertOrderedList");
              else if (matches("8", "Digit8"))
                action = () => format("insertUnorderedList");
              else if (matches("9", "Digit9"))
                action = () =>
                  format(
                    "formatBlock",
                    document.queryCommandValue("formatBlock") === "blockquote"
                      ? "div"
                      : "blockquote",
                  );
            }
          } else if (matches(";", "Semicolon")) {
            action = () => setMenu(menu === "snippets" ? null : "snippets");
          } else if (
            matches("/", "Slash") &&
            onSearch &&
            (!inline || onPopOut)
          ) {
            action = () => {
              if (!current.current.popOut) popOut();
              onSearch();
            };
          } else if (matches("d", "KeyD") && onToggleFocus) {
            action = onToggleFocus;
          } else if (inEditor) {
            if (matches("b", "KeyB")) action = () => format("bold");
            else if (matches("i", "KeyI")) action = () => format("italic");
            else if (matches("u", "KeyU")) action = () => format("underline");
            else if (matches("k", "KeyK")) action = insertLink;
            else if (matches("o", "KeyO") && colorInput.current)
              action = () => colorInput.current?.click();
          }
          if (!action && inEditor && !event.shiftKey) {
            if (matches("]", "BracketRight")) action = () => format("indent");
            else if (matches("[", "BracketLeft"))
              action = () => format("outdent");
          }
        } else if (inEditor && !event.altKey) {
          if (event.key === ";" && !event.shiftKey) {
            action = () => setMenu(menu === "snippets" ? null : "snippets");
          } else if (event.key === ":") {
            const selected = window.getSelection();
            if (
              selected?.rangeCount &&
              selected.isCollapsed &&
              editor.current?.contains(selected.anchorNode)
            ) {
              const range = selected.getRangeAt(0);
              const node = range.startContainer;
              const block = (
                node instanceof Element ? node : node.parentElement
              )?.closest("p,div,li,blockquote,pre");
              const before = range.cloneRange();
              before.selectNodeContents(
                block && editor.current?.contains(block)
                  ? block
                  : editor.current!,
              );
              before.setEnd(range.startContainer, range.startOffset);
              if (/(?:^|[\s([{])$/.test(before.toString())) {
                action = () => {
                  // Keep the trigger as ordinary text if the picker is canceled.
                  format("insertText", ":");
                  const trigger = selection.current?.cloneRange();
                  if (
                    !trigger ||
                    trigger.startContainer.nodeType !== Node.TEXT_NODE ||
                    !trigger.startOffset
                  )
                    return;
                  trigger.setStart(
                    trigger.startContainer,
                    trigger.startOffset - 1,
                  );
                  emojiTrigger.current = trigger;
                  setMenu("emoji");
                };
              }
            }
          } else if (event.key === "Tab") {
            const selected = window.getSelection();
            const anchor = selected?.anchorNode;
            const item = (
              anchor instanceof Element ? anchor : anchor?.parentElement
            )?.closest("li");
            if (item && editor.current?.contains(item)) {
              action = () => format(event.shiftKey ? "outdent" : "indent");
            }
          }
        }
        if (action) {
          event.preventDefault();
          event.stopPropagation();
          rememberSelection();
          action();
        }
      }}
    >
      {!inline && (
        <header className="message-view-header">
          <IconButton
            name="Back"
            title="Back (save draft)"
            className="message-back"
            onClick={onClose}
          />
          <div className="message-column message-heading-row">
            <h1>New Message</h1>
            <div className="message-navigation">
              {floating ? (
                <IconButton
                  name="Close"
                  title="Return to full draft"
                  onClick={popOut}
                />
              ) : (
                <>
                  <IconButton
                    name="ChevronUp"
                    title="Previous thread"
                    disabled={!onNavigate}
                    onClick={() => onNavigate?.(-1)}
                  />
                  <IconButton
                    name="ChevronDown"
                    title="Next thread"
                    disabled={!onNavigate}
                    onClick={() => onNavigate?.(1)}
                  />
                </>
              )}
            </div>
          </div>
        </header>
      )}
      <div className={inline ? "" : "message-view-scroll"}>
        {showQuickReplies && (
          <div
            className="compose-quick-replies"
            role="group"
            aria-label="Quick responses"
            onMouseLeave={() => setPreviewReply(null)}
          >
            <div className="compose-quick-reply-options">
              {quickReplies.map((reply) => (
                <button
                  type="button"
                  key={reply.label}
                  aria-description={reply.body}
                  onMouseEnter={() => setPreviewReply(reply)}
                  onFocus={() => setPreviewReply(reply)}
                  onBlur={() => setPreviewReply(null)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertQuickReply(reply)}
                >
                  {reply.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div
          ref={card}
          className={`compose-card ${inline ? "" : "message-column"}`}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files"))
              event.preventDefault();
          }}
          onDrop={(event) => {
            if (event.dataTransfer.files.length) {
              event.preventDefault();
              void attach([...event.dataTransfer.files]);
            }
          }}
        >
          <div className="compose-field-actions">
            <IconButton
              name={expanded ? "ChevronUp" : "ChevronDown"}
              title={expanded ? "Collapse recipients" : "Expand recipients"}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            />
            <IconButton
              name="PopOut"
              title={
                draft.popOut
                  ? "Return to draft (Command Shift P)"
                  : "Pop out draft (Command Shift P)"
              }
              disabled={inline && !onPopOut}
              onClick={popOut}
            />
          </div>
          {inline && draft.mode !== "forward" && !expanded ? (
            <button
              type="button"
              className="compose-collapsed-recipients"
              onClick={() => setExpanded(true)}
            >
              <span>Draft</span> to {draft.to || "..."}
            </button>
          ) : (
            <div className="compose-address-fields">
              <RecipientField
                key={`${draft.id}-to`}
                contacts={contacts}
                label="To"
                value={draft.to}
                onChange={(to) => update({ to })}
                onExpand={() => setExpanded(true)}
              />
              {expanded && (
                <>
                  <RecipientField
                    key={`${draft.id}-cc`}
                    contacts={contacts}
                    label="Cc"
                    value={draft.cc}
                    onChange={(cc) => update({ cc })}
                    onExpand={() => setExpanded(true)}
                  />
                  <RecipientField
                    key={`${draft.id}-bcc`}
                    contacts={contacts}
                    label="Bcc"
                    value={draft.bcc}
                    onChange={(bcc) => update({ bcc })}
                    onExpand={() => setExpanded(true)}
                  />
                  <label className="compose-recipient-row compose-from">
                    <span>From</span>
                    <select
                      aria-label="From account"
                      value={draft.account}
                      onChange={(event) =>
                        update({ account: event.target.value })
                      }
                    >
                      {accounts.filter(account => account.canSend || account.id === draft.account).map(
                        (account) => (
                          <option key={account.id} value={account.id}>{account.email || account.name}</option>
                        ),
                      )}
                    </select>
                    <Icon name="ChevronDown" size={12} />
                  </label>
                </>
              )}
            </div>
          )}
          {(!inline || expanded) && (
            <input
              className="compose-subject"
              aria-label="Subject"
              placeholder="Subject"
              value={draft.subject}
              onChange={(event) => update({ subject: event.target.value })}
            />
          )}
          <div
            ref={editor}
            className="compose-editor message-body"
            data-quick-reply-preview={
              showQuickReplies ? previewReply?.body : undefined
            }
            style={{
              fontFamily:
                preferences.font === "Super Sans"
                  ? undefined
                  : preferences.font,
              fontSize: (
                { Small: 12, Large: 18, Huge: 24 } as Record<string, number>
              )[preferences.fontSize],
            }}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-label="Message body"
            aria-multiline="true"
            spellCheck={preferences.spellcheck}
            onInput={() => update({ body: editor.current?.innerHTML || "" })}
            onPaste={paste}
            onDrop={(event) => {
              if (!event.dataTransfer.files.length) {
                event.preventDefault();
                rememberSelection();
                format("insertText", event.dataTransfer.getData("text/plain"));
              }
            }}
            onMouseUp={rememberSelection}
            onKeyUp={rememberSelection}
            onBlur={rememberSelection}
          />
          {!!draft.attachments.length && (
            <div className="message-attachments compose-attachments">
              {draft.attachments.map((file, index) => (
                <div
                  className="message-attachment"
                  key={`${file.name}-${index}`}
                >
                  <Icon name="Paperclip" />
                  <span title={file.name}>{file.name}</span>
                  <small>
                    {file.size < 1024 * 1024
                      ? `${Math.max(1, Math.round(file.size / 1024))} KB`
                      : `${(file.size / 1024 / 1024).toFixed(1)} MB`}
                  </small>
                  <IconButton
                    name="Close"
                    title={`Remove ${file.name}`}
                    size={12}
                    onClick={() =>
                      update({
                        attachments: current.current.attachments.filter(
                          (_, i) => i !== index,
                        ),
                      })
                    }
                  />
                </div>
              ))}
            </div>
          )}
          {attaching && (
            <div className="compose-status" role="status">
              Attaching files...
            </div>
          )}
          {formatting && (
            <div
              className="compose-formatting"
              role="toolbar"
              aria-label="Text formatting"
              onMouseDown={(event) => event.preventDefault()}
            >
              <button
                type="button"
                title="Bold (Command B)"
                aria-label="Bold"
                onClick={() => format("bold")}
              >
                <b>B</b>
              </button>
              <button
                type="button"
                title="Italic (Command I)"
                aria-label="Italic"
                onClick={() => format("italic")}
              >
                <i>I</i>
              </button>
              <button
                type="button"
                title="Underline (Command U)"
                aria-label="Underline"
                onClick={() => format("underline")}
              >
                <u>U</u>
              </button>
              <button
                type="button"
                title="Strikethrough (Command Shift X)"
                aria-label="Strikethrough"
                onClick={() => format("strikeThrough")}
              >
                <s>S</s>
              </button>
              <span className="compose-format-divider" />
              <IconButton
                name="Link"
                title="Insert link (Command K)"
                onClick={insertLink}
              />
              <button
                type="button"
                title="Text color (Command O)"
                onClick={() => {
                  rememberSelection();
                  colorInput.current?.click();
                }}
              >
                Color
              </button>
              <button
                type="button"
                title="Bulleted list (Command Shift 8)"
                aria-label="Bulleted list"
                onClick={() => format("insertUnorderedList")}
              >
                &bull; <span>List</span>
              </button>
              <button
                type="button"
                title="Numbered list (Command Shift 7)"
                aria-label="Numbered list"
                onClick={() => format("insertOrderedList")}
              >
                1. <span>List</span>
              </button>
              <button
                type="button"
                title="Quote (Command Shift 9)"
                onClick={() =>
                  format(
                    "formatBlock",
                    document.queryCommandValue("formatBlock") === "blockquote"
                      ? "div"
                      : "blockquote",
                  )
                }
              >
                Quote
              </button>
              <button
                type="button"
                title="Code block"
                onClick={() =>
                  format(
                    "formatBlock",
                    document.queryCommandValue("formatBlock") === "pre"
                      ? "div"
                      : "pre",
                  )
                }
              >
                {"</>"}
              </button>
              <button
                type="button"
                title="Remove formatting"
                onClick={() => format("removeFormat")}
              >
                Clear
              </button>
            </div>
          )}
          {(error || draft.saveError) && (
            <div className="compose-error" role="alert">
              {error || draft.saveError}
              {draft.saveError && onReload && <button type="button" onClick={onReload}>Reload saved draft</button>}
            </div>
          )}
          {status && (
            <div className="compose-status" role="status">
              {status}
            </div>
          )}
          <footer className="compose-footer">
            <div className="compose-status" role="status">
              {draft.saveError ? "Draft not saved" : draft.saving ? "Saving draft…" : draft.dirty ? "Unsaved recipient changes" : "Draft saved"}
            </div>
            <div className="compose-send-actions">
              <button
                type="button"
                className="compose-send"
                title="Send (Command Enter)"
                disabled={sending || attaching || !accounts.some(account => account.id === draft.account && account.canSend)}
                onClick={() => submit()}
              >
                {sending ? "Queuing…" : "Send"}
              </button>
              <div className="compose-menu-anchor">
                <button
                  type="button"
                  aria-expanded={menu === "schedule"}
                  title="Send later (Command Shift L)"
                  onClick={() =>
                    setMenu(menu === "schedule" ? null : "schedule")
                  }
                >
                  Send later
                </button>
                {menu === "schedule" && (
                  <div
                    className="message-menu compose-schedule-menu"
                    role="dialog"
                    aria-label="Send later"
                  >
                    <h3>Send later</h3>
                    <button
                      type="button"
                      onClick={() => submit(quickDate(1, 9))}
                    >
                      <span>Tomorrow morning</span>
                      <small>9:00 AM</small>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        submit(quickDate((8 - new Date().getDay()) % 7 || 7, 9))
                      }
                    >
                      <span>Next Monday</span>
                      <small>9:00 AM</small>
                    </button>
                    <div className="compose-menu-custom">
                      <label htmlFor={`send-date-${draft.id}`}>
                        Pick a date and time
                      </label>
                      <input
                        id={`send-date-${draft.id}`}
                        aria-label="Send date and time"
                        type="datetime-local"
                        value={schedule}
                        onChange={(event) => setSchedule(event.target.value)}
                      />
                      <button
                        type="button"
                        className="message-primary"
                        disabled={!schedule}
                        onClick={() => submit(schedule)}
                      >
                        Schedule send
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="compose-menu-anchor">
                <button
                  type="button"
                  className={reminder ? "is-selected" : ""}
                  title={reminder || "Remind me (Command Shift H)"}
                  aria-expanded={menu === "remind"}
                  onClick={() => setMenu(menu === "remind" ? null : "remind")}
                >
                  Remind me
                </button>
                {menu === "remind" && (
                  <div
                    className="message-menu compose-reminder-menu"
                    role="dialog"
                    aria-label="Remind me"
                  >
                    <h3>Remind me if no reply</h3>
                    {["Tomorrow", "In 2 days", "In 3 days", "In 1 week"].map(
                      (value) => (
                        <button
                          type="button"
                          key={value}
                          onClick={() => chooseReminder(value)}
                        >
                          <span>{value}</span>
                          {reminder === value && <Icon name="Check" />}
                        </button>
                      ),
                    )}
                    <button type="button" onClick={() => chooseReminder("")}>
                      No reminder
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="compose-tools">
              <IconButton
                name="Format"
                title="Formatting options"
                aria-expanded={formatting}
                className={formatting ? "is-selected" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  rememberSelection();
                  setFormatting(!formatting);
                }}
              />
              <div className="compose-menu-anchor">
                <IconButton
                  name="Calendar"
                  title="Share availability"
                  aria-expanded={menu === "availability"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    rememberSelection();
                    setMenu(menu === "availability" ? null : "availability");
                  }}
                />
                {menu === "availability" && (
                  <div
                    className="message-menu compose-tool-menu"
                    role="dialog"
                    aria-label="Share availability"
                  >
                    <h3>Share availability</h3>
                    <div className="compose-menu-custom">
                      <label htmlFor={`availability-${draft.id}`}>
                        Available date and time
                      </label>
                      <input
                        id={`availability-${draft.id}`}
                        type="datetime-local"
                        value={schedule}
                        onChange={(event) => setSchedule(event.target.value)}
                      />
                      <button
                        type="button"
                        className="message-primary"
                        disabled={!schedule}
                        onClick={() => {
                          const date = new Date(schedule);
                          if (!Number.isFinite(date.getTime())) return;
                          format(
                            "insertText",
                            `I'm available ${date.toLocaleString([], { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}. Does that work for you?`,
                          );
                          setMenu(null);
                        }}
                      >
                        Insert availability
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="compose-menu-anchor">
                <IconButton
                  name="Snippet"
                  title="Insert snippet (Command ;)"
                  aria-expanded={menu === "snippets"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    rememberSelection();
                    setMenu(menu === "snippets" ? null : "snippets");
                  }}
                />
                {menu === "snippets" && (
                  <div
                    className="message-menu compose-tool-menu"
                    role="dialog"
                    aria-label="Insert snippet"
                  >
                    <h3>Insert snippet</h3>
                    <input
                      className="compose-snippet-search"
                      aria-label="Search snippets"
                      placeholder="Search snippets"
                      autoFocus
                      value={snippetSearch}
                      onChange={(event) => setSnippetSearch(event.target.value)}
                    />
                    {snippets
                      .filter((snippet) =>
                        snippet.name
                          .toLowerCase()
                          .includes(snippetSearch.toLowerCase()),
                      )
                      .map((snippet) => (
                        <button
                          type="button"
                          key={snippet.name}
                          onClick={() => {
                            format("insertHTML", snippet.body);
                            setMenu(null);
                          }}
                        >
                          <span>{snippet.name}</span>
                          <Icon name="Snippet" />
                        </button>
                      ))}
                  </div>
                )}
              </div>
              <IconButton
                name="Paperclip"
                title="Attach file (Command Shift U)"
                onClick={() => fileInput.current?.click()}
              />
              <div className="compose-menu-anchor">
                <button
                  type="button"
                  className="icon-button"
                  title="Insert emoji (:)"
                  aria-label="Insert emoji"
                  aria-expanded={menu === "emoji"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    rememberSelection();
                    emojiTrigger.current = null;
                    setMenu(menu === "emoji" ? null : "emoji");
                  }}
                >
                  <span aria-hidden="true">{"\u263A"}</span>
                </button>
                {menu === "emoji" && (
                  <div
                    className="message-menu compose-tool-menu"
                    role="dialog"
                    aria-label="Insert emoji"
                  >
                    <h3>Insert emoji</h3>
                    {[
                      { value: "\u{1F600}", name: "Grinning face" },
                      { value: "\u{1F60A}", name: "Smiling face" },
                      { value: "\u{1F44D}", name: "Thumbs up" },
                      { value: "\u{1F44F}", name: "Clapping hands" },
                      { value: "\u{1F389}", name: "Party popper" },
                      { value: "\u{2764}\u{FE0F}", name: "Red heart" },
                      { value: "\u{1F64F}", name: "Folded hands" },
                      { value: "\u{2705}", name: "Check mark" },
                    ].map((emoji, index) => (
                      <button
                        type="button"
                        key={emoji.name}
                        aria-label={emoji.name}
                        autoFocus={index === 0}
                        onClick={() => {
                          if (
                            emojiTrigger.current?.toString() === ":" &&
                            editor.current?.contains(
                              emojiTrigger.current.commonAncestorContainer,
                            )
                          )
                            selection.current = emojiTrigger.current;
                          format("insertText", emoji.value);
                          emojiTrigger.current = null;
                          setMenu(null);
                        }}
                      >
                        <span>{emoji.name}</span>
                        <span aria-hidden="true">{emoji.value}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <IconButton
                name="Trash"
                title="Discard draft (Command Shift ,)"
                onClick={onDiscard}
              />
              <input
                ref={colorInput}
                className="compose-file-input"
                type="color"
                aria-label="Text color"
                value={color}
                onChange={(event) => {
                  setColor(event.target.value);
                  format("foreColor", event.target.value);
                }}
              />
              <input
                ref={fileInput}
                className="compose-file-input"
                type="file"
                multiple
                aria-label="Attach files"
                onChange={(event) => {
                  void attach([...(event.target.files || [])]);
                  event.target.value = "";
                }}
              />
            </div>
          </footer>
        </div>
      </div>
      {dialog === "link" && (
        <Modal
          label="Insert link"
          onClose={closeDialog}
          className="message-modal"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const url = /^(https?:|mailto:|tel:)/i.test(link.trim())
                ? link.trim()
                : `https://${link.trim()}`;
              if (
                !link.trim() ||
                !/^(https?:\/\/[^\s]+|mailto:[^\s@]+@[^\s]+|tel:[+\d\s()-]+)$/i.test(
                  url,
                )
              ) {
                setError("Enter a valid link.");
                return;
              }
              format(
                "insertHTML",
                `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(linkText || link.trim())}</a>`,
              );
              setDialog(null);
            }}
          >
            <h2>Insert link</h2>
            <label>
              Text
              <input
                aria-label="Link text"
                value={linkText}
                onChange={(event) => setLinkText(event.target.value)}
              />
            </label>
            <label>
              Link
              <input
                aria-label="Link URL"
                placeholder="https://"
                value={link}
                onChange={(event) => setLink(event.target.value)}
                required
              />
            </label>
            {error && (
              <p className="compose-error" role="alert">
                {error}
              </p>
            )}
            <div className="message-modal-actions">
              <button type="button" onClick={closeDialog}>
                Cancel <Key>Esc</Key>
              </button>
              <button type="submit" className="message-primary">
                Insert link
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
