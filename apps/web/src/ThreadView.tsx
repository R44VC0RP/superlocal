import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Composer from "./Composer";
import MessageBody from "./MessageBody";
import { Icon, IconButton } from "./components";
import {
  displayDate,
  type Draft,
  type Mail,
  type Preferences,
  type SendOptions,
  type MailboxOption,
} from "./data";
import "./message.css";
import "./thread-comments.css";
import { plainText } from "./mail-text";
import { readText } from "./storage";
import { getQuickReplies } from "./quick-replies";

type ThreadComment = {
  id: string;
  body: string;
  createdAt: string;
};

type ThreadViewProps = {
  mail: Mail;
  draft?: Draft;
  replyRequest?: number;
  focusOperationId?: string;
  preferences: Preferences;
  account: string;
  accounts: MailboxOption[];
  contacts: Array<{ name: string; email: string }>;
  onBack: () => void;
  onNavigate: (delta: number) => void;
  onAction: (action: string) => void;
  supportsAction: (action: string) => boolean;
  onCompose: (mode: "reply" | "replyAll" | "forward", popOut?: boolean, sourceMessageId?: string) => void;
  onDraftChange: (draft: Draft) => void;
  onSend: (draft: Draft, when?: string, options?: SendOptions) => Promise<boolean>;
  onDiscard: () => Promise<boolean>;
  onReloadDraft: () => void;
  onOpenProfile: () => void;
  onSearch?: () => void;
  onToggleFocus?: () => void;
  onImageSettings: () => void;
};

