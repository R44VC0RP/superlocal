import {
  useDeferredValue,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { flushSync } from "react-dom";
import {
  defaultPreferences,
  displayDate,
  folders,
  loadSaved,
  reminderTime,
  type Draft,
  type Mail,
  type Preferences,
  type SendOptions,
} from "./data";
import { Icon, IconButton, Key, Modal } from "./components";
import Composer from "./Composer";
import ThreadView from "./ThreadView";
import Settings from "./Settings";
import CalendarView from "./CalendarView";
import Snippets from "./Snippets";
import { useMailMotion } from "./mail-motion";
import { shortcutGroups } from "./shortcuts";
import { readSessionText, removeSaved, writeSessionText } from "./storage";
import { usePersistence } from "./use-persistence";
import { useInbox } from "./use-inbox";
import "./inbox.css";
import FolderNavigation from "./FolderNavigation";
import MailRows from "./MailRows";
import RecentOpens from "./RecentOpens";
import { selectMailView, mailWindow } from "./mail-view";
import { UNIFIED_ACCOUNT } from "./mail-model";
import { plainText } from "./mail-text";
import { resolveMailShortcut } from "./mail-shortcuts";
import MailCommandDialog, { type CommandItem } from "./MailCommandDialog";
import IssueReporter from "./IssueReporter";
import Notices, { Notice } from "./Notices";
import { InboxActionError, type InboxIssue } from "./inbox";
import { measureAction } from "./browser-logs";
import { captureIssueReport, type IssueReport } from "./issue-reports";
import SenderContext from "./SenderContext";
import { senderContact, senderConversations } from "./sender-context";
import { normalizeSplits, attentionSplit, type SplitPreferences } from "../../shared/splits";

type Route = {
  account: string;
  folder: string;
  split: string;
  thread?: string;
  draft?: string;
  view?: string;
};
type Overlay =
  | "command"
  | "remind"
  | "label"
  | "shortcuts"
  | "accounts"
  | "help"
  | "profile"
  | "searchTips"
  | null;
const searchTips = [
  ["from:alex", "from Alex"],
  ["to:jamie", "to Jamie"],
  ['"be brilliant"', 'contains "be brilliant"'],
  ["has:attachment", "with attachments"],
  ["subject:project", 'subject contains "project"'],
  ["in:sent", "in Sent"],
  ["in:inbox", "in the Inbox"],
  ["-in:inbox", "not in the Inbox"],
  ["label:Projects", "in this label"],
  ["is:unread", "unread conversations"],
  ["is:starred", "starred conversations"],
  ["before:2026/08/01", "before August 2026"],
  ["after:2026/08/01", "August 2026 or later"],
  ["older_than:3d", "more than 3 days ago"],
  ["newer_than:1m", "1 month ago or later"],
];
function readRoute(): Route {
  const params = new URLSearchParams(location.hash.replace(/^#\/?/, ""));
  return {
    account: params.get("account") || UNIFIED_ACCOUNT,
    folder: params.get("folder") || "Inbox",
    split: params.get("split") || "Important",
    thread: params.get("thread") || undefined,
    draft: params.get("draft") || undefined,
    view: params.get("view") || undefined,
  };
}

export default function App({ applicationUser, onSignOut }: { applicationUser?: { name: string; email: string }; onSignOut?: () => void } = {}) {
  const [route, setRoute] = useState<Route>(readRoute);
  const inbox = useInbox();
  const { store, mail, drafts } = inbox;
  const [preferences, setPreferences] = useState<Preferences>(() => {
    const saved = loadSaved<Record<string, unknown>>("preferences", {});
    const { version: _version, ...splits } = normalizeSplits({ ...saved, version: undefined });
    return { ...defaultPreferences, ...saved, ...splits };
  });
  const [navigation, setNavigation] = useState(false);
  const [settings, setSettings] = useState(false);
  const [settingsPage, setSettingsPage] = useState<string>();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [issueReporter, setIssueReporter] = useState<{
    draft: IssueReport | null;
  } | null>(null);
  const [capturingIssue, setCapturingIssue] = useState(false);
  const issueCapturePending = useRef(false);
  const [overlayIds, setOverlayIds] = useState<string[] | null>(null);
  const [commandDraftId, setCommandDraftId] = useState<string | null>(null);
  const commandMode =
    overlay === "command" ||
    overlay === "remind" ||
    overlay === "label" ||
    overlay === "accounts"
      ? overlay
      : null;
  const [labelEdit, setLabelEdit] = useState<{
    name: string;
    value: string;
    deleting: boolean;
  } | null>(null);
  const [reloadDraftId, setReloadDraftId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchSubmitted, setSearchSubmitted] = useState(false);
  const [searchResult, setSearchResult] = useState<{ key: string; ids: Set<string>; loading: boolean; error?: string } | null>(null);
  const [mailFilter, setMailFilter] = useState<string | null>(null);
  const [availabilityRequest, setAvailabilityRequest] = useState(0);
  const [replyRequest, setReplyRequest] = useState(0);
  const [replyFeedback, setReplyFeedback] = useState<{ id: string; threadId: string; scheduled?: string } | null>(null);
  const [calendarInitialView, setCalendarInitialView] = useState<
    "day" | "week"
  >("week");
  const [labelMode, setLabelMode] = useState<"toggle" | "move" | "navigate">(
    "toggle",
  );
  const [searchHistory, setSearchHistory] = useState<string[]>(() =>
    loadSaved("searches", []),
  );
  const [highlight, setHighlight] = useState(0);
  const pointerHighlight = useRef<number | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const customLabels = inbox.labels[route.account] ?? [];
  const [notice, setNotice] = useState<{
    text: string;
    undo?: () => void;
    operationId?: string;
    scheduled?: boolean;
  } | null>(null);
  const [noticeFading, setNoticeFading] = useState(false);
  const [noticeHovered, setNoticeHovered] = useState(false);
  // The read-only host reminder shows once per tab; the disabled controls and Add Accounts keep the state visible afterwards.
  const [readOnlyDismissed, setReadOnlyDismissed] = useState(() => readSessionText("read-only-notice") === "dismissed");
  const [onboardingReturn, setOnboardingReturn] = useState<{ providerId: string; connectionId: string | null } | null>(null);
  useEffect(() => {
    const url = new URL(location.href);
    const connection = url.searchParams.get("connection");
    if (connection !== "connected" && connection !== "failed") return;
    const providerId = url.searchParams.get("provider") || "gmail";
    const connectionId = url.searchParams.get("connectionId");
    for (const key of ["connection", "provider", "connectionId"]) url.searchParams.delete(key);
    history.replaceState(null, "", url);
    if (connection === "connected") {
      // Resume onboarding in Add Accounts so the user sees connecting → connected, then lands back in the inbox.
      setOnboardingReturn({ providerId, connectionId: /^[A-Za-z0-9_-]{1,128}$/.test(connectionId ?? "") ? connectionId : null });
      setSettingsPage("Add Accounts");
      setSettings(true);
      setMobileSidebar(true);
    } else {
      setNotice({ text: "Account connection could not be completed. Try again in Add Accounts." });
    }
  }, []);
  const [senderSelection, setSenderSelection] = useState<{ threadId: string; messageId: string } | null>(null);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [userProfile, setUserProfile] = useState(() =>
    loadSaved("profile", {
      name: "Me",
      location: "",
      bio: "",
      website: "",
    }),
  );
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [mobileViewport, setMobileViewport] = useState(() => matchMedia("(max-width: 700px)").matches);
  const searchInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const sequence = useRef({ key: "", time: 0 });
  const searchOrigin = useRef<Route | null>(null);
  const isUnified = route.account === UNIFIED_ACCOUNT;
  const accountOptions = (inbox.viewPreferences?.pinnedMailboxIds ?? []).filter(id => inbox.accounts.some(account => account.id === id));
  const unifiedMailboxIds = useMemo(() => inbox.viewPreferences?.unifiedMode === "all" ? inbox.accounts.map(account => account.id)
    : inbox.accounts.filter(account => inbox.viewPreferences?.includedMailboxIds.includes(account.id)).map(account => account.id), [inbox.accounts, inbox.viewPreferences]);
  const activeAccount = isUnified ? store.defaultMailbox() : inbox.accounts.find(account => account.id === route.account);
  const accountTitle = isUnified ? "Unified inbox" : activeAccount?.name || activeAccount?.email || "Choose a mailbox";
  const accountEmail = activeAccount?.email ?? "";
  const deferredQuery = useDeferredValue(query);
  const resultQuery = searchSubmitted ? query : deferredQuery;
  const accountMail = useMemo(
    () => mail.filter((message) => message.account === route.account),
    [mail, route.account],
  );
  const searchKey = `${route.account}\0${resultQuery}`;
  const searchVersion = useMemo(() => search && searchSubmitted
    ? accountMail.map(mail => `${mail.id}:${mail.folder}:${mail.unread}:${mail.starred}:${mail.labels.join(",")}:${mail.reminder ?? ""}:${mail.messages.map(message => message.revision).join(",")}`).join("|")
    : "", [accountMail, search, searchSubmitted]);
  const serverMatches = useMemo(() => searchSubmitted ? searchResult?.key === searchKey ? searchResult.ids : new Set<string>() : undefined, [searchSubmitted, searchResult, searchKey]);
  useEffect(() => {
    if (!search || !searchSubmitted || !route.account || !resultQuery.trim()) return;
    const controller = new AbortController();
    setSearchResult({ key: searchKey, ids: new Set(), loading: true });
    void store.search(route.account, resultQuery, controller.signal).then(ids => {
      if (!controller.signal.aborted) setSearchResult({ key: searchKey, ids, loading: false });
    }).catch(error => {
      if (!controller.signal.aborted) setSearchResult({ key: searchKey, ids: new Set(), loading: false, error: error instanceof Error ? error.message : "Search failed." });
    });
    return () => controller.abort();
  }, [store, search, searchSubmitted, route.account, resultQuery, searchKey, searchVersion]);
  const recent = useMemo(
    () =>
      accountMail
        .filter((message) => message.opened && message.folder !== "Trash")
        .slice(0, 30),
    [accountMail],
  );
  const contacts = useMemo(
    () => [
      ...new Map(
        accountMail.map((message) => [
          message.email,
          { name: message.from, email: message.email },
        ]),
      ).values(),
    ],
    [accountMail],
  );
  const {
    visibleMail,
    shownSplits,
    splitCounts,
    inboxCount,
    entries,
    totalHeight,
    rowHeight,
  } = useMemo(
    () =>
      selectMailView(
        accountMail,
        route.account,
        route.folder,
        route.split,
        preferences,
        search,
        resultQuery,
        mailFilter,
        serverMatches,
        mobileViewport,
      ),
    [
      accountMail,
      route.account,
      route.folder,
      route.split,
      preferences,
      search,
      resultQuery,
      mailFilter,
      serverMatches,
      mobileViewport,
    ],
  );
  const accountDrafts = useMemo(
    () => drafts.filter((d) => isUnified ? unifiedMailboxIds.includes(d.account) : d.account === route.account),
    [drafts, route.account, isUnified, unifiedMailboxIds],
  );
  const isDrafts = route.folder === "Drafts" && !search;
  const currentMail = useMemo(() => route.thread ? accountMail.find((m) => m.id === route.thread) : undefined, [accountMail, route.thread]);
  const getSenderConversations = useCallback((keys: readonly string[]) => senderConversations(accountMail, keys), [accountMail]);
  const contextContact = useMemo(() => currentMail && !currentMail.operationId
    ? senderContact(currentMail, inbox.senderHistory, inbox.accounts, senderSelection?.threadId === currentMail.id ? senderSelection.messageId : undefined)
    : null, [currentMail, inbox.senderHistory, inbox.accounts, senderSelection]);
  const contextMailboxIds = useMemo(() => isUnified ? unifiedMailboxIds : [route.account], [isUnified, unifiedMailboxIds, route.account]);
  const contextSender = currentMail && contextContact ? store.defaultMailbox(route.account, currentMail, contextContact.messageId ?? undefined) : undefined;
  // A reply keeps its thread association when the user changes its From account.
  const currentDraft =
    drafts.find((d) => d.id === route.draft) ||
    (currentMail
      ? drafts.find((d) => d.threadId === currentMail.id || !!d.sourceMessageId && d.sourceId === currentMail.sourceId && currentMail.messages.some(message => message.id === d.sourceMessageId))
      : undefined);
  const rowCount = isDrafts ? accountDrafts.length : visibleMail.length;
  const virtualized =
    !isDrafts && (!search || searchSubmitted) && entries.length > 100;
  const displayedRows = isDrafts ? accountDrafts : visibleMail;
  const rowsKey = useMemo(
    () =>
      `${preferences.density}:${displayedRows.map((item) => item.id).join("|")}`,
    [preferences.density, displayedRows],
  );
  const getMailWindow = useCallback((top: number, height: number, windowed: boolean) => {
    const range = windowed ? mailWindow(entries, top, height, rowHeight) : { start: 0, end: entries.length };
    return { ...range, entries: entries.slice(range.start, range.end) };
  }, [entries, rowHeight]);
  const getHighlightedMail = useCallback((index: number) => entries.find(entry => !entry.group && entry.index === index), [entries]);
  const targetIds = useMemo(() =>
    commandMode && commandMode !== "accounts" && overlayIds
      ? overlayIds
      : selected.length
        ? selected
        : currentMail
          ? [currentMail.id]
          : visibleMail[highlight]
            ? [visibleMail[highlight].id]
            : [], [commandMode, overlayIds, selected, currentMail, visibleMail, highlight]);
  const targets = useMemo(() => {
    const ids = new Set(targetIds);
    return ids.size ? mail.filter((message) => ids.has(message.id)) : [];
  }, [mail, targetIds]);
  const dark =
    !["Light", "light"].includes(preferences.theme) &&
    (!["System", "Match System"].includes(preferences.theme) || systemDark);
  const motion = useMailMotion(list, {
    rowsKey: search && !searchSubmitted ? `suggestions:${query}` : rowsKey,
    viewKey: `${route.account}:${route.folder}:${route.split}:${search ? `search:${searchSubmitted ? resultQuery : "suggestions"}` : "list"}:${route.thread || route.draft || route.view || ""}`,
    highlight,
    instantHighlight: pointerHighlight.current === highlight,
    focused: !navigation && !searchFocused,
  });
  useLayoutEffect(() => {
    const root = list.current;
    if (!root) return;
    root.scrollTop = listScroll.current;
  }, [route.thread, route.draft, route.view, search, searchSubmitted]);

  const storageFailure = () =>
    setNotice({
      text: "Browser storage is unavailable or full. Your changes remain open but could not be saved.",
    });
  usePersistence("preferences", preferences, storageFailure);
  usePersistence("searches", searchHistory, storageFailure);
  usePersistence("profile", userProfile, storageFailure);
  useLayoutEffect(() => {
    const saved = inbox.splitPreferences;
    if (!saved) return;
    const { version: _version, revision: _revision, ...values } = saved;
    setPreferences(previous => Object.entries(values).every(([key, value]) => JSON.stringify(previous[key]) === JSON.stringify(value)) ? previous : { ...previous, ...values });
    if (!saved.splits.includes(route.split)) {
      const original = attentionSplit({ splitRules: (preferences.splitRules as Record<string, string>) || {}, splitAliases: (preferences.splitAliases as Record<string, string>) || {} }, route.split);
      navigate({ split: saved.splits.find(name => original && attentionSplit(saved, name) === original) || saved.splits[0] || "Important" });
    }
  }, [inbox.splitPreferences, route.split]);
  useEffect(() => {
    if (!inbox.policy) return;
    const sendDelay = inbox.policy.undoSendSeconds ? `${inbox.policy.undoSendSeconds} seconds` : "No delay";
    const showImages = inbox.policy.remoteImages;
    setPreferences(previous => previous.sendDelay === sendDelay && previous.showImages === showImages ? previous : { ...previous, sendDelay, showImages });
  }, [inbox.policy]);
  useEffect(() => {
    if (!inbox.accounts.length || route.account === UNIFIED_ACCOUNT || inbox.accounts.some(account => account.id === route.account)) return;
    const account = inbox.accounts.find(account => account.email === route.account);
    const next: Route = { account: account?.id ?? UNIFIED_ACCOUNT, folder: "Inbox", split: preferences.splits[0] || "Important" };
    history.replaceState(null, "", `#/${new URLSearchParams({ account: next.account, folder: next.folder, split: next.split })}`);
    setRoute(next);
  }, [inbox.accounts, route.account, preferences.splits]);
  useEffect(() => {
    if (!currentMail || currentMail.operationId) return;
    void store.loadThread(currentMail.id).catch(() => {});
  }, [store, currentMail?.id, currentMail?.messages.map(message => `${message.id}:${message.bodyRevision ?? message.revision}:${!!message.loaded}`).join(","), inbox.policy?.remoteImages]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.style =
      preferences.themeStyle === "Classic" ? "Classic" : "Superlocal";
    document.documentElement.dataset.density =
      preferences.density.toLowerCase();
    document.title = `${currentMail?.subject || (route.draft ? "New Message" : route.folder === "Inbox" ? route.split : route.folder)} - Superlocal`;
  }, [
    dark,
    preferences.themeStyle,
    preferences.density,
    currentMail?.subject,
    route,
  ]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const mobile = matchMedia("(max-width: 700px)");
    const resize = () => setMobileViewport(mobile.matches);
    mobile.addEventListener("change", resize);
    const listener = () => setSystemDark(media.matches);
    media.addEventListener("change", listener);
    const pop = () => {
      setRoute(readRoute());
      closeNavigation();
      setSelected([]);
    };
    addEventListener("popstate", pop);
    return () => {
      media.removeEventListener("change", listener);
      mobile.removeEventListener("change", resize);
      removeEventListener("popstate", pop);
    };
  }, []);
  useEffect(() => {
    setNoticeHovered(false);
  }, [notice]);
  const replyOperation = replyFeedback ? inbox.operations[replyFeedback.id] : undefined;
  useEffect(() => {
    if (!replyFeedback || !replyOperation) return;
    const operation = replyOperation;
    setNotice(previous => {
      if (previous && previous.operationId !== operation.id) return previous;
      const text = operation.status === "succeeded" ? "Reply sent."
        : operation.status === "cancelled" ? "Reply cancelled. Draft restored."
        : operation.status === "failed" ? "Reply not sent. Draft restored."
        : operation.status === "partial" ? "Reply sent to some recipients only."
        : operation.status === "uncertain" ? "Reply delivery unconfirmed."
        : replyFeedback.scheduled ? `Reply scheduled for ${displayDate(replyFeedback.scheduled)}` : "Sending reply…";
      return { text, operationId: operation.id, scheduled: !!replyFeedback.scheduled,
        ...(operation.status === "pending" ? { undo: undoAction(() => store.undoSend(operation.id)) } : {}) };
    });
  }, [replyFeedback, replyOperation?.status]);
  useEffect(() => {
    setNoticeFading(false);
    if (!notice || noticeHovered) return;
    const operation = notice.operationId ? inbox.operations[notice.operationId] : undefined;
    if (!notice.scheduled && operation && ["pending", "processing"].includes(operation.status)) return;
    const lifetime = notice.undo ? 10000 : 4000;
    const fade = setTimeout(() => setNoticeFading(true), lifetime);
    const remove = setTimeout(() => setNotice(null), lifetime + 2000);
    return () => {
      clearTimeout(fade);
      clearTimeout(remove);
    };
  }, [notice, noticeHovered, notice?.operationId ? inbox.operations[notice.operationId]?.status : undefined]);
  useEffect(() => {
    if (search) searchInput.current?.focus();
  }, [search]);
  useEffect(() => {
    const pointer = pointerHighlight.current === highlight;
    pointerHighlight.current = null;
    if (pointer) return;
    list.current
      ?.querySelector<HTMLElement>('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function navigate(patch: Partial<Route>) {
    const next = { ...route, ...patch };
    const params = new URLSearchParams();
    Object.entries(next).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    history.pushState(null, "", `#/${params}`);
    setRoute(next);
    closeNavigation();
    setSenderSelection(null);
    setMobileSidebar(false);
  }
  function closeNavigation() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".folder-panel"))
      active.blur();
    setNavigation(false);
  }
  function goFolder(
    folder: string,
    split = preferences.splits[0] || "Important",
  ) {
    motion.prepare("switch");
    listScroll.current = 0;
    if (list.current) list.current.scrollTop = 0;
    navigate({
      folder,
      split,
      thread: undefined,
      draft: undefined,
      view: folder === "Snippets" ? "snippets" : undefined,
    });
    setSearch(false);
    setMailFilter(null);
    setQuery("");
    setSelected([]);
    setHighlight(0);
  }
  function openOverlay(value: Overlay, ids = targetIds) {
    if (value === "label") setLabelMode("toggle");
    if (value === "command") {
      const draft =
        (currentDraft &&
        (!currentDraft.popOut ||
          document.activeElement?.closest(".compose-view"))
          ? currentDraft
          : undefined) ||
        (isDrafts && !route.thread
          ? accountDrafts[highlight]
          : ids.length === 1
            ? drafts.find((draft) => draft.threadId === ids[0])
            : undefined);
      setCommandDraftId(draft?.id || null);
      if (draft) ids = draft.threadId ? [draft.threadId] : [];
    }
    setOverlayIds(
      value === "command" || value === "remind" || value === "label"
        ? ids
        : null,
    );
    setOverlay(value);
    closeNavigation();
  }
  function updatePreferences(patch: Partial<Preferences>) {
    const { sendDelay, showImages, splits, inactiveSplits, splitRules, splitAliases, ...local } = patch;
    setPreferences((p) => ({ ...p, ...local }));
    const splitPatch = Object.fromEntries(Object.entries({ splits, inactiveSplits, splitRules, splitAliases }).filter(([, value]) => value !== undefined));
    if (Object.keys(splitPatch).length) void store.setSplitPreferences(splitPatch as Partial<Omit<SplitPreferences, "version">>).catch(actionError);
    if (typeof sendDelay === "string") {
      const seconds = Number.parseInt(sendDelay, 10) || 0;
      void store.setPolicy({ undoSendSeconds: Math.min(120, seconds) }).catch(actionError);
    }
    if (typeof showImages === "boolean") void store.setPolicy({ remoteImages: showImages }).catch(actionError);
    if (typeof patch.profileName === "string")
      setUserProfile((p) => ({ ...p, name: patch.profileName as string }));
    if (typeof patch.profileLocation === "string")
      setUserProfile((p) => ({
        ...p,
        location: patch.profileLocation as string,
      }));
  }
  function actionError(error: unknown) {
    if (error instanceof InboxActionError) return;
    setNotice({ text: error instanceof Error ? error.message : "The inbox action failed. Your data has not been replaced with simulated state." });
  }
  // Retry for background problems only rereads: refresh the snapshot, reconnect live updates, reload the open conversation.
  function retryIssue(issue: InboxIssue) {
    void store.retry();
    if (issue.scope === "thread" && currentMail && !currentMail.operationId) void store.loadThread(currentMail.id).catch(() => {});
  }
  function dismissReadOnly() {
    setReadOnlyDismissed(true);
    writeSessionText("read-only-notice", "dismissed");
  }
  const notices = (
    <Notices issues={inbox.issues} onRetry={retryIssue} onDismiss={store.dismissIssue}>
      {inbox.host && !inbox.host.allowProviderWrites && !readOnlyDismissed && (
        <div role="status">
          <Notice quiet title="Read-only host" detail="Sending and provider changes are disabled." action={{ label: "Accounts", onClick: () => openSettings("Add Accounts") }} onDismiss={dismissReadOnly} data={{ scope: "read-only" }} />
        </div>
      )}
      {notice && (
        <div
          className={`toast ${noticeFading ? "is-fading" : ""}`}
          role="status"
          onMouseEnter={() => setNoticeHovered(true)}
          onMouseLeave={() => setNoticeHovered(false)}
        >
          <span className="toast-status">{notice.text}</span>
          {notice.undo && (
            <button
              className="toast-undo"
              onClick={() => {
                notice.undo?.();
                setNotice(null);
              }}
            >
              Undo
            </button>
          )}
          <IconButton
            name="Notification-closeIcon"
            title="Dismiss notification"
            size={10}
            className="toast-close"
            onClick={() => setNotice(null)}
          />
        </div>
      )}
    </Notices>
  );
  function undoAction(reverse: () => Promise<void>) {
    return () => {
      const timing = measureAction("undo");
      void reverse().then(() => { timing.accepted(); timing.finish(); }, error => { actionError(error); timing.finish("error"); });
    };
  }
  async function reportIssue() {
    if (issueCapturePending.current) return;
    issueCapturePending.current = true;
    flushSync(() => {
      setOverlay(null);
      setCapturingIssue(true);
    });
    try {
      const app = document.querySelector<HTMLElement>(".app");
      if (!app) throw new Error("The page is unavailable.");
      setIssueReporter({ draft: await captureIssueReport(app) });
    } catch {
      setNotice({
        text: "Could not capture the page. Try the Issue command again.",
      });
    } finally {
      issueCapturePending.current = false;
      setCapturingIssue(false);
    }
  }
  function openSettings(page?: string) {
    setSettingsPage(page);
    setSettings(true);
    setMobileSidebar(true);
    closeNavigation();
    setOverlay(null);
  }
  function startSearch(floatingDraftId?: string) {
    motion.prepare("search");
    searchOrigin.current = route;
    flushSync(() => {
      if (floatingDraftId)
        drafts.filter(draft => draft.id === floatingDraftId).forEach(draft => store.editDraft({ ...draft, popOut: true }));
      navigate({ thread: undefined, draft: floatingDraftId, view: undefined });
      setSearch(true);
      setSearchSubmitted(false);
      setSelected([]);
      setHighlight(0);
    });
    searchInput.current?.focus();
  }
  function closeSearch() {
    motion.prepare("return");
    setSearchFocused(false);
    setSearchSubmitted(false);
    setSearch(false);
    setQuery("");
    if (searchOrigin.current) {
      const origin = searchOrigin.current;
      navigate({
        ...origin,
        draft: drafts.some((draft) => draft.id === origin.draft)
          ? origin.draft
          : undefined,
      });
      searchOrigin.current = null;
    }
  }
  function changeSearchQuery(value: string, submit = false) {
    const timing = measureAction("search");
    motion.prepare(submit ? "return" : "search");
    setQuery(value);
    setSearchSubmitted(submit);
    setHighlight(0);
    if (submit) searchInput.current?.blur();
    timing.accepted(); timing.finish();
  }
  function openMail(m: Mail) {
    const timing = measureAction("open", 1);
    if (list.current) listScroll.current = list.current.scrollTop;
    motion.prepare("switch");
    if (preferences.markRead && m.unread && store.supports("read", m.mailboxId ?? m.account))
      void store.action([m], "read").catch(actionError);
    navigate({ thread: m.id, draft: undefined, view: undefined });
    setSelected([]);
    timing.accepted(); timing.finish();
  }
  function handleMailRow(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>("[data-mail-id]");
    // Animated exit clones are not interactive rows owned by this list.
    if (!row || row.parentElement !== event.currentTarget) return;
    const index = Number(row.getAttribute("aria-rowindex")) - 1;
    const mail = visibleMail[index];
    if (!mail || mail.id !== row.dataset.mailId) return;
    if (event.type === "contextmenu") {
      event.preventDefault();
      setHighlight(index);
      openOverlay("command", [mail.id]);
      return;
    }
    const action =
      event.target.closest<HTMLElement>("[data-mail-action]")?.dataset
        .mailAction;
    if (!action) {
      openMail(mail);
      return;
    }
    event.stopPropagation();
    if (action === "select") {
      setSelected((items) =>
        items.includes(mail.id)
          ? items.filter((id) => id !== mail.id)
          : [...items, mail.id],
      );
    } else if (action === "done") {
      applyAction("done", [mail.id]);
    } else if (action === "remind" || action === "command") {
      setHighlight(index);
      openOverlay(action, [mail.id]);
    }
  }
  function highlightPointerRow(event: PointerEvent<HTMLDivElement>) {
    if (event.type === "pointermove" && event.pointerType === "touch") return;
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>(".mail-row[data-motion-id]");
    if (!row || row.parentElement !== event.currentTarget) return;
    const index = Number(row.getAttribute("aria-rowindex")) - 1;
    if (!displayedRows[index] || displayedRows[index].id !== row.dataset.motionId) return;
    if (index === highlight) {
      motion.refreshHighlight();
      return;
    }
    pointerHighlight.current = index;
    setHighlight(index);
  }
  function goBack() {
    motion.prepare("return");
    if (
      route.draft &&
      currentDraft &&
      !currentDraft.to &&
      !currentDraft.cc &&
      !currentDraft.bcc &&
      !currentDraft.subject &&
      !plainText(currentDraft.body).trim() &&
      !currentDraft.attachments.length
    ) {
      if (store.getSnapshot().drafts.some(draft => draft.id === currentDraft.id))
        void store.discardDraft(currentDraft.id).catch(actionError);
    } else if (currentDraft && store.getSnapshot().drafts.some(draft => draft.id === currentDraft.id)) {
      void store.flushDraft(currentDraft.id).catch(actionError);
    }
    navigate({ thread: undefined, draft: undefined, view: undefined });
    setSenderSelection(null);
  }
  function toggleComposeFocus() {
    if (document.activeElement?.closest(".compose-view"))
      (
        list.current ||
        document.querySelector<HTMLElement>(
          ".thread-view [data-thread-message]",
        )
      )?.focus();
    else
      document
        .querySelector<HTMLElement>(".compose-view [contenteditable=true]")
        ?.focus();
  }
  async function newDraft(
    subject = "",
    body = "",
    popOut = false,
    availability = false,
  ) {
    motion.prepare("switch");
    setAvailabilityRequest((value) => (availability ? value + 1 : 0));
    try {
      const draft = await store.newDraft(route.account, { subject, body, popOut });
      navigate({ draft: draft.id, thread: undefined, view: undefined });
      setSearch(false);
      return draft;
    } catch (error) { actionError(error); }
  }
  async function composeReply(
    mode: "reply" | "replyAll" | "forward",
    popOut = false,
    sourceMessageId?: string,
  ) {
    if (!currentMail) return;
    setReplyRequest((value) => value + 1);
    const existing =
      currentDraft && (currentDraft.threadId === currentMail.id || currentDraft.sourceId === currentMail.sourceId && currentMail.messages.some(message => message.id === currentDraft.sourceMessageId)) ? currentDraft : undefined;
    if (existing) {
      store.editDraft({ ...existing, popOut: popOut || existing.popOut, updated: Date.now() });
      if (existing.mode !== mode || sourceMessageId && existing.sourceMessageId !== sourceMessageId)
        setNotice({
          text: "Resumed your saved draft. Discard it to change its reply or forward target.",
        });
      return;
    }
    try { await store.newDraft(route.account, { mode, popOut, mail: currentMail, sourceMessageId }); }
    catch (error) { actionError(error); }
  }
  async function composeContact() {
    if (!contextContact || !contextSender?.canSend) return;
    motion.prepare("switch");
    try {
      const draft = await store.newDraft(contextSender.id, { to: contextContact.email });
      navigate({ draft: draft.id, thread: undefined, view: undefined });
      setSearch(false);
    } catch (error) { actionError(error); }
  }
  function updateDraft(draft: Draft) {
    const current = drafts.find(value => value.id === draft.id);
    if (current && current.account !== draft.account) {
      void store.moveDraft(draft.id, draft.account).then(moved => {
        navigate({ account: moved.account, draft: moved.id, thread: undefined, view: undefined });
      }).catch(actionError);
    } else store.editDraft(draft);
  }
  async function discardDraft(id = currentDraft?.id) {
    const old = drafts.find((draft) => draft.id === id);
    if (!old) return false;
    try {
      await store.discardDraft(old.id);
      removeSaved(`draft-reminder:${old.id}`);
      if (route.draft === old.id) navigate({ draft: undefined, thread: undefined });
      setHighlight(value => Math.max(0, Math.min(value, accountDrafts.length - 2)));
      setNotice({ text: "Draft discarded" });
      return true;
    } catch (error) { actionError(error); return false; }
  }
  async function sendDraft(draft: Draft, when?: string, options?: SendOptions) {
    if (options?.instant) when = undefined;
    const conversation = ["reply", "replyAll"].includes(draft.mode)
      ? accountMail.find(mail => !mail.operationId && (mail.id === draft.threadId || mail.sourceId === draft.sourceId && mail.messages.some(message => message.id === draft.sourceMessageId)))
        ?? mail.find(mail => mail.id === draft.threadId && mail.account === draft.account && !mail.operationId) : undefined;
    try {
      const operation = await store.submit(draft, when);
      if (options?.markDone && draft.threadId) {
        const original = conversation ?? mail.find(mail => mail.id === draft.threadId);
        if (original) await store.action([original], "done");
      }
      const current = readRoute();
      if (conversation) {
        setReplyFeedback({ id: operation.id, threadId: conversation.id, scheduled: when });
        if (current.draft === draft.id) navigate({ account: conversation.account, draft: undefined, thread: conversation.id, view: undefined });
      } else if (current.draft === draft.id) navigate({ draft: undefined, thread: undefined, view: undefined });
      setNotice({
        text: when ? `${conversation ? "Reply scheduled" : "Scheduled"} for ${new Date(when).toLocaleString()}` : operation.status === "succeeded" ? conversation ? "Reply sent." : "Message sent" : conversation ? "Sending reply…" : "Send queued in the inbox",
        operationId: operation.id, scheduled: !!when,
        ...(operation.status === "pending" ? { undo: undoAction(() => store.undoSend(operation.id)) } : {}),
      });
      return true;
    } catch (error) {
      actionError(error);
      return false;
    }
  }
  async function applyAction(action: string, ids = targetIds) {
    if (action === "more") {
      openOverlay("command", ids);
      return;
    }
    if (action === "remind" || action === "label") {
      openOverlay(action, ids);
      return;
    }
    if (!ids.length) return;
    const timing = measureAction(action, ids.length);
    if (action === "not-important" && inbox.pending) { timing.finish("ignored"); return; }
    const previousRoute = route;
    const previousHighlight = highlight;
    const selectedIds = new Set(ids);
    const before = mail.filter((m) => selectedIds.has(m.id));
    if (
      action === "done" &&
      before.every((m) => ["Done", "Trash"].includes(m.folder))
    )
      action = "inbox";
    if (!inbox.host?.allowProviderWrites && before.some(message => !message.operationId) &&
      (["star", "unread", "read", "trash", "spam"].includes(action) || action === "inbox" && before.some(message => ["Auto Archived", "Spam", "Trash"].includes(message.folder)))) {
      setNotice({ text: "Provider changes are disabled by this read-only host." });
      timing.finish("ignored");
      return;
    }
    const finishMotion = motion.prepare("remove", ids);
    const starred = before.some((m) => !m.starred);
    const unread = before.some((m) => !m.unread);
    let reverse: () => Promise<void>;
    try { reverse = await store.action(before, action); timing.accepted(); }
    catch (error) { actionError(error); timing.finish("error"); return; }
    finally { finishMotion(); }
    const labels: Record<string, string> = {
      done: "Marked as Done.",
      "not-important": "Marked Done. Not-important feedback saved; categorization is unchanged.",
      trash: "Moved to Trash",
      spam: "Moved to Spam",
      inbox: "Moved to Inbox",
      star: starred ? "Starred" : "Unstarred",
      unread: unread ? "Marked unread" : "Marked read",
      cancel: "Queued send cancelled",
    };
    setNotice({
      text: `${before.length > 1 ? `${before.length} conversations: ` : ""}${labels[action] || "Updated"}`,
      undo: before.some(mail => mail.operationId) ? undefined : undoAction(async () => {
        await reverse(); navigate(previousRoute); setHighlight(previousHighlight);
      }),
    });
    setSelected([]);
    if (
      currentMail &&
      ["done", "not-important", "trash", "spam", "inbox", "mute", "cancel"].includes(action)
    ) {
      const next =
        visibleMail[
          visibleMail.findIndex((m) => m.id === currentMail.id) +
            (preferences.advanceDirection === "Previous conversation" ? -1 : 1)
        ];
      if (preferences.autoAdvance && next) openMail(next);
      else goBack();
    }
    if (!["star", "unread"].includes(action))
      setHighlight((v) => Math.max(0, Math.min(v, rowCount - 2)));
    setOverlay(null);
    timing.finish();
  }
  async function remind(when: string) {
    const before = targets;
    const previousRoute = route;
    const previousHighlight = highlight;
    const at = reminderTime(when);
    if (!at || !Number.isFinite(at)) { setNotice({ text: "Choose a future reminder date." }); return; }
    const finishMotion = motion.prepare("remove", before.map(message => message.id));
    let reverse: () => Promise<void>;
    try { reverse = await store.action(before, "remind", new Date(at).toISOString()); }
    catch (error) { actionError(error); return; }
    finally { finishMotion(); }
    setOverlay(null);
    setSelected([]);
    if (currentMail) {
      const next =
        visibleMail[
          visibleMail.findIndex((m) => m.id === currentMail.id) +
            (preferences.advanceDirection === "Previous conversation" ? -1 : 1)
        ];
      if (preferences.autoAdvance && next) openMail(next);
      else goBack();
    }
    setNotice({
      text: `Reminder set for ${displayDate(when)}`,
      undo: undoAction(async () => { await reverse(); navigate(previousRoute); setHighlight(previousHighlight); }),
    });
  }
  async function changeLabel(label: string) {
    if (labelMode === "navigate") {
      goFolder(label);
      setOverlay(null);
      return;
    }
    const before = targets;
    const previousRoute = route;
    const previousHighlight = highlight;
    const destination = ["Inbox", "Done", "Trash", "Spam"].includes(label);
    const remove =
      labelMode === "toggle" && targets.every((m) => m.labels.includes(label));
    const finishMotion = motion.prepare("remove", before.map(message => message.id));
    let reverse: () => Promise<void>;
    try {
      if (labelMode === "move" && destination) reverse = await store.action(before, label.toLowerCase());
      else {
        const undoLabel = await store.setLabel(before, label, remove);
        const undoMove = labelMode === "move" ? await store.action(before, "done") : undefined;
        reverse = async () => { await undoMove?.(); await undoLabel(); };
      }
    } catch (error) { actionError(error); return; }
    finally { finishMotion(); }
    setNotice({
      text:
        labelMode === "move"
          ? `Moved to ${label}`
          : remove
            ? `Removed ${label}`
            : `Added ${label}`,
      undo: undoAction(async () => { await reverse(); navigate(previousRoute); setHighlight(previousHighlight); }),
    });
    if (labelMode === "move") {
      setSelected([]);
      setOverlay(null);
      if (currentMail) goBack();
    }
  }
  async function removeLabels(all = false, delta = 0) {
    if (!all && !customLabels.includes(route.folder)) {
      if (route.folder === "Inbox") applyAction("done");
      else if (route.folder === "Starred") applyAction("star");
      return;
    }
    const before = targets;
    const previousRoute = route;
    const previousHighlight = highlight;
    const next =
      delta && currentMail
        ? visibleMail[
            visibleMail.findIndex((m) => m.id === currentMail.id) + delta
          ]
        : undefined;
    const finishMotion = motion.prepare("remove", before.map(message => message.id));
    const reverse: Array<() => Promise<void>> = [];
    try {
      for (const label of all ? [...new Set(before.flatMap(mail => mail.labels))] : [route.folder]) {
        reverse.push(await store.setLabel(before.filter(mail => mail.labels.includes(label)), label, true));
      }
    } catch (error) { actionError(error); return; }
    finally { finishMotion(); }
    setSelected([]);
    if (currentMail && !all) {
      if (next) openMail(next);
      else goBack();
    }
    setNotice({
      text: all ? "Removed all labels" : `Removed ${route.folder}`,
      undo: undoAction(async () => { for (const undo of reverse.reverse()) await undo(); navigate(previousRoute); setHighlight(previousHighlight); }),
    });
  }
  function editLabel(name: string) {
    closeNavigation();
    setOverlay(null);
    setLabelEdit({ name, value: name, deleting: false });
  }
  async function saveLabel() {
    if (!labelEdit) return;
    const { name, deleting } = labelEdit,
      value = labelEdit.value.trim();
    if (
      !deleting &&
      (!value ||
        customLabels.some(
          (l) => l !== name && l.toLowerCase() === value.toLowerCase(),
        ))
    ) {
      setNotice({ text: "Choose a unique label name." });
      return;
    }
    try { await store.editLabel(route.account, name, deleting ? undefined : value); }
    catch (error) { actionError(error); return; }
    if (route.folder === name) goFolder(deleting ? "Inbox" : value);
    setLabelEdit(null);
    setNotice({ text: deleting ? "Label deleted" : "Label renamed" });
  }
  function navigateThread(delta: number) {
    const index = visibleMail.findIndex((m) => m.id === currentMail?.id);
    const next = visibleMail[index + delta];
    if (next) {
      setHighlight(index + delta);
      openMail(next);
    }
  }
  const commandDraft = drafts.find((draft) => draft.id === commandDraftId);
  const lastFeedback = inbox.attentionFeedback.find(event => event.status === "active");
  const commandItems: CommandItem[] = [
    ...(!commandDraft && store.canRecordFeedback(targets) && !inbox.pending ? [{
      label: "Done + not important to me", detail: "Save feedback only. This does not change future categorization.", key: "W", icon: "Check", run: () => applyAction("not-important"),
    }] : []),
    ...(lastFeedback ? [{
      label: "Undo last not-important feedback", detail: "Retract the saved feedback and restore its previous Done state", key: "", icon: "ArrowLeft", run: () => {
        setOverlay(null);
        void store.undoFeedback(lastFeedback.id).then(() => setNotice({ text: "Feedback retracted and Done state restored." })).catch(actionError);
      },
    }] : []),
    ...(commandDraft
      ? [
          {
            label: "Discard Draft",
            detail: "Discard this unsent draft",
            key: "⌘ Shift ,",
            icon: "Trash",
            run: async () => {
              if (await discardDraft(commandDraft.id)) setOverlay(null);
            },
          },
        ]
      : []),
    {
      label: "Mark Done",
      detail: "Move this conversation out of your inbox",
      key: "E",
      icon: "Check",
      run: () => applyAction("done"),
    },
    {
      label: "Remind Me",
      detail: "Bring this conversation back later",
      key: "H",
      icon: "Clock",
      run: () => openOverlay("remind"),
    },
    {
      label: "Star",
      detail: "Keep this conversation close",
      key: "S",
      icon: "Star",
      run: () => applyAction("star"),
    },
    {
      label: "Mark Unread",
      detail: "Change the read status",
      key: "U",
      icon: "Envelope",
      run: () => applyAction("unread"),
    },
    {
      label: "Move to Trash",
      detail: "Move this conversation to Trash",
      key: "#",
      icon: "Trash",
      run: () => applyAction("trash"),
    },
    {
      label: "Label",
      detail: "Organize your conversations",
      key: "L",
      icon: "Label",
      run: () => openOverlay("label"),
    },
    {
      label: "Compose",
      detail: "Write a new message",
      key: "C",
      icon: "PencilSquircle",
      run: () => {
        setOverlay(null);
        newDraft();
      },
    },
    {
      label: "Search",
      detail: "Find anything in your mailbox",
      key: "/",
      icon: "Search",
      run: () => {
        setOverlay(null);
        startSearch();
      },
    },
    {
      label: "Reply",
      detail: "Reply to this message",
      key: "R",
      icon: "Reply",
      run: () => {
        setOverlay(null);
        if (currentMail) composeReply("reply");
        else if (targets[0]) openMail(targets[0]);
      },
    },
    {
      label: "Forward",
      detail: "Forward this conversation",
      key: "F",
      icon: "Forward",
      run: () => {
        setOverlay(null);
        if (currentMail) composeReply("forward");
        else if (targets[0]) openMail(targets[0]);
      },
    },
    {
      label: "Move to Inbox",
      detail: "Return this conversation to your inbox",
      key: "Shift E",
      icon: "Inbox",
      run: () => applyAction("inbox"),
    },
    {
      label: "Report Spam",
      detail: "Move to Spam",
      key: "!",
      icon: "Shield",
      run: () => applyAction("spam"),
    },
    ...folders.map(([label, key, icon]) => ({
      label: `Go to ${label}`,
      detail: `Open ${label}`,
      key: key ? `G then ${key.toUpperCase()}` : "",
      icon,
      run: () => {
        setOverlay(null);
        goFolder(label);
      },
    })),
    {
      label: "Settings",
      detail: "Customize Superlocal",
      key: ",",
      icon: "Gear",
      run: () => openSettings(),
    },
    {
      label: "Theme",
      detail: "Change appearance and style",
      key: "",
      icon: "Gear",
      run: () => openSettings("Theme"),
    },
    {
      label: "Split Inbox",
      detail: "Manage your inbox splits",
      key: "",
      icon: "Inbox",
      run: () => openSettings("Split Inbox"),
    },
    {
      label: "Signatures",
      detail: "Manage your email signature",
      key: "",
      icon: "PencilSquircle",
      run: () => openSettings("Signatures"),
    },
    {
      label: "Switch Account",
      detail: "Unified inbox and individual mailboxes",
      key: "Control 1–9",
      icon: "User",
      run: () => openOverlay("accounts"),
    },
    {
      label: "Unified inbox",
      detail: "Mail from all included mailboxes",
      key: "Control 0",
      icon: "Inbox",
      run: () => selectAccount(UNIFIED_ACCOUNT),
    },
    {
      label: "Manage mailboxes",
      detail: "Unified inbox selection and pinned shortcuts",
      key: "",
      icon: "Gear",
      run: () => openSettings("Mailboxes"),
    },
    {
      label: "Snippets",
      detail: "Write faster with saved snippets",
      key: "G ;",
      icon: "Snippet",
      run: () => {
        setOverlay(null);
        navigate({ view: "snippets", thread: undefined, draft: undefined });
      },
    },
    {
      label: "Keyboard Shortcuts",
      detail: "View keyboard shortcuts",
      key: "",
      icon: "Keyboard",
      run: () => openOverlay("shortcuts"),
    },
    {
      label: "Issue",
      detail: "Capture this page and describe a problem",
      key: "",
      icon: "PencilSquircle",
      run: () => {
        void reportIssue();
      },
    },
    {
      label: "Saved issues",
      detail: "Open locally saved issue reports",
      key: "",
      icon: "LinesThree",
      run: () => {
        setOverlay(null);
        setIssueReporter({ draft: null });
      },
    },
  ];
  function selectAccount(account: string) {
    motion.prepare("switch");
    setMailFilter(null);
    listScroll.current = 0;
    if (list.current) list.current.scrollTop = 0;
    setOverlay(null);
    navigate({
      account,
      folder: "Inbox",
      split: preferences.splits[0] || "Important",
      thread: undefined,
      draft: undefined,
      view: undefined,
    });
    setHighlight(0);
    setSelected([]);
    setSearch(false);
  }

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    const editing = target?.closest(
      "input,textarea,[contenteditable=true],select",
    );
    const intent = resolveMailShortcut(e, {
      mode:
        target?.closest(".compose-view") ||
        (route.draft && !currentDraft?.popOut)
          ? "composer"
          : route.view
            ? "auxiliary"
            : currentMail
              ? "reader"
              : "list",
      editing: !!editing,
      richText: !!editing?.hasAttribute("contenteditable"),
      interactive: !!target?.closest("button,a,summary"),
      modal: !!document.querySelector("[aria-modal=true]"),
      navigation,
      settings,
      floatingDraft: !!currentDraft?.popOut,
      isDrafts,
      accountDialog: overlay === "accounts",
      sequence:
        sequence.current.key === "g" &&
        Date.now() - sequence.current.time < 1500,
      search,
      hasHighlightedMail: !!visibleMail[highlight],
    });
    if (!intent) return;
    if (intent.clearSequence) sequence.current.key = "";
    if (intent.type === "account" || intent.type === "unified") {
      const account = intent.type === "unified" ? UNIFIED_ACCOUNT : accountOptions[intent.index];
      if (account) {
        e.preventDefault();
        selectAccount(account);
      }
      return;
    }
    if (intent.type === "sequence") {
      sequence.current = {
        key: intent.phase === "start" ? "g" : "",
        time: Date.now(),
      };
      return;
    }
    if (!["escape", "toggleSelection", "undo"].includes(intent.type))
      e.preventDefault();
    switch (intent.type) {
      case "command":
        openOverlay("command");
        break;
      case "escape":
        if (overlay) setOverlay(null);
        else if (navigation) closeNavigation();
        else if (settings) {
          setSettings(false);
          setMobileSidebar(false);
        } else if (route.thread || route.draft || route.view) goBack();
        else if (search) {
          if (searchSubmitted && !searchFocused) {
            searchInput.current?.focus();
            searchInput.current?.select();
          } else closeSearch();
        } else if (selected.length) setSelected([]);
        break;
      case "toggleFocus":
        toggleComposeFocus();
        break;
      case "calendar":
        setCalendarInitialView(intent.view);
        navigate({ view: "calendar", thread: undefined, draft: undefined });
        break;
      case "copyLink":
        void navigator.clipboard.writeText(location.href).then(
          () => setNotice({ text: "Private link copied" }),
          () => setNotice({ text: "Could not copy the link" }),
        );
        break;
      case "selectAll":
        setSelected(
          visibleMail
            .slice(intent.fromHere ? highlight : 0)
            .map((mail) => mail.id),
        );
        break;
      case "jump":
        setHighlight(intent.edge === "top" ? 0 : Math.max(0, rowCount - 1));
        break;
      case "drawerNavigate": {
        const buttons = [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".folder-panel button",
          ),
        ].filter((button) => button.offsetParent !== null);
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        buttons[
          Math.max(0, Math.min(buttons.length - 1, index + intent.delta))
        ]?.focus();
        break;
      }
      case "drawerActivate":
        if (
          document.activeElement instanceof HTMLButtonElement &&
          document.activeElement.closest(".folder-panel")
        )
          document.activeElement.click();
        else closeNavigation();
        break;
      case "goFolder":
        goFolder(intent.folder, intent.split ? preferences.splits.find(name => attentionSplit({ splitRules: (preferences.splitRules as Record<string, string>) || {}, splitAliases: (preferences.splitAliases as Record<string, string>) || {} }, name) === intent.split) || intent.split : undefined);
        break;
      case "labelMode":
        openOverlay("label");
        setLabelMode(intent.mode);
        break;
      case "compose":
        newDraft("", "", intent.popOut);
        break;
      case "search":
        startSearch();
        break;
      case "settings":
        openSettings();
        break;
      case "split": {
        const index = shownSplits.indexOf(route.split);
        goFolder(
          "Inbox",
          shownSplits[
            (index + intent.delta + shownSplits.length) % shownSplits.length
          ],
        );
        break;
      }
      case "openDrawer":
        setNavigation(true);
        break;
      case "openConversation":
        if (intent.drafts && accountDrafts[highlight])
          navigate({ draft: accountDrafts[highlight].id });
        else if (visibleMail[highlight]) openMail(visibleMail[highlight]);
        break;
      case "page": {
        const delta =
          Math.max(
            1,
            Math.floor((list.current?.clientHeight || 600) / rowHeight),
          ) * intent.delta;
        setHighlight((value) =>
          Math.max(0, Math.min(rowCount - 1, value + delta)),
        );
        break;
      }
      case "filter":
        motion.prepare("switch");
        setMailFilter((value) => (value === intent.name ? null : intent.name));
        setHighlight(0);
        listScroll.current = 0;
        if (list.current) list.current.scrollTop = 0;
        break;
      case "navigateConversation":
        if (currentMail) navigateThread(intent.delta);
        else
          setHighlight((value) =>
            Math.max(0, Math.min(rowCount - 1, value + intent.delta)),
          );
        break;
      case "reply":
        composeReply(intent.mode, intent.popOut);
        break;
      case "toggleSelection": {
        const id = visibleMail[highlight]?.id;
        if (id)
          setSelected((items) =>
            items.includes(id)
              ? items.filter((item) => item !== id)
              : [...items, id],
          );
        break;
      }
      case "removeLabels":
        removeLabels(intent.all, intent.delta);
        break;
      case "triage":
        applyAction(intent.action);
        break;
      case "undo":
        if (notice?.undo) {
          notice.undo();
          setNotice(null);
        }
        break;
      default: {
        const unhandled: never = intent;
        throw new Error(`Unhandled mail shortcut: ${unhandled}`);
      }
    }
  });
  useEffect(() => {
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  if (!inbox.loaded) {
    // Stay blank until the first snapshot arrives; an initial failure adds only the floating notice with Retry.
    return <div className="app" data-inbox-state={inbox.loading ? "loading" : "error"}>{inbox.loading ? null : notices}</div>;
  }

  const composer = currentDraft && (
    <Composer
      draft={currentDraft}
      preferences={preferences}
      accounts={inbox.accounts}
      contacts={contacts}
      onChange={updateDraft}
      onSend={sendDraft}
      onDiscard={() => discardDraft()}
      onReload={() => {
        setReloadDraftId(currentDraft.id);
      }}
      onClose={goBack}
      onSearch={() => startSearch(currentDraft.id)}
      onToggleFocus={toggleComposeFocus}
      availabilityRequest={availabilityRequest}
      onNavigate={(delta) => {
        if (isDrafts) {
          const index = accountDrafts.findIndex(
            (d) => d.id === currentDraft.id,
          );
          const next = accountDrafts[index + delta];
          if (next) navigate({ draft: next.id });
        } else {
          const next =
            visibleMail[
              Math.max(0, Math.min(visibleMail.length - 1, highlight + delta))
            ];
          if (next) openMail(next);
        }
      }}
    />
  );

  return (
    <div
      className={`app ${navigation ? "navigation-open" : ""} ${settings ? "settings-open" : ""} ${mobileSidebar ? "mobile-sidebar-open" : ""} ${route.view === "calendar" || route.view === "snippets" ? "auxiliary-view" : ""}`}
      data-inbox-state={inbox.loading ? "loading" : inbox.error ? "error" : "ready"}
    >
      <nav className="app-rail" aria-label="Apps">
        <IconButton
          name="Bolt"
          title="Superlocal Command (⌘K)"
          className="rail-command"
          onClick={() => openOverlay("command")}
        />
        <div className="app-switcher">
          <IconButton
            name="Envelope"
            title="Mail"
            className={route.view !== "calendar" ? "active" : ""}
            onClick={() => goFolder("Inbox")}
          />
          <IconButton
            name="Calendar"
            title="Calendar"
            className={route.view === "calendar" ? "active" : ""}
            onClick={() =>
              navigate({
                view: "calendar",
                thread: undefined,
                draft: undefined,
              })
            }
          />
        </div>
        <div className="rail-mobile-actions">
          <IconButton
            name="Gear"
            title="Settings"
            onClick={() => openSettings()}
          />
          <IconButton
            name="Eye"
            title="Recent Opens"
            onClick={() => {
              setSettings(false);
              setMobileSidebar(true);
            }}
          />
        </div>
      </nav>
      <main className="mail-workspace" data-folder={route.folder}>
        {route.view === "calendar" ? (
          <CalendarView
            initialView={calendarInitialView}
            onBack={goBack}
            account={accountEmail}
            preferences={preferences}
            onOpenSettings={() => openSettings()}
            onShareAvailability={() => newDraft("", "", false, true)}
          />
        ) : route.view === "snippets" ? (
          <Snippets
            onBack={goBack}
            onCompose={newDraft}
            onOpenFolders={() => setNavigation(true)}
            onOpenSettings={() => openSettings()}
          />
        ) : inbox.accounts.length === 0 ? (
          <div className="inbox-setup-empty">
            <h1>Connect an account</h1>
            <button className="settings-button" type="button" onClick={() => openSettings("Add Accounts")}>Add accounts</button>
          </div>
        ) : isUnified && !unifiedMailboxIds.length && !route.draft && !currentMail ? (
          <div className="inbox-setup-empty">
            <h1>No mailboxes in Unified inbox</h1>
            <button className="settings-button" type="button" onClick={() => openSettings("Mailboxes")}>Choose mailboxes</button>
            <button className="text-button" type="button" onClick={() => openOverlay("accounts")}>Open an individual mailbox</button>
          </div>
        ) : route.draft && currentDraft && !currentDraft.popOut ? (
          composer
        ) : currentMail ? (
          <ThreadView
            key={currentMail.id}
            mail={currentMail}
            focusOperationId={!currentDraft && replyFeedback?.threadId === currentMail.id ? replyFeedback.id : undefined}
            draft={currentDraft}
            account={route.account}
            accounts={inbox.accounts}
            contacts={contacts}
            preferences={preferences}
            onBack={goBack}
            onNavigate={navigateThread}
            onAction={applyAction}
            supportsAction={action => !!currentMail.operationId ? action === "trash" : store.supports(action, currentMail.mailboxId ?? currentMail.account)}
            onCompose={composeReply}
            replyRequest={replyRequest}
            onDraftChange={updateDraft}
            onSend={sendDraft}
            onDiscard={() => discardDraft()}
            onReloadDraft={() => {
              if (currentDraft) setReloadDraftId(currentDraft.id);
            }}
            onSearch={() => currentDraft && startSearch(currentDraft.id)}
            onToggleFocus={toggleComposeFocus}
            onImageSettings={() => openSettings("Images")}
            onOpenProfile={(messageId) => {
              setSenderSelection({ threadId: currentMail.id, messageId });
              setMobileSidebar(true);
            }}
          />
        ) : (
          <>
            <header className={`mail-header ${search ? "searching" : ""}`}>
              {!search && (
                <IconButton
                  name="LinesThree"
                  title="Switch folders"
                  className="folder-switch"
                  onClick={() => setNavigation(!navigation)}
                />
              )}
              {search ? (
                <div className="search-field">
                  <input
                    ref={searchInput}
                    aria-label="Search mail"
                    placeholder="Search"
                    value={query}
                    onFocus={() => setSearchFocused(true)}
                    onBlur={() => setSearchFocused(false)}
                    onChange={(e) => {
                      changeSearchQuery(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && query.trim()) {
                        motion.prepare("return");
                        setSearchSubmitted(true);
                        setSearchHistory((h) =>
                          [query, ...h.filter((s) => s !== query)].slice(0, 8),
                        );
                        e.currentTarget.blur();
                      }
                    }}
                  />
                  {query && (
                    <IconButton
                      name="Close"
                      title="Clear search"
                      onClick={() => {
                        setQuery("");
                        searchInput.current?.focus();
                      }}
                    />
                  )}
                  <IconButton
                    name="ChevronDown"
                    title="Search tips"
                    onClick={() => openOverlay("searchTips")}
                  />
                </div>
              ) : selected.length ? (
                <div className="selection-toolbar">
                  <button
                    onClick={() =>
                      setSelected(
                        selected.length === visibleMail.length
                          ? []
                          : visibleMail.map((m) => m.id),
                      )
                    }
                  >
                    <span className="select-square checked">
                      <Icon name="Check" size={11} />
                    </span>
                    <span>{selected.length} selected</span>
                    <Icon name="ChevronDown" size={13} />
                  </button>
                  {[
                    ["Check", "Mark Done", "done"],
                    ["Clock", "Remind Me", "remind"],
                    ["Star", "Star", "star"],
                    ["Envelope", "Mark Unread", "unread"],
                    ["Label", "Label", "label"],
                    ["Trash", "Trash", "trash"],
                  ].map(([icon, title, action]) => (
                    <IconButton
                      key={action}
                      name={icon}
                      title={title}
                      disabled={!targets.length || targets.some(mail => !mail.operationId && !store.supports(action, mail.mailboxId ?? mail.account))}
                      onClick={() => applyAction(action)}
                    />
                  ))}
                </div>
              ) : route.folder === "Inbox" ? (
                <div
                  className="split-tabs"
                  role="tablist"
                  aria-label="Split Inbox"
                >
                  {shownSplits.map((split) => (
                    <button
                      key={split}
                      role="tab"
                      aria-selected={route.split === split}
                      className={route.split === split ? "active" : ""}
                      onClick={() => goFolder("Inbox", split)}
                    >
                      <span className="split-tab-label">{split}</span>
                      <span className="split-tab-count">
                        {splitCounts[split] || ""}
                      </span>
                    </button>
                  ))}
                  <IconButton
                    name="Gear"
                    title="Split Inbox Settings"
                    className="split-settings"
                    onClick={() => openSettings("Split Inbox")}
                  />
                </div>
              ) : (
                <h1 className="folder-title">{route.folder}</h1>
              )}
              {!selected.length && (
                <div className="header-actions">
                  <IconButton name="Refresh" title="Refresh inbox" className="inbox-refresh"
                    aria-busy={inbox.refreshing} disabled={!activeAccount || inbox.refreshing}
                    onClick={() => { void store.sync(route.account).catch(actionError); }} />
                  {mailFilter && (
                    <button
                      className="mail-filter"
                      onClick={() => {
                        motion.prepare("switch");
                        setMailFilter(null);
                      }}
                      aria-label={`Clear ${mailFilter} filter`}
                    >
                      {mailFilter}
                      <Icon name="Close" size={12} />
                    </button>
                  )}
                  {search ? (
                    <IconButton
                      name="Close"
                      title="Close search"
                      onClick={closeSearch}
                    />
                  ) : (
                    <>
                      <IconButton
                        name="PencilSquircle"
                        title="Compose (C)"
                        disabled={!activeAccount?.canSend}
                        onClick={() => newDraft()}
                      />
                      <IconButton
                        name="Search"
                        title="Search (/)"
                        onClick={() => startSearch()}
                      />
                    </>
                  )}
                </div>
              )}
            </header>
            <div
              className="mail-list animated-mail-list"
              ref={list}
              role="table"
              tabIndex={-1}
              aria-rowcount={rowCount}
              onPointerMove={highlightPointerRow}
              onPointerDown={highlightPointerRow}
              onClick={handleMailRow}
              onContextMenu={handleMailRow}
              onScroll={(event) => {
                listScroll.current = event.currentTarget.scrollTop;
              }}
              aria-label={
                search
                  ? "Search results"
                  : `${route.folder === "Inbox" ? route.split : route.folder} conversations`
              }
            >
              {search && (!query || !searchSubmitted) ? (
                <div className="search-start">
                  <div className="search-contacts">
                    {contacts
                      .filter(
                        (contact) =>
                          !query ||
                          `${contact.name} ${contact.email}`
                            .toLowerCase()
                            .includes(query.toLowerCase()),
                      )
                      .slice(0, 4)
                      .map((contact) => (
                        <button
                          key={contact.email}
                          onClick={() =>
                            changeSearchQuery(`from:${contact.email}`, true)
                          }
                        >
                          <span>{contact.name}</span>
                          <span>{contact.email}</span>
                        </button>
                      ))}
                  </div>
                  <div className="search-terms">
                    {(searchHistory.length
                      ? searchHistory
                      : [
                          "basecamp",
                          "project",
                          "design",
                          "github",
                          "camera mount",
                          "bookmarks",
                          "studio",
                          "preview",
                        ]
                    ).map((s) => (
                      <button
                        key={s}
                        onClick={() => changeSearchQuery(s, true)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : isDrafts ? (
                accountDrafts.map((draft, i) => (
                  <div
                    key={draft.id}
                    data-motion-id={draft.id}
                    role="row"
                    aria-rowindex={i + 1}
                    className={`mail-row draft-row ${highlight === i ? "highlighted" : ""}`}
                    data-highlighted={highlight === i}
                    onClick={() => {
                      setHighlight(i);
                      navigate({ draft: draft.id, thread: undefined });
                    }}
                  >
                    <span className="row-from">
                      <span className="draft-tag">Draft</span>
                      {draft.to || "(no recipients)"}
                    </span>
                    <span className="row-content">
                      <span className="row-subject">
                        {draft.subject || "(no subject)"}
                      </span>
                      <span className="row-snippet">
                        {plainText(draft.body)}
                      </span>
                    </span>
                    <time>Draft</time>
                  </div>
                ))
              ) : (
                <MailRows
                  getWindow={getMailWindow}
                  getHighlighted={getHighlightedMail}
                  totalHeight={totalHeight}
                  rowHeight={rowHeight}
                  virtualized={virtualized}
                  highlight={highlight}
                  scrollToHighlight={pointerHighlight.current !== highlight}
                  selected={selected}
                  sent={route.folder === "Sent"}
                  showSnippets={preferences.showSnippets}
                  container={list}
                  scrollPosition={listScroll}
                  onWindowCommit={motion.refreshHighlight}
                />
              )}
              {rowCount === 0 &&
                !(search && searchResult?.key === searchKey && (searchResult.loading || searchResult.error)) &&
                !motion.hasExits &&
                !(search && (!query || !searchSubmitted)) && (
                  <div
                    className={`empty-mailbox ${route.folder === "Inbox" ? "inbox-zero" : ""}`}
                  >
                    {route.folder === "Inbox" && (
                      <Icon name="Check" size={34} />
                    )}
                    {(search || route.folder !== "Inbox") && (
                      <h2>
                        {search ? "No results" : "No conversations found here."}
                      </h2>
                    )}
                    <p>
                      {search
                        ? "Try another search or check your spelling."
                        : route.folder === "Inbox"
                          ? "You are all done."
                          : ""}
                    </p>
                    {route.folder === "Inbox" && (
                      <button
                        className="primary-button"
                        disabled={!activeAccount?.canSend}
                        onClick={() => newDraft()}
                      >
                        New Message
                      </button>
                    )}
                  </div>
                )}
              {motion.layers}
              {search && searchSubmitted && searchResult?.key === searchKey && (searchResult.loading || searchResult.error) && (
                <div className="empty-mailbox" role={searchResult.error ? "alert" : "status"}>{searchResult.error || "Searching…"}</div>
              )}
            </div>
          </>
        )}
        {route.draft && currentDraft?.popOut && composer}
      </main>
      <aside
        className="right-sidebar"
        aria-label={
          settings
            ? "Settings"
            : currentMail || route.draft
              ? "Sender context"
              : "Recent Opens"
        }
      >
        <IconButton
          className="mobile-sidebar-close"
          name="Close"
          title="Close sidebar"
          onClick={() => setMobileSidebar(false)}
        />
        {inboxCount > 0 && <span className="notification-count">{inboxCount}</span>}
        <div
          className="sidebar-content"
          onClick={(event) => {
            if (!(event.target instanceof Element)) return;
            const id = event.target.closest<HTMLElement>(
              "[data-recent-mail-id]",
            )?.dataset.recentMailId;
            const message = id && recent.find((message) => message.id === id);
            if (message) openMail(message);
          }}
        >
          {settings ? (
            <Settings
              key={settingsPage || "root"}
              preferences={preferences}
              onChange={updatePreferences}
              onClose={() => {
                setSettings(false);
                setMobileSidebar(false);
              }}
              onOpenShortcuts={() => openOverlay("shortcuts")}
              initialPage={settingsPage}
              account={accountEmail}
              accounts={inbox.accounts.map(account => account.email)}
              host={inbox.host}
              store={store}
              onboardingReturn={onboardingReturn}
              onOnboardingDone={() => {
                setOnboardingReturn(null);
                setSettings(false);
                setMobileSidebar(false);
                void store.refresh(true);
              }}
            />
          ) : search && !currentMail ? (
            <section className="search-sidebar">
              <h2>Tips</h2>
              <div>
                {searchTips.map(([value, description]) => (
                  <button key={value} onClick={() => setQuery(value)}>
                    <span>{value}</span>
                    <span>{description}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : currentMail && contextContact && !route.draft ? (
            <SenderContext
              key={`${route.account}:${contextContact.email.toLowerCase()}`}
              contact={contextContact}
              history={inbox.senderHistory}
              mailboxIds={contextMailboxIds}
              getConversations={getSenderConversations}
              currentThreadId={currentMail.id}
              remoteImages={inbox.policy?.remoteImages === true}
              showLogos={preferences.showAvatars !== false}
              canCompose={contextSender?.canSend === true}
              onCompose={() => { void composeContact(); }}
              onOpen={openMail}
              onImageSettings={() => openSettings("Images")}
            />
          ) : currentMail || route.draft ? (
            <div className="contact-panel">
              <h2>{userProfile.name}</h2>
              <div className="contact-identity">
                <div className="contact-avatar">
                  <Icon name="User" size={45} />
                  <span>
                    <Icon name="Envelope" size={12} />
                  </span>
                </div>
                <div>
                  <b>
                    {currentDraft?.from || currentMail?.email || accountEmail}
                  </b>
                  <p>{userProfile.location}</p>
                </div>
              </div>
              <button
                className="primary-button"
                onClick={() => openOverlay("profile")}
              >
                Edit Profile
              </button>
              <p className="contact-bio">{userProfile.bio}</p>
              {userProfile.website && <button
                className="contact-link"
                onClick={() =>
                  window.open(
                    `https://${userProfile.website}`,
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                <Icon name="Link" />
                {userProfile.website}
              </button>}
            </div>
          ) : preferences.recentOpens ? (
            <RecentOpens mail={recent} />
          ) : (
            <div className="sidebar-calendar">
              <h2>September 2026</h2>
              <div className="mini-calendar">
                {"SMTWTFS".split("").map((d, i) => (
                  <span key={`day-${i}`} className="day-name">
                    {d}
                  </span>
                ))}
                {Array.from({ length: 35 }, (_, i) => (
                  <button
                    className={i === 2 ? "today" : ""}
                    key={i}
                    onClick={() => navigate({ view: "calendar" })}
                  >
                    {i < 2 ? 30 + i : i < 32 ? i - 1 : i - 31}
                  </button>
                ))}
              </div>
              <p>No more events today</p>
              <button
                className="text-button"
                onClick={() => navigate({ view: "calendar" })}
              >
                Open calendar
              </button>
            </div>
          )}
        </div>
        <footer className="sidebar-footer">
          {applicationUser && onSignOut && (
            <button className="application-sign-out" type="button" title={`Sign out ${applicationUser.email}`} onClick={onSignOut}>Sign out</button>
          )}
          <div>
            <IconButton
              name="QuestionSquircle"
              title="Help"
              onClick={() => openOverlay("help")}
            />
            <IconButton
              name="Calendar"
              title="Calendar"
              onClick={() =>
                navigate({
                  view: "calendar",
                  thread: undefined,
                  draft: undefined,
                })
              }
            />
            <IconButton
              name="Gear"
              title="Settings"
              className={settings ? "active" : ""}
              onClick={() => (settings ? setSettings(false) : openSettings())}
            />
          </div>
        </footer>
      </aside>
      <FolderNavigation
        open={navigation}
        account={accountTitle}
        folder={route.folder}
        inboxCount={inboxCount}
        labels={customLabels}
        onClose={() => closeNavigation()}
        onAccounts={() => openOverlay("accounts")}
        onFolder={goFolder}
        onSnippets={() =>
          navigate({ view: "snippets", thread: undefined, draft: undefined })
        }
        onCreateLabel={() => {
          openOverlay("label");
        }}
        onEditLabel={editLabel}
        canManageLabels={!isUnified}
      />
      <MailCommandDialog
        mode={commandMode ?? "command"}
        open={commandMode !== null}
        onClose={() => setOverlay(null)}
        commands={commandItems.filter(item => inbox.host?.allowProviderWrites || !["Star", "Mark Unread", "Move to Trash", "Report Spam", "Compose", "Reply", "Reply All", "Forward"].includes(item.label))}
        labels={customLabels}
        labelMode={labelMode}
        targets={targets}
        onLabel={changeLabel}
        onCreateLabel={(label) => { void store.createLabel(route.account, label).then(() => changeLabel(label)).catch(actionError); }}
        onRemind={remind}
        accounts={inbox.accounts}
        pinnedMailboxIds={accountOptions}
        unifiedMailboxCount={unifiedMailboxIds.length}
        canCreateLabel={!isUnified}
        currentAccount={route.account}
        onAccount={selectAccount}
        onSettings={openSettings}
      />
      {capturingIssue && (
        <div data-issue-ui className="issue-capture-status" role="status">
          Capturing screenshot…
        </div>
      )}
      {issueReporter && (
        <IssueReporter
          draft={issueReporter.draft}
          onClose={() => setIssueReporter(null)}
          onSaved={() => {
            setIssueReporter(null);
            setNotice({ text: "Issue saved locally" });
          }}
        />
      )}
      {overlay && !commandMode && (
        <Modal
          label={overlay}
          onClose={() => setOverlay(null)}
          className={`app-modal ${overlay === "shortcuts" ? "shortcuts-modal" : ""}`}
        >
          <>
            <div className="simple-modal-header">
              <h2>
                {
                  (
                    {
                      shortcuts: "Keyboard Shortcuts",
                      help: "Help",
                      profile: "Edit Profile",
                      searchTips: "Search",
                    } as Record<string, string>
                  )[overlay]
                }
              </h2>
              <IconButton
                name="Close"
                title="Close"
                onClick={() => setOverlay(null)}
              />
            </div>
            {overlay === "shortcuts" && (
              <div className="shortcuts-content">
                {shortcutGroups.map(([name, rows]) => (
                  <section key={name}>
                    <h3>{name}</h3>
                    {rows.map(([label, key]) => (
                      <div key={label}>
                        <span>{label}</span>
                        <Key>{key}</Key>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            )}
            {overlay === "help" && (
              <div className="help-options">
                <button onClick={() => openOverlay("shortcuts")}>
                  <Icon name="Keyboard" />
                  Keyboard Shortcuts
                  <Icon name="ChevronRight" />
                </button>
                <button onClick={() => openOverlay("searchTips")}>
                  <Icon name="Search" />
                  Search tips
                  <Icon name="ChevronRight" />
                </button>
                <button onClick={() => openSettings()}>
                  <Icon name="Gear" />
                  Settings
                  <Icon name="ChevronRight" />
                </button>
              </div>
            )}
            {overlay === "profile" && (
              <form
                className="simple-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  setOverlay(null);
                  setNotice({ text: "Profile updated" });
                }}
              >
                {(["name", "location", "bio", "website"] as const).map(
                  (field) => (
                    <label key={field}>
                      {
                        {
                          name: "Name",
                          location: "Location",
                          bio: "About",
                          website: "Website",
                        }[field]
                      }
                      {field === "bio" ? (
                        <textarea
                          value={userProfile[field]}
                          onChange={(e) =>
                            setUserProfile((v) => ({
                              ...v,
                              [field]: e.target.value,
                            }))
                          }
                        />
                      ) : (
                        <input
                          value={userProfile[field]}
                          onChange={(e) =>
                            setUserProfile((v) => ({
                              ...v,
                              [field]: e.target.value,
                            }))
                          }
                        />
                      )}
                    </label>
                  ),
                )}
                <button type="submit" className="primary-button">
                  Save
                </button>
              </form>
            )}
            {overlay === "searchTips" && (
              <div className="search-tips">
                {[
                  ["from:alex", "From a person"],
                  ["to:jamie", "Sent to a person"],
                  ["subject:project", "Words in the subject"],
                  ["is:unread", "Unread messages"],
                  ["is:starred", "Starred conversations"],
                  ["has:attachment", "Messages with files"],
                  ["in:sent", "A specific mailbox"],
                  ["label:Projects", "Messages with a label"],
                ].map(([value, description]) => (
                  <button
                    key={value}
                    onClick={() => {
                      setOverlay(null);
                      goBack();
                      setSearch(true);
                      setQuery(value);
                    }}
                  >
                    <code>{value}</code>
                    <span>{description}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        </Modal>
      )}
      {reloadDraftId && (
        <Modal label="Reload saved draft" onClose={() => setReloadDraftId(null)} className="app-modal">
          <div className="simple-modal-header"><h2>Reload saved draft?</h2></div>
          <div className="simple-form">
            <p>Local unsaved edits will be replaced by the last saved version.</p>
            <div className="label-edit-actions">
              <button type="button" className="primary-button" onClick={() => {
                const id = reloadDraftId;
                setReloadDraftId(null);
                void store.reloadDraft(id).catch(actionError);
              }}>Reload draft</button>
              <button type="button" className="text-button" onClick={() => setReloadDraftId(null)}>Keep editing</button>
            </div>
          </div>
        </Modal>
      )}
      {labelEdit && (
        <Modal
          label={labelEdit.deleting ? "Delete label" : "Rename label"}
          onClose={() => setLabelEdit(null)}
          className="app-modal"
        >
          <div className="simple-modal-header">
            <h2>{labelEdit.deleting ? "Delete label?" : "Rename label"}</h2>
            <IconButton
              name="Close"
              title="Close label settings"
              onClick={() => setLabelEdit(null)}
            />
          </div>
          <form
            className="simple-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveLabel();
            }}
          >
            {labelEdit.deleting ? (
              <p>
                Delete "{labelEdit.name}"? Messages with this label will not be
                deleted.
              </p>
            ) : (
              <label>
                Label name
                <input
                  autoFocus
                  value={labelEdit.value}
                  onChange={(e) =>
                    setLabelEdit({ ...labelEdit, value: e.target.value })
                  }
                />
              </label>
            )}
            <div className="label-edit-actions">
              <button className="primary-button" type="submit">
                {labelEdit.deleting ? "Delete label" : "Save"}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => setLabelEdit(null)}
              >
                Cancel
              </button>
              {!labelEdit.deleting && (
                <button
                  type="button"
                  className="label-delete"
                  onClick={() => setLabelEdit({ ...labelEdit, deleting: true })}
                >
                  Delete label
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}
      {notices}
    </div>
  );
}