export default function ThreadView({
  mail,
  draft,
  replyRequest = 0,
  focusOperationId,
  preferences,
  account,
  accounts,
  contacts,
  onBack,
  onNavigate,
  onAction,
  supportsAction,
  onCompose,
  onDraftChange,
  onSend,
  onDiscard,
  onReloadDraft,
  onOpenProfile,
  onSearch,
  onToggleFocus,
  onImageSettings,
}: ThreadViewProps) {
  const [expanded, setExpanded] = useState<string[]>([
    mail.messages.at(-1)?.id || "",
  ]);
  const [details, setDetails] = useState<string[]>([]);
  const [response, setResponse] = useState("");
  const [replyFocused, setReplyFocused] = useState(false);
  const [pendingCommentDelete, setPendingCommentDelete] = useState<string | null>(null);
  // A saved draft stays visible on entry without taking focus from the message.
  const entryReplyRequest = useRef(replyRequest);
  const popOut = draft?.popOut === true;
  const [snippetRequest, setSnippetRequest] = useState(0);
  const [unsubscribed, setUnsubscribed] = useState(
    () => readText(`unsubscribed:${mail.email}`) === "true",
  );
  const scroller = useRef<HTMLDivElement>(null);
  const readerPane = useRef<HTMLElement>(null);
  const messageColumn = useRef<HTMLDivElement>(null);
  const backGutter = useRef<HTMLButtonElement>(null);
  const reply = useRef<HTMLDivElement>(null);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const activeMessage = useRef(mail.messages.at(-1)?.id || "");
  const scrollToMessage = useRef("");
  const scrollToComment = useRef(false);
  const revealedReply = useRef("");
  const replyResult = focusOperationId ? mail.messages.find(message => message.operationId === focusOperationId) : undefined;
  const replyFocusKey = replyResult ? `${mail.id}:${replyResult.id}` : "";
  const commentKey = `superlocal:comments:${encodeURIComponent(account)}:${encodeURIComponent(mail.id)}`;
  const [commentState, setCommentState] = useState({
    key: "",
    comments: [] as ThreadComment[],
    text: "",
  });
  const comments = commentState.key === commentKey ? commentState.comments : [];
  const commentText = commentState.key === commentKey ? commentState.text : "";
  const commentRows = Math.min(4, commentText.split("\n").length);
  const marketing = !mail.sourceId && ["Basecamp", "Mail Me Later"].includes(mail.from);
  const conversationLink = new URL(location.href);
  const linkParams = new URLSearchParams(location.hash.replace(/^#\/?/, ""));
  linkParams.set("account", account);
  linkParams.set("thread", mail.id);
  linkParams.delete("draft");
  linkParams.delete("view");
  conversationLink.hash = linkParams.toString();

  useLayoutEffect(() => {
    const pane = readerPane.current, column = messageColumn.current;
    if (!pane || !column) return;
    const heading = pane.querySelector<HTMLElement>(".message-heading-row");
    const measure = () => {
      const contentLeft = Math.min(column.getBoundingClientRect().left, heading?.getBoundingClientRect().left ?? Infinity);
      pane.style.setProperty("--back-gutter-width", `${Math.max(0, contentLeft - pane.getBoundingClientRect().left)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane); observer.observe(column);
    if (heading) observer.observe(heading);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const gutter = backGutter.current;
    if (!gutter) return;
    const scrollReader = (event: WheelEvent) => {
      const reader = scroller.current;
      if (!reader || event.ctrlKey || event.metaKey) return;
      const line = Number.parseFloat(getComputedStyle(reader).lineHeight) || 16;
      const x = event.deltaX * (event.deltaMode === 1 ? line : event.deltaMode === 2 ? reader.clientWidth : 1);
      const y = event.deltaY * (event.deltaMode === 1 ? line : event.deltaMode === 2 ? reader.clientHeight : 1);
      const top = reader.scrollTop, left = reader.scrollLeft;
      reader.scrollBy({ top: y, left: x, behavior: "auto" });
      if (reader.scrollTop !== top || reader.scrollLeft !== left) event.preventDefault();
    };
    gutter.addEventListener("wheel", scrollReader, { passive: false });
    return () => gutter.removeEventListener("wheel", scrollReader);
  }, []);

  useEffect(() => {
    let stored: ThreadComment[] = [];
    try {
      const parsed: unknown = JSON.parse(
        localStorage.getItem(commentKey) || "[]",
      );
      if (Array.isArray(parsed)) {
        stored = parsed.filter(
          (item): item is ThreadComment =>
            item !== null &&
            typeof item === "object" &&
            typeof item.id === "string" &&
            typeof item.body === "string" &&
            typeof item.createdAt === "string" &&
            Number.isFinite(Date.parse(item.createdAt)),
        );
      }
    } catch {
      /* Comments remain usable when local storage is unavailable. */
    }
    scrollToComment.current = false;
    setCommentState({ key: commentKey, comments: stored, text: "" });
  }, [commentKey]);

  useEffect(() => {
    if (scrollToComment.current) {
      scroller.current?.scrollTo(0, scroller.current.scrollHeight);
      scrollToComment.current = false;
    }
  }, [commentState.comments]);

  useLayoutEffect(() => {
    setExpanded([mail.messages.at(-1)?.id || ""]);
    revealedReply.current = "";
    setPendingCommentDelete(null);
    activeMessage.current = mail.messages.at(-1)?.id || "";
    scrollToMessage.current = "";
    setDetails([]);
    setSnippetRequest(0);
    try {
      setResponse(
        localStorage.getItem(`superlocal:invitation:${mail.id}`) || "",
      );
    } catch {
      setResponse("");
    }
    scroller.current?.scrollTo(0, 0);
  }, [mail.id]);

  useLayoutEffect(() => {
    if (!replyResult || revealedReply.current === replyFocusKey) return;
    revealedReply.current = replyFocusKey;
    setExpanded(previous => [...new Set([...previous.filter(id => mail.messages.some(message => message.id === id)), replyResult.id])]);
    activeMessage.current = replyResult.id;
    const node = scroller.current?.querySelector<HTMLElement>(`[data-thread-message="${CSS.escape(replyResult.id)}"]`);
    node?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [replyFocusKey]);

  useEffect(() => {
    if (draft && !popOut) reply.current?.scrollIntoView({ block: "nearest" });
  }, [draft?.id, popOut]);

  useEffect(() => {
    if (!scrollToMessage.current) return;
    const message = Array.from(
      scroller.current?.querySelectorAll<HTMLElement>(
        "[data-thread-message]",
      ) || [],
    ).find(
      (element) => element.dataset.threadMessage === scrollToMessage.current,
    );
    message?.scrollIntoView({ block: "start", behavior: "auto" });
    message?.focus({ preventScroll: true });
    scrollToMessage.current = "";
  }, [expanded]);

  function messageLinks(root: ParentNode): HTMLAnchorElement[] {
    const elements = root.querySelectorAll<HTMLAnchorElement | HTMLIFrameElement>(
      '.thread-body a[href]:not([aria-disabled="true"]), .message-html-frame, .thread-attachments a[href]:not([aria-disabled="true"])',
    );
    return Array.from(elements).flatMap(element => element.tagName === "IFRAME"
      ? Array.from((element as HTMLIFrameElement).contentDocument?.querySelectorAll<HTMLAnchorElement>('a[href]:not([aria-disabled="true"])') ?? [])
      : [element as HTMLAnchorElement]).filter(link => link.getClientRects().length > 0);
  }

  const shortcut = useEffectEvent((event: KeyboardEvent, bodyMessage?: HTMLElement) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      popOut ||
      !scroller.current?.isConnected ||
      document.querySelector('[role="dialog"], [aria-modal="true"]')
    )
      return;
    const target = event.target && (event.target as Node).nodeType === 1 ? event.target as HTMLElement : null;
    const command = event.metaKey && !event.ctrlKey && !event.altKey;
    const deleteComment =
      command && !event.shiftKey && ["Backspace", "Delete"].includes(event.key);
    if (
      target?.closest(
        '.compose-view, input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      ) &&
      !(deleteComment && target === commentInput.current)
    )
      return;

    const key = event.key.toLowerCase();
    const focusedMessage = bodyMessage ?? target?.closest<HTMLElement>(
      "[data-thread-message]",
    );
    const messageId =
      focusedMessage?.dataset.threadMessage || activeMessage.current;
    const messageIndex = mail.messages.findIndex(
      (message) => message.id === messageId,
    );
    if (deleteComment) {
      const commentId =
        target?.closest<HTMLElement>("[data-comment-id]")?.dataset.commentId;
      const comment =
        comments.find((item) => item.id === commentId) || comments.at(-1);
      if (!comment) return;
      if (!event.repeat) setPendingCommentDelete(comment.id);
    } else if (command && !event.shiftKey && key === ";") {
      setSnippetRequest((request) => request + 1);
      onCompose("reply");
    } else if (command && !event.shiftKey && key === "u" && marketing) {
      unsubscribe();
    } else if (command && !event.shiftKey && key === "o") {
      const links = messageLinks(scroller.current);
      const focusedLink = target?.closest<HTMLAnchorElement>("a[href]");
      if (focusedLink && links.includes(focusedLink)) focusedLink.click();
      else {
        const link =
          links.find(
            (item) =>
              (item.closest<HTMLElement>("[data-thread-message]") ?? item.ownerDocument.defaultView?.frameElement?.closest<HTMLElement>("[data-thread-message]"))?.dataset.threadMessage === messageId,
          ) || links[0];
        if (!link) return;
        link.focus();
      }
    } else if (
      command &&
      !event.shiftKey &&
      ["ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      scroller.current.scrollTo({
        top: event.key === "ArrowUp" ? 0 : scroller.current.scrollHeight,
        behavior: "auto",
      });
    } else if (
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      key === "/"
    ) {
      if (!navigator.clipboard?.writeText) return;
      void navigator.clipboard.writeText(conversationLink.href).catch(() => {});
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      if (!event.shiftKey && (key === "n" || key === "p")) {
        const message =
          mail.messages[
            Math.max(
              0,
              Math.min(
                mail.messages.length - 1,
                messageIndex + (key === "n" ? 1 : -1),
              ),
            )
          ];
        if (!message) return;
        revealMessage(message.id);
      } else if (key === "o") {
        if (event.shiftKey) toggleAllMessages();
        else if (messageId) revealMessage(messageId);
        else return;
      } else if (event.shiftKey && key === "h" && messageId) {
        setExpanded((all) =>
          all.includes(messageId) ? all : [...all, messageId],
        );
        setDetails((all) =>
          all.includes(messageId)
            ? all.filter((id) => id !== messageId)
            : [...all, messageId],
        );
      } else if (event.shiftKey && key === "n") {
        const last = mail.messages.at(-1);
        if (!last) return;
        activeMessage.current = last.id;
        scrollToMessage.current = last.id;
        // Messages have no unread flag; reveal existing content rather than infer it.
        setExpanded(mail.messages.map((message) => message.id));
      } else if (!event.shiftKey && key === "m" && commentInput.current) {
        commentInput.current.focus();
      } else if (key === " ") {
        if (target?.closest('button, a, [role="button"]')) return;
        scroller.current.scrollBy({
          top: scroller.current.clientHeight * 0.85 * (event.shiftKey ? -1 : 1),
          behavior: "auto",
        });
      } else if (key === "tab" && focusedMessage) {
        const links = messageLinks(focusedMessage);
        const index = links.indexOf(target as HTMLAnchorElement);
        const next =
          index >= 0 ? links[index + (event.shiftKey ? -1 : 1)] : undefined;
        // Yield at the edges so Tab can leave the message normally.
        if (!next) return;
        next.focus();
      } else return;
    } else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => shortcut(event);
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);

  function bodyKeyboard(event: KeyboardEvent, id: string) {
    const article = scroller.current?.querySelector<HTMLElement>(`[data-thread-message="${CSS.escape(id)}"]`);
    if (!article) return;
    shortcut(event, article);
    if (event.defaultPrevented || event.key === "Tab") return;
    const target = event.target as HTMLElement | null;
    if (["Enter", " "].includes(event.key) && target?.closest?.("a, button")) return;
    const forwarded = new KeyboardEvent("keydown", {
      key: event.key, code: event.code, altKey: event.altKey, ctrlKey: event.ctrlKey,
      metaKey: event.metaKey, shiftKey: event.shiftKey, repeat: event.repeat,
      isComposing: event.isComposing, bubbles: true, cancelable: true,
    });
    article.dispatchEvent(forwarded);
    if (forwarded.defaultPrevented) event.preventDefault();
  }

  function revealMessage(id: string) {
    activeMessage.current = id;
    scrollToMessage.current = id;
    setExpanded((all) => (all.includes(id) ? [...all] : [...all, id]));
  }

  function toggleAllMessages() {
    setExpanded(
      expanded.length === mail.messages.length
        ? [mail.messages.at(-1)?.id || ""]
        : mail.messages.map((message) => message.id),
    );
  }

  function unsubscribe() {
    setUnsubscribed(true);
    try {
      localStorage.setItem(`superlocal:unsubscribed:${mail.email}`, "true");
    } catch {
      /* Keep the subscription state for this session. */
    }
  }

  function setPopOut(value: boolean) {
    if (draft && value !== popOut) onDraftChange({ ...draft, popOut: value });
  }

  function respond(value: string) {
    setResponse(value);
    try {
      localStorage.setItem(`superlocal:invitation:${mail.id}`, value);
    } catch {
      /* Keep the response for this session. */
    }
  }

  function postComment() {
    const body = commentText.trim();
    if (!body || preferences.hideCommentBar) return;
    const next = [
      ...comments,
      { id: crypto.randomUUID(), body, createdAt: new Date().toISOString() },
    ];
    try {
      localStorage.setItem(commentKey, JSON.stringify(next));
    } catch {
      /* Keep the comment in this reader when storage is unavailable. */
    }
    scrollToComment.current = true;
    setCommentState({ key: commentKey, comments: next, text: "" });
  }
  useEffect(() => {
    if (!pendingCommentDelete) return;
    scroller.current?.querySelector(`[data-comment-id="${CSS.escape(pendingCommentDelete)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [pendingCommentDelete]);

  function deleteComment(id: string) {
    const next = comments.filter(comment => comment.id !== id);
    try { localStorage.setItem(commentKey, JSON.stringify(next)); }
    catch { /* Keep the deletion in this reader when storage is unavailable. */ }
    setCommentState({ key: commentKey, comments: next, text: commentText });
    setPendingCommentDelete(null);
    commentInput.current?.focus();
  }

  return (
    <section
      ref={readerPane}
      className="thread-view message-view"
      aria-label={mail.subject || "Message"}
      style={{ "--thread-comment-rows": commentRows } as CSSProperties}
    >
      <button
        ref={backGutter}
        type="button"
        className="thread-back-gutter"
        aria-label="Back to inbox (Escape)"
        onClick={onBack}
      >
        <span className="thread-back-arrow" title="Back to inbox (Escape)" aria-hidden="true">
          <Icon name="Back" size={16} />
        </span>
      </button>
      <header className="message-view-header thread-view-header">
        <div className="message-column message-heading-row">
          <h1>{mail.subject || "(No subject)"}</h1>
          <div
            className="message-navigation thread-header-actions"
            role="toolbar"
            aria-label="Message actions"
          >
            <IconButton
              name="Check"
              title="Mark done (E)"
              disabled={!supportsAction("done")}
              onClick={() => onAction("done")}
            />
            <IconButton
              name="Clock"
              title="Remind me (H)"
              disabled={!supportsAction("remind")}
              onClick={() => onAction("remind")}
            />
            <IconButton
              name="Bolt"
              title="Superlocal Command"
              onClick={() => onAction("more")}
            />
            <IconButton
              name="ChevronUp"
              title="Previous thread"
              onClick={() => onNavigate(-1)}
            />
            <IconButton
              name="ChevronDown"
              title="Next thread"
              onClick={() => onNavigate(1)}
            />
          </div>
        </div>
        <div className="message-column thread-toolbar">
          {marketing && (
            <button
              className="thread-unsubscribe"
              title="Unsubscribe (Cmd+U)"
              onClick={unsubscribe}
            >
              {unsubscribed ? "Unsubscribed" : "Unsubscribe"}
            </button>
          )}
          {!!mail.labels.length && (
            <div className="thread-labels">
              {mail.labels.map((label) => (
                <button
                  type="button"
                  key={label}
                  onClick={() => onAction("label")}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      <div
        className={`message-view-scroll ${preferences.hideCommentBar ? "" : "thread-comment-scroll"}`}
        ref={scroller}
      >
        <div
          ref={messageColumn}
          className={`message-column thread-message-column ${marketing ? "is-marketing" : ""} ${draft && !popOut ? "has-inline-draft" : ""} ${draft && replyFocused ? "is-reply-focused" : ""}`}
        >
          {(mail.reminder || mail.scheduled) && (
            <div className="thread-status">
              <Icon name="Clock" />
              {mail.scheduled
                ? `Scheduled for ${displayDate(mail.scheduled)}`
                : `Reminder: ${displayDate(mail.reminder || "")}`}
              {mail.operationId && <button type="button" className="text-button" onClick={() => onAction("cancel")}>Cancel send</button>}
            </div>
          )}
          {mail.messages.length > 1 && (
            <div className="thread-conversation-controls">
              <span>{mail.messages.length} messages</span>
              <button
                type="button"
                title="Expand or collapse all (Shift+O)"
                onClick={toggleAllMessages}
              >
                {expanded.length === mail.messages.length
                  ? "Collapse all"
                  : "Expand all"}
              </button>
            </div>
          )}
          {mail.messages.map((message, index) => {
            const open = expanded.includes(message.id) || !!replyResult && message.id === replyResult.id && revealedReply.current !== replyFocusKey;
            const showDetails = details.includes(message.id);
            const sent =
              message.outgoing ?? (message.email === account || message.email === mail.account);
            const isInvitation =
              mail.split === "Calendar" &&
              message.body.includes("meeting-invite");
            return (
              <article
                key={message.operationId || message.id}
                data-thread-message={message.id}
                data-send-operation={message.operationId}
                data-send-status={message.sendStatus}
                tabIndex={-1}
                onFocusCapture={() => {
                  activeMessage.current = message.id;
                }}
                onPointerDownCapture={() => {
                  activeMessage.current = message.id;
                }}
                className={`thread-message ${open ? "is-expanded" : "is-collapsed"} ${(replyResult && !draft ? message.id === replyResult.id : index === mail.messages.length - 1) ? "is-final" : ""}`}
                aria-label={`Message from ${message.from}`}
              >
                {!open ? (
                  <button
                    type="button"
                    className="thread-collapsed-row"
                    aria-expanded={false}
                    title="Expand message (O)"
                    onClick={() => setExpanded([...expanded, message.id])}
                  >
                    <strong>{sent ? "Me" : message.from}</strong>
                    <span>{message.bodyFormat === "text" ? message.bodyText : plainText(message.body)}</span>
                    <time dateTime={message.receivedAt} title={message.receivedAt ? new Date(message.receivedAt).toLocaleString() : message.date}>{message.date}</time>
                    <Icon name="ChevronDown" size={12} />
                  </button>
                ) : (
                  <>
                    <header className="thread-message-header">
                      <div className="thread-message-sender">
                        <button
                          type="button"
                          className="thread-sender-name"
                          onClick={onOpenProfile}
                        >
                          {sent ? "Me" : message.from}
                        </button>
                        <button
                          type="button"
                          className="thread-recipient-details"
                          title="Toggle message header (Shift+H)"
                          aria-label={
                            showDetails
                              ? "Collapse message header"
                              : "Expand message header"
                          }
                          aria-expanded={showDetails}
                          onClick={() =>
                            setDetails(
                              showDetails
                                ? details.filter((id) => id !== message.id)
                                : [...details, message.id],
                            )
                          }
                        >
                          {sent && message.to && <span>to {message.to}</span>}
                          <Icon
                            name={showDetails ? "ChevronUp" : "ChevronDown"}
                            size={12}
                          />
                        </button>
                      </div>
                      <div className="thread-message-meta">
                        {sent && message.sendStatus === "succeeded" ? (
                          <span className="thread-read-status" title="Sent" aria-label="Sent"><Icon name="Check" size={14} /></span>
                        ) : sent && !message.pending && !mail.sourceId && preferences.readReceipts && (
                          <span
                            className={`thread-read-status ${mail.opened ? "is-read" : ""}`}
                            title={
                              mail.opened
                                ? `Opened ${mail.opened}`
                                : "Not opened yet"
                            }
                            aria-label={
                              mail.opened
                                ? `Opened ${mail.opened}`
                                : "Not opened yet"
                            }
                          >
                            <Icon
                              name={mail.opened ? "Eye" : "Check"}
                              size={14}
                            />
                          </span>
                        )}
                        <span className="thread-inline-actions">
                          <IconButton
                            name="ArrowReply"
                            title="Reply (R)"
                             disabled={!!mail.operationId || !!message.pending || !supportsAction("reply")}
                             onClick={() => onCompose("reply", false, message.id)}
                          />
                          <IconButton
                            name="ArrowForward"
                            title="Forward (F)"
                             disabled={!!mail.operationId || !!message.pending || !supportsAction("send")}
                             onClick={() => onCompose("forward", false, message.id)}
                          />
                        </span>
                        <time dateTime={message.receivedAt} title={message.receivedAt ? new Date(message.receivedAt).toLocaleString() : message.date}>{message.date}</time>
                        {mail.messages.length > 1 && (
                          <IconButton
                            name="ChevronUp"
                            title="Collapse message"
                            size={12}
                            onClick={() =>
                              setExpanded(
                                expanded.filter((id) => id !== message.id),
                              )
                            }
                          />
                        )}
                      </div>
                    </header>
                    {showDetails && (
                      <dl className="thread-details">
                        <dt>From</dt>
                        <dd>
                          <button type="button" onClick={onOpenProfile}>
                            {message.from}
                          </button>{" "}
                          <span>&lt;{message.email}&gt;</span>
                        </dd>
                        <dt>To</dt>
                        <dd>{message.to}</dd>
                        {message.cc && (
                          <>
                            <dt>Cc</dt>
                            <dd>{message.cc}</dd>
                          </>
                        )}
                        {message.bcc && sent && (
                          <>
                            <dt>Bcc</dt>
                            <dd>{message.bcc}</dd>
                          </>
                        )}
                        <dt>Date</dt>
                        <dd>{message.receivedAt ? new Date(message.receivedAt).toLocaleString() : message.date}</dd>
                        <dt>Subject</dt>
                        <dd>{mail.subject || "(No subject)"}</dd>
                      </dl>
                    )}
                    {message.loaded === false ? <div className="message-body-loading" role="status">Loading message…</div> : (
                      <MessageBody
                        html={message.bodyDocument?.html ?? message.body}
                        styles={message.bodyDocument?.styles}
                        text={message.bodyText}
                        format={message.bodyFormat}
                        fontSize={preferences.fontSize}
                        onActivate={() => { activeMessage.current = message.id; }}
                        onKeyboard={event => bodyKeyboard(event, message.id)}
                        onImageSettings={onImageSettings}
                      />
                    )}
                    {isInvitation && (
                      <div className="thread-invitation">
                        <span>Going?</span>
                        <div role="group" aria-label="Respond to invitation">
                          {[
                            ["Accepted", "Yes"],
                            ["Tentative", "Maybe"],
                            ["Declined", "No"],
                          ].map(([value, label]) => (
                            <button
                              type="button"
                              key={value}
                              aria-label={
                                value === "Accepted"
                                  ? "Accept invitation"
                                  : value === "Declined"
                                    ? "Decline invitation"
                                    : "Maybe attend"
                              }
                              aria-pressed={response === value}
                              className={
                                response === value ? "is-selected" : ""
                              }
                              onClick={() => respond(value)}
                            >
                              {response === value && (
                                <Icon name="Check" size={13} />
                              )}{" "}
                              {label}
                            </button>
                          ))}
                        </div>
                        {response && (
                          <span
                            className="thread-invitation-response"
                            role="status"
                          >
                            {response}
                          </span>
                        )}
                      </div>
                    )}
                    {!!message.attachments?.length && (
                      <div className="message-attachments thread-attachments">
                        {message.attachments.map((file, fileIndex) => (
                          <a
                            className="message-attachment"
                            key={`${file.name}-${fileIndex}`}
                            href={file.data || undefined}
                            download={file.name}
                            aria-disabled={!file.data}
                            onClick={(event) => {
                              if (!file.data) event.preventDefault();
                            }}
                            title={
                              file.data
                                ? `Download ${file.name}`
                                : "Attachment unavailable"
                            }
                          >
                            <Icon name="Paperclip" />
                            <span>{file.name}</span>
                            <small>
                              {file.size < 1024 * 1024
                                ? `${Math.max(1, Math.round(file.size / 1024))} KB`
                                : `${(file.size / 1024 / 1024).toFixed(1)} MB`}
                            </small>
                            <Icon name="Download" />
                          </a>
                        ))}
                      </div>
                    )}
                    {index === mail.messages.length - 1 &&
                      sent &&
                      !mail.sourceId &&
                      preferences.readReceipts &&
                      mail.opened && (
                        <div className="thread-opened">
                          <Icon name="Eye" size={13} /> Opened {mail.opened}
                        </div>
                      )}
                  </>
                )}
              </article>
            );
          })}
          <div
            ref={reply}
            className={draft && !popOut ? "thread-reply-area" : undefined}
          >
            {draft && (
              <>
                <div
                  className={popOut ? "thread-popout-backdrop" : ""}
                  onMouseDown={(event) => {
                    if (popOut && event.target === event.currentTarget)
                      setPopOut(false);
                  }}
                >
                  <div className={popOut ? "thread-popout" : ""}>
                    {popOut && (
                      <header className="thread-popout-heading">
                        <span>{draft.subject}</span>
                        <IconButton
                          name="Close"
                          title="Return to thread"
                          onClick={() => setPopOut(false)}
                        />
                      </header>
                    )}
                    <Composer
                      key={draft.id}
                      inline
                      draft={draft}
                      autoFocus={false}
                      onFocusChange={setReplyFocused}
                      quickReplies={getQuickReplies(mail)}
                      focusRequest={
                        replyRequest === entryReplyRequest.current
                          ? 0
                          : replyRequest
                      }
                      snippetRequest={snippetRequest}
                      preferences={preferences}
                      accounts={accounts}
                      contacts={contacts}
                      onChange={onDraftChange}
                      onSearch={onSearch}
                      onToggleFocus={onToggleFocus}
                      onNavigate={onNavigate}
                      onSend={async (next, when, options) => {
                        if (!await onSend(next, when, options)) return false;
                        setSnippetRequest(0);
                        return true;
                      }}
                      onDiscard={async () => {
                        if (!await onDiscard()) return false;
                        setSnippetRequest(0);
                        return true;
                      }}
                      onReload={onReloadDraft}
                      onClose={() => {
                        setSnippetRequest(0);
                        setPopOut(false);
                        const message = reply.current?.previousElementSibling;
                        if (message instanceof HTMLElement)
                          message.focus({ preventScroll: true });
                      }}
                      onPopOut={() => setPopOut(!popOut)}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
        {comments.length > 0 && (
          <section
            className="message-column thread-comment-list"
            aria-label="Local thread comments"
          >
            {comments.map((comment) => (
              <article
                className="thread-comment-item"
                key={comment.id}
                data-comment-id={comment.id}
                tabIndex={0}
              >
                <header className="thread-comment-meta">
                  <strong>Me</strong>
                  <time dateTime={comment.createdAt}>
                    {new Date(comment.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                </header>
                <p className="thread-comment-body">{comment.body}</p>
                {pendingCommentDelete === comment.id && (
                  <div className="thread-comment-delete" role="group" aria-label="Delete local comment">
                    <span>Delete this local comment?</span>
                    <button type="button" className="text-button" onClick={() => setPendingCommentDelete(null)}>Keep comment</button>
                    <button type="button" className="text-button" onClick={() => deleteComment(comment.id)}>Delete comment</button>
                  </div>
                )}
              </article>
            ))}
          </section>
        )}
      </div>
      {!preferences.hideCommentBar && (
        <footer className="thread-comment-footer">
          <div className="message-column thread-comment-column">
            <form
              className="thread-comment-bar"
              onSubmit={(event) => {
                event.preventDefault();
                postComment();
              }}
            >
              <textarea
                ref={commentInput}
                className="thread-comment-input"
                aria-label="Local comment"
                title="Comment (M)"
                placeholder={"Add a local comment\u2026"}
                rows={commentRows}
                value={commentText}
                onChange={(event) =>
                  setCommentState({
                    key: commentKey,
                    comments,
                    text: event.target.value,
                  })
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    postComment();
                  }
                }}
              />
              <button
                type="submit"
                className="thread-comment-submit"
                aria-label="Post local comment"
                title="Post comment (Enter)"
                disabled={!commentText.trim()}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <circle cx="8" cy="8" r="8" fill="currentColor" />
                  <path d="M8 11V5m-2.5 2.5L8 5l2.5 2.5" />
                </svg>
              </button>
            </form>
          </div>
        </footer>
      )}
    </section>
  );
}
