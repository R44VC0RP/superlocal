import { ApiError, createInboxClient, type InboxClient } from "inbox-sdk/client";
import type {
  Account, BlobInfo, Changes, Draft as SdkDraft, DraftInput, Folder, Label,
  Mailbox, MailboxMessageSummary, Message as SdkMessage, Operation, Participant, Policy,
} from "inbox-sdk/types";
import type { Attachment, Draft, Mail, MailboxOption, Message } from "./data";
import { escapeHTML, plainText } from "./mail-text";
import { readSaved, writeSaved } from "./storage";
import { matchesSearch } from "./mail-search";
import { readHostConfiguration, readInboxViewPreferences, writeInboxViewPreferences, type HostConfiguration, type InboxViewPreferences } from "./host";
import { UNIFIED_ACCOUNT, unifiedMail, unifiedThreadId } from "./mail-model";
import type { SenderHistoryMessage } from "./sender-context";

type Edit = { draft: Draft; revision: number; version: number; error?: string };
type SendReference = { id: string; draftId: string; accountId: string; mailboxId: string };
type Sending = { ref: SendReference; operation: Operation; draft: SdkDraft };
export type InboxSnapshot = {
  accounts: MailboxOption[];
  mailboxes: Mailbox[];
  sources: Account[];
  viewPreferences: InboxViewPreferences | null;
  mail: Mail[];
  senderHistory: SenderHistoryMessage[];
  drafts: Draft[];
  labels: Record<string, string[]>;
  loading: boolean;
  refreshing: boolean;
  pending: number;
  unsaved: boolean;
  error: string | null;
  policy: Policy | null;
  host: HostConfiguration | null;
  operations: Readonly<Record<string, Operation>>;
};

const initial: InboxSnapshot = { accounts: [], mailboxes: [], sources: [], viewPreferences: null, mail: [], senderHistory: [], drafts: [], labels: {}, loading: true, refreshing: false, pending: 0, unsaved: false, error: null, policy: null, host: null, operations: {} };
const recoveryKey = "sdk-draft-recovery";
const outboxKey = "sdk-outbox-references";
const formatAddress = (person: Participant) => person.name && person.name !== person.email
  ? `${person.name.includes(",") ? JSON.stringify(person.name) : person.name} <${person.email}>` : person.email;
const addresses = (people: Participant[]) => people.map(formatAddress).join(", ");
const recipients = (value: string): Participant[] => (value.match(/(?:"[^"]*"|[^,;\n])+/g) ?? []).map(value => {
  const match = value.trim().match(/^(.*?)\s*<([^>]+)>$/);
  const email = (match?.[2] ?? value).trim();
  return { name: match?.[1]?.trim().replace(/^"|"$/g, "") || email, email };
}).filter(person => person.email);
const completeRecipients = (draft: Draft) => [draft.to, draft.cc, draft.bcc].every(value => recipients(value).every(person => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(person.email)));
const contentKey = (draft: Draft) => JSON.stringify([draft.account, draft.from, draft.mode, draft.to, draft.cc, draft.bcc, draft.subject, draft.body, draft.attachments]);
const viewThreadId = (box: string, thread: string) => `${box}:${thread}`;
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new DOMException("Request cancelled", "AbortError")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
});

// Message reads are sanitized by the SDK. Drafts are editable input, so constrain their HTML separately.
function draftHtml(value: string): string {
  const template = document.createElement("template");
  template.innerHTML = value;
  const allowed = new Set(["P", "DIV", "BR", "SPAN", "STRONG", "B", "EM", "I", "U", "S", "STRIKE", "BLOCKQUOTE", "UL", "OL", "LI", "PRE", "CODE", "A", "HR", "TABLE", "TBODY", "THEAD", "TR", "TD", "TH", "IMG"]);
  for (const node of Array.from(template.content.querySelectorAll("*"))) {
    if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE", "LINK", "META", "INPUT", "BUTTON", "TEXTAREA"].includes(node.tagName)) { node.remove(); continue; }
    if (!allowed.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
    const href = node.getAttribute("href"), src = node.getAttribute("src"), alt = node.getAttribute("alt");
    const styles = node instanceof HTMLElement ? ["color", "background-color", "font-weight", "font-style", "text-decoration", "text-align"].flatMap(property => {
      const value = node.style.getPropertyValue(property);
      return value && !/url|expression|var\(/i.test(value) ? [[property, value]] : [];
    }) : [];
    for (const attribute of Array.from(node.attributes)) node.removeAttribute(attribute.name);
    if (node instanceof HTMLElement) for (const [property, value] of styles) node.style.setProperty(property, value);
    if (node.tagName === "A" && href && /^(https?:|mailto:)/i.test(href)) {
      node.setAttribute("href", href); node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer");
    }
    if (node.tagName === "IMG") {
      if (!src || !/^(\/v1\/blobs\/[A-Za-z0-9_-]+|data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+)$/.test(src)) node.remove();
      else { node.setAttribute("src", src); if (alt) node.setAttribute("alt", alt); }
    }
  }
  return template.innerHTML;
}

function displayTime(value: string): { date: string; group: string } {
  const time = new Date(value), today = new Date();
  const sameDay = time.toDateString() === today.toDateString();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  return {
    date: sameDay ? time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : time.toLocaleDateString([], { month: "short", day: "numeric" }),
    group: sameDay ? "Today" : time.toDateString() === yesterday.toDateString() ? "Yesterday" : time.toLocaleDateString([], { month: "long", ...(time.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}) }),
  };
}

export class InboxStore {
  private state: InboxSnapshot = initial;
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private generation = 0;
  private started = false;
  private refreshPromise?: Promise<void>;
  private actionQueue: Promise<unknown> = Promise.resolve();
  private draftEpoch = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private sourceAccounts: Account[] = [];
  private boxes: Mailbox[] = [];
  private summaries = new Map<string, MailboxMessageSummary[]>();
  private details = new Map<string, SdkMessage>();
  private bodyEpoch = 0;
  private blobInfo = new Map<string, BlobInfo>();
  private folders = new Map<string, Folder[]>();
  private labels: Label[] = [];
  private rawDrafts = new Map<string, SdkDraft>();
  private edits = new Map<string, Edit>();
  private popouts = new Map<string, boolean>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private saves = new Map<string, Promise<SdkDraft>>();
  private uploads = new WeakMap<Attachment, Map<string, Promise<BlobInfo>>>();
  private sending = new Map<string, Sending>();
  private operations = new Map<string, Operation>();
  private submissions = new Map<string, { idempotencyKey: string; revision: number; sendAt?: string }>();
  private loadingThreads = new Map<string, Promise<void>>();
  private recovery = readSaved<Record<string, { draft: Draft; revision: number }>>(recoveryKey, {});
  private references = readSaved<SendReference[]>(outboxKey, []).filter(ref => ref && [ref.id, ref.draftId, ref.accountId, ref.mailboxId].every(value => typeof value === "string"));
  readonly client: InboxClient;

  constructor() {
    this.client = createInboxClient({ baseUrl: location.origin, fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const start = performance.now();
      const path = new URL(input instanceof Request ? input.url : String(input), location.origin).pathname;
      try {
        const response = await fetch(input, init);
        console.info({ event: "inbox.request", method: init?.method ?? "GET", path, status: response.status, durationMs: Math.round(performance.now() - start), requestId: response.headers.get("x-request-id") });
        return response;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) console.warn({ event: "inbox.request", method: init?.method ?? "GET", path, code: "NETWORK" });
        throw error;
      }
    }) as typeof fetch });
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<InboxSnapshot> = {}) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private requestOptions() { return { signal: this.controller.signal }; }
  private fail(error: unknown, action: string) {
    if (this.controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
    const code = error instanceof ApiError ? error.code : "NETWORK";
    console.warn({ event: "inbox.action", action, code });
    this.publish({ loading: false, refreshing: false, error: error instanceof ApiError ? `${error.message} (${error.code})` : error instanceof Error ? error.message : "The inbox could not be reached." });
  }
  private account(boxId: string) {
    const box = this.boxes.find(box => box.id === boxId);
    const source = this.sourceAccounts.find(account => account.id === box?.sourceId);
    if (!box || !source) throw new Error("Select a connected mailbox first.");
    return { box, source };
  }
  unifiedMailboxIds(): string[] {
    const available = this.boxes.map(box => box.id);
    const preferences = this.state.viewPreferences;
    if (!preferences) return [];
    return preferences.unifiedMode === "all" ? available : available.filter(id => preferences.includedMailboxIds.includes(id));
  }
  defaultMailbox(boxId = UNIFIED_ACCOUNT, mail?: Mail, messageId?: string): MailboxOption | undefined {
    if (boxId !== UNIFIED_ACCOUNT) return this.state.accounts.find(account => account.id === boxId);
    const message = messageId ? mail?.messages.find(message => message.id === messageId) : mail?.messages.filter(message => !message.pending).at(-1);
    const ids = message?.memberships?.length ? message.memberships.map(state => state.mailboxId) : mail?.mailboxIds ?? this.unifiedMailboxIds();
    const pins = this.state.viewPreferences?.pinnedMailboxIds ?? [];
    const specificity = { all: 0, domain: 1, address: 2 };
    return this.state.accounts.filter(account => ids.includes(account.id) && (!mail?.sourceId || mail.sourceId === account.sourceId)).sort((a, b) =>
      Number(b.canSend) - Number(a.canSend)
      || (mail ? specificity[b.selectorKind ?? "all"] - specificity[a.selectorKind ?? "all"] : 0)
      || (pins.includes(a.id) ? pins.indexOf(a.id) : 1000) - (pins.includes(b.id) ? pins.indexOf(b.id) : 1000))[0];
  }
  supports(action: string, boxId: string): boolean {
    if (boxId === UNIFIED_ACCOUNT) {
      if (action === "send" || action === "reply") {
        const box = this.defaultMailbox();
        return !!box && this.supports(action, box.id);
      }
      const ids = this.unifiedMailboxIds();
      return ids.length > 0 && ids.every(id => this.supports(action, id));
    }
    try {
      const { source } = this.account(boxId);
      if (["done", "inbox", "remind", "label", "cancel"].includes(action)) return true;
      if (source.status !== "connected") return false;
      if (!this.state.host?.allowProviderWrites) return false;
      if (action === "read") return source.capabilities.markRead;
      if (action === "send") return source.capabilities.send;
      if (action === "reply") return source.capabilities.reply && source.capabilities.send;
      if (action === "unread") return source.capabilities.markRead && source.capabilities.markUnread;
      if (action === "star") return source.capabilities.star;
      if (action === "trash") return source.capabilities.trash;
      if (["spam", "inbox"].includes(action)) return source.capabilities.folders;
      return false;
    } catch { return false; }
  }

  async search(boxId: string, query: string, signal: AbortSignal): Promise<Set<string>> {
    const options = { signal: AbortSignal.any([signal, this.controller.signal]) };
    const scope = boxId === UNIFIED_ACCOUNT ? this.unifiedMailboxIds() : [this.account(boxId).box.id];
    if (!scope.length) return new Set();
    let selected = new Set(this.state.mail.filter(mail => mail.account === boxId && !mail.operationId).map(mail => mail.id));
    for (const raw of query.match(/(?:[^\s"]|"[^"]*")+/g) ?? []) {
      const negative = raw.startsWith("-");
      let term = negative ? raw.slice(1) : raw;
      const match = term.match(/^([a-z_]+):(.*)$/i);
      const filter: Parameters<InboxClient["mailboxMessages"]>[0] = { mailboxIds: scope, limit: 100 };
      let filters = [filter];
      if (match?.[1] === "older_than" || match?.[1] === "newer_than") {
        const age = match[2].match(/^(\d+)([dmy])$/);
        if (!age) throw new Error("Use an age such as 3d, 1m, or 1y.");
        const date = new Date(Date.now() - Number(age[1]) * ({ d: 1, m: 30, y: 365 }[age[2] as "d" | "m" | "y"] * 86_400_000)).toISOString();
        if (match[1] === "older_than") filter.before = date; else filter.after = date;
        term = "";
      } else if (match?.[1] === "in") {
        const folder = match[2].replaceAll('"', "").toLowerCase().replaceAll(/\s/g, "");
        if (folder === "done") filter.done = true;
        else if (["reminders", "snoozed"].includes(folder)) filter.snoozed = true;
        else if (["all", "allmail"].includes(folder)) { /* No additional receiving-scope filter. */ }
        else {
          filter.folder = folder === "autoarchived" ? "archive" : folder;
          if (folder === "inbox") { filter.done = false; filter.snoozed = false; }
        }
        term = "";
      } else if (match?.[1] === "label") {
        const name = match[2].replaceAll('"', "");
        const groups = new Map<string, string[]>();
        for (const id of scope) {
          const sourceId = this.account(id).source.id;
          const ids = groups.get(sourceId) ?? []; ids.push(id); groups.set(sourceId, ids);
        }
        filters = [...groups].map(([sourceId, mailboxIds]) => {
          const local = this.labels.find(label => label.accountId === sourceId && label.name.toLowerCase() === name.toLowerCase());
          const native = this.folders.get(sourceId)?.find(folder => folder.kind === "label" && folder.name.toLowerCase() === name.toLowerCase());
          return { mailboxIds, limit: 100, ...(local ? { labelId: local.id } : native ? { folder: native.id } : { search: term }) };
        });
        term = "";
      }
      if (term) filter.search = term;
      const matched = new Set<string>();
      for (const selection of filters) for (let offset = 0; offset < selection.mailboxIds.length; offset += 50) {
        const mailboxIds = selection.mailboxIds.slice(offset, offset + 50);
        for (let attempt = 0; ; attempt++) {
          try {
            const batch = new Set<string>(); let cursor: string | undefined;
            do {
              const page = await this.client.mailboxMessages({ ...selection, mailboxIds, ...(cursor ? { cursor } : {}) }, options);
              page.items.forEach(message => batch.add(boxId === UNIFIED_ACCOUNT ? unifiedThreadId(message.sourceId, message.threadId) : viewThreadId(boxId, message.threadId)));
              cursor = page.nextCursor ?? undefined;
            } while (cursor);
            for (const id of batch) matched.add(id);
            break;
          } catch (error) { if (!(error instanceof ApiError) || error.code !== "STALE_CURSOR" || attempt >= 2) throw error; }
        }
      }
      selected = new Set([...selected].filter(id => negative ? !matched.has(id) : matched.has(id)));
    }
    for (const mail of this.state.mail.filter(mail => mail.account === boxId && mail.operationId)) if (matchesSearch(mail, query)) selected.add(mail.id);
    return selected;
  }

  start = () => {
    this.controller = new AbortController(); this.started = true;
    const generation = ++this.generation;
    const onFocus = () => { if (this.started && !this.state.loading && generation === this.generation) void this.refresh().catch(error => this.fail(error, "refresh")); };
    window.addEventListener("focus", onFocus);
    void (async () => {
      try {
        try { await this.client.accounts(this.requestOptions()); }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 401) throw error;
          const response = await fetch("/session", { method: "POST", credentials: "include", headers: { "X-Superlocal": "1" }, signal: this.controller.signal });
          if (!response.ok) throw new Error("Sign in through the host application before opening this inbox.");
          this.client.clearCache();
        }
        if (generation !== this.generation) return;
        await this.refresh();
        if (generation === this.generation) void this.follow(generation);
      } catch (error) { if (generation === this.generation) this.fail(error, "connect"); }
    })();
    return () => {
      window.removeEventListener("focus", onFocus);
      this.started = false; this.generation++; this.controller.abort();
      clearTimeout(this.refreshTimer);
      for (const timer of this.saveTimers.values()) clearTimeout(timer);
      this.saveTimers.clear(); this.refreshPromise = undefined;
    };
  };

  private async follow(generation: number) {
    while (this.started && generation === this.generation) {
      try {
        for await (const event of this.client.events({ ...this.requestOptions(), reconnect: false })) {
          if (generation !== this.generation) return;
          if (event.type !== "ready") this.scheduleRefresh();
        }
      } catch (error) { if (generation === this.generation) this.fail(error, "events"); }
      try { await pause(2000, this.controller.signal); if (generation === this.generation) await this.retry(); }
      catch { if (this.controller.signal.aborted) return; }
    }
  }
  private scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh().catch(error => this.fail(error, "refresh")), 100);
  }

  refresh = (force = false): Promise<void> => {
    if (this.refreshPromise) return force ? this.refreshPromise.then(() => this.refresh()) : this.refreshPromise;
    const generation = this.generation, options = this.requestOptions();
    const draftEpoch = this.draftEpoch;
    this.publish({ refreshing: true });
    const work = (async () => {
      const [accounts, boxes, labels, drafts, policy, host, viewPreferences] = await Promise.all([
        this.client.accounts(options), this.client.mailboxes(options), this.client.labels(undefined, options), this.client.drafts(undefined, options), this.client.policy(options),
        readHostConfiguration(options.signal),
        readInboxViewPreferences(options.signal),
      ]);
      const selected = boxes.filter(box => box.status !== "detached");
      const summaries = new Map<string, MailboxMessageSummary[]>(selected.map(box => [box.id, []]));
      // The SDK deduplicates canonical messages across a bounded mailbox selection.
      // Batch domains instead of issuing one complete paginated scan for every mailbox.
      for (let offset = 0; offset < selected.length; offset += 50) {
        const mailboxIds = selected.slice(offset, offset + 50).map(box => box.id);
        for (let attempt = 0; ; attempt++) {
          try {
            const items: MailboxMessageSummary[] = []; let cursor: string | undefined;
            do {
              const page = await this.client.mailboxMessages({ mailboxIds, limit: 100, ...(cursor ? { cursor } : {}) }, options);
              items.push(...page.items); cursor = page.nextCursor ?? undefined;
            } while (cursor);
            for (const item of items) for (const membership of item.memberships) {
              if (mailboxIds.includes(membership.mailboxId)) summaries.get(membership.mailboxId)?.push(item);
            }
            break;
          } catch (error) { if (!(error instanceof ApiError) || error.code !== "STALE_CURSOR" || attempt >= 2) throw error; }
        }
      }
      for (const account of accounts) if (!this.folders.has(account.id) && account.status === "connected") {
        this.folders.set(account.id, await this.client.folders(account.id, options));
      }
      for (const draft of drafts) for (const id of draft.attachmentIds) if (!this.blobInfo.has(id)) {
        const response = await fetch(`/v1/blobs/${encodeURIComponent(id)}`, { method: "HEAD", credentials: "include", signal: options.signal });
        if (!response.ok) throw new Error("Could not read draft attachment metadata.");
        const info = JSON.parse(decodeURIComponent(response.headers.get("x-inbox-blob-info") || "")) as BlobInfo;
        if (info.id !== id || info.accountId !== draft.accountId) throw new Error("The attachment metadata belongs to another source.");
        this.blobInfo.set(id, info);
      }
      const sending = new Map<string, Sending>();
      const operations = new Map<string, Operation>();
      for (const ref of this.references.filter(ref => accounts.some(account => account.id === ref.accountId))) {
        try {
          const operation = await this.client.operation(ref.id, options);
          if (operation.accountId !== ref.accountId) continue;
          operations.set(operation.id, operation);
          if (operation.type === "send" && ["pending", "processing", "failed", "uncertain"].includes(operation.status)) {
            const draft = await this.client.draft(ref.draftId, options);
            if (draft.accountId === ref.accountId) sending.set(ref.id, { ref, operation, draft });
          }
          const previous = this.operations.get(operation.id);
          if (previous && ["pending", "processing", "uncertain"].includes(previous.status) && ["succeeded", "partial"].includes(operation.status)) {
            const rows = summaries.get(ref.mailboxId);
            if (rows) for (const result of operation.results.filter(result => result.status === "succeeded")) {
              try {
                const message = await this.client.mailboxMessage(ref.mailboxId, result.messageId, options);
                if (message.accountId !== ref.accountId) throw new Error("The send result belongs to another source.");
                this.details.set(message.id, message);
                const index = rows.findIndex(row => row.id === message.id);
                if (index === -1) rows.push(message); else rows[index] = message;
              } catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
            }
          }
        } catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
      }
      if (generation !== this.generation) return;
      if (this.draftEpoch !== draftEpoch) for (const [id, operation] of this.operations) if (!operations.has(id)) {
        operations.set(id, operation);
        const pending = this.sending.get(id); if (pending) sending.set(id, pending);
      }
      this.operations = operations;
      this.sourceAccounts = accounts; this.boxes = selected; this.labels = labels; this.summaries = summaries; this.sending = sending;
      if (this.draftEpoch === draftEpoch) this.rawDrafts = new Map(drafts.map(draft => [draft.id, draft]));
      else this.scheduleRefresh();
      for (const raw of drafts) {
        const recovered = this.recovery[raw.id];
        if (recovered && !this.edits.has(raw.id) && recovered.draft?.sourceId === raw.accountId) {
          this.edits.set(raw.id, { draft: recovered.draft, revision: recovered.revision, version: 1,
            ...(raw.revision !== recovered.revision ? { error: "This draft changed elsewhere. Your local writing has been kept; reload the draft before replacing it." } : {}) });
          if (raw.revision === recovered.revision && completeRecipients(recovered.draft)) this.saveTimers.set(raw.id, setTimeout(() => void this.flushDraft(raw.id).catch(() => {}), 450));
        }
      }
      if (this.state.policy && this.state.policy.remoteImages !== policy.remoteImages) {
        this.bodyEpoch++;
        this.details.clear();
      }
      this.publish({ policy, host, viewPreferences, mailboxes: selected, sources: accounts, loading: false, refreshing: false, error: null }); this.rebuild();
    })();
    this.refreshPromise = work.finally(() => { if (this.refreshPromise === finished) this.refreshPromise = undefined; });
    const finished = this.refreshPromise;
    return finished;
  };

  private file(info: BlobInfo): Attachment {
    this.blobInfo.set(info.id, info);
    return { name: info.filename, size: info.size, type: info.contentType, blobId: info.id, sourceId: info.accountId, data: `/v1/blobs/${encodeURIComponent(info.id)}` };
  }
  private uiDraft(raw: SdkDraft): Draft {
    const box = this.boxes.find(box => box.id === raw.mailboxId) ?? this.boxes.find(box => box.sourceId === raw.accountId);
    const parent = raw.sourceMessageId && [...this.summaries.values()].flat().find(message => message.id === raw.sourceMessageId);
    const known = [...this.blobInfo.values(), ...[...this.details.values()].flatMap(message => message.attachments)];
    return {
      id: raw.id, account: box?.id ?? "", sourceId: raw.accountId, from: raw.from,
      sourceMessageId: raw.sourceMessageId, revision: raw.revision,
      mode: raw.mode === "compose" ? "new" : raw.mode,
      threadId: parent && box ? viewThreadId(box.id, parent.threadId) : undefined,
      popOut: this.popouts.get(raw.id) ?? false, to: addresses(raw.to), cc: addresses(raw.cc), bcc: addresses(raw.bcc), subject: raw.subject,
      body: draftHtml(raw.bodyHtml || `<div>${escapeHTML(raw.bodyText).replaceAll("\n", "<br>")}</div>`),
      attachments: raw.attachmentIds.map(id => { const info = known.find(info => info.id === id); return info ? this.file(info) : { name: "Attachment", size: 0, type: "application/octet-stream", blobId: id, sourceId: raw.accountId, data: `/v1/blobs/${encodeURIComponent(id)}` }; }),
      updated: Date.parse(raw.updatedAt),
    };
  }
  private rebuild() {
    const accounts: MailboxOption[] = this.boxes.map(box => {
      const source = this.sourceAccounts.find(account => account.id === box.sourceId)!;
      return { id: box.id, sourceId: source.id, name: box.name || source.name, email: box.defaultSender || source.email, selectorKind: box.selector.kind,
        canSend: this.state.host?.allowProviderWrites === true && source.status === "connected" && box.status === "active" && source.capabilities.send && !!box.defaultSender };
    });
    const mail: Mail[] = [], labelNames: Record<string, string[]> = {};
    const senderHistory = new Map<string, SenderHistoryMessage>();
    const sentMessages = new Map<string, Operation>();
    for (const operation of this.operations.values()) if (operation.type === "send") {
      for (const result of operation.results) if (result.status === "succeeded") sentMessages.set(result.messageId, operation);
    }
    for (const box of this.boxes) {
      const source = this.sourceAccounts.find(account => account.id === box.sourceId)!;
      const nativeFolders = this.folders.get(source.id) ?? [];
      const labels = this.labels.filter(label => label.accountId === source.id);
      labelNames[box.id] = [...new Set([...labels.map(label => label.name), ...nativeFolders.filter(folder => folder.kind === "label").map(folder => folder.name)])];
      const groups = new Map<string, MailboxMessageSummary[]>();
      for (const row of this.summaries.get(box.id) ?? []) {
        // Reuse normalized, body-free SDK facts. Overlapping views contribute
        // memberships, never extra exchanges; different sources stay separate.
        const key = `${source.id}\0${row.id}`, previous = senderHistory.get(key);
        const mailboxIds = [...new Set([...(previous?.mailboxIds ?? []), box.id])];
        senderHistory.set(key, previous && previous.revision > row.revision ? { ...previous, mailboxIds } : {
          id: row.id, sourceId: source.id, threadId: row.threadId, revision: row.revision,
          from: row.from, to: row.to, cc: row.cc, subject: row.subject, receivedAt: row.receivedAt, folder: row.folder,
          outgoing: row.folder === "sent" || row.folderIds.includes("sent") || sentMessages.get(row.id)?.accountId === source.id,
          mailboxIds,
        });
        const group = groups.get(row.threadId) ?? []; group.push(row); groups.set(row.threadId, group);
      }
      for (const [thread, rows] of groups) {
        rows.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
        const latest = rows.at(-1)!;
        const states = rows.map(row => row.memberships.find(state => state.mailboxId === box.id)!);
        const hidden = rows.every(row => row.folder === "trash") ? "Trash" : rows.every(row => row.folder === "spam") ? "Spam" : undefined;
        const done = states.every(state => state.done);
        const reminders = states.map(state => state.snoozedUntil).filter((value): value is string => !!value && Date.parse(value) > Date.now()).sort();
        const locations: string[] = [];
        if (hidden) locations.push(hidden);
        else {
          if (rows.some((row, index) => row.folder === "inbox" && !states[index].done && (!states[index].snoozedUntil || Date.parse(states[index].snoozedUntil!) <= Date.now()))) locations.push("Inbox");
          if (rows.some(row => row.folder === "sent")) locations.push("Sent");
          if (done) locations.push("Done");
          if (reminders.length) locations.push("Reminders");
          if (rows.every(row => row.folder === "archive" || row.folder === "sent") && rows.some(row => row.folder === "archive")) locations.push("Auto Archived");
        }
        const names = [...new Set(rows.flatMap(row => [
          ...row.labelIds.flatMap(id => labels.filter(label => label.id === id).map(label => label.name)),
          ...nativeFolders.filter(folder => folder.kind === "label" && row.folderIds.includes(folder.id)).map(folder => folder.name),
        ]))];
        const messages: Message[] = rows.map(row => {
          const detail = this.details.get(row.id);
          const operation = sentMessages.get(row.id);
          return { id: row.id, revision: row.revision, from: row.from.name || row.from.email, email: row.from.email, to: addresses(row.to), cc: addresses(row.cc),
            bcc: detail ? addresses(detail.bcc) : undefined, date: displayTime(row.receivedAt).date, receivedAt: row.receivedAt,
            body: detail?.bodyHtml ?? "", loaded: !!detail, outgoing: row.folder === "sent", hasAttachments: row.hasAttachments,
             bodyText: detail?.bodyText, bodyFormat: detail?.bodyFormat, bodyDocument: detail?.bodyDocument,
             nativeFolder: row.folder, isRead: row.isRead, isStarred: row.isStarred, memberships: row.memberships.filter(state => state.mailboxId === box.id),
            ...(operation?.accountId === source.id ? { operationId: operation.id, sendStatus: operation.status } : {}),
            attachments: detail?.attachments.map(info => this.file(info)), };
        });
        mail.push({ id: viewThreadId(box.id, thread), account: box.id, sourceId: source.id, mailboxId: box.id, sdkThreadId: thread, accountEmail: source.email,
          from: latest.from.name || latest.from.email, email: latest.from.email, to: addresses(latest.to), subject: rows[0].subject,
          snippet: latest.preview, ...displayTime(latest.receivedAt), receivedAt: Date.parse(latest.receivedAt), split: "Important",
          folder: hidden ?? (locations.includes("Inbox") ? "Inbox" : done ? "Done" : reminders.length ? "Reminders" : locations[0] ?? "Auto Archived"), locations, unread: rows.some(row => !row.isRead), starred: rows.some(row => row.isStarred), labels: names, messages,
          ...(reminders.length ? { reminder: reminders[0], reminderAt: Date.parse(reminders[0]) } : {}),
        });
      }
    }
    for (const { ref, operation, draft } of this.sending.values()) {
      if (!["pending", "processing", "uncertain"].includes(operation.status) || !accounts.some(account => account.id === ref.mailboxId)) continue;
      const date = operation.sendAt || operation.createdAt;
      const pendingMessage: Message = {
        id: `pending:${operation.id}`, operationId: operation.id, sendStatus: operation.status, pending: true,
        from: draft.from, email: draft.from, to: addresses(draft.to), cc: addresses(draft.cc), bcc: addresses(draft.bcc),
        date: operation.status === "uncertain" ? "Delivery unconfirmed" : operation.status === "processing" ? "Sending…" : `Queued · ${new Date(date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
        body: draftHtml(draft.bodyHtml || `<div>${escapeHTML(draft.bodyText).replaceAll("\n", "<br>")}</div>`), loaded: true, outgoing: true,
        hasAttachments: draft.attachmentIds.length > 0,
        attachments: draft.attachmentIds.flatMap(id => { const info = this.blobInfo.get(id); return info ? [this.file(info)] : []; }),
      };
      if (["reply", "replyAll"].includes(draft.mode)) {
        const conversation = mail.find(mail => mail.account === ref.mailboxId && mail.sourceId === draft.accountId && mail.messages.some(message => message.id === draft.sourceMessageId));
        if (conversation && !conversation.messages.some(message => message.operationId === operation.id)) conversation.messages.push(pendingMessage);
      }
      if (operation.status === "uncertain") continue;
      mail.push({ id: `operation:${operation.id}`, operationId: operation.id, sourceId: operation.accountId, mailboxId: ref.mailboxId, account: ref.mailboxId,
        accountEmail: draft.from, from: draft.from, email: draft.from, to: addresses(draft.to), subject: draft.subject, snippet: draft.bodyText,
        ...displayTime(date), receivedAt: Date.parse(date), split: "Important", folder: "Scheduled", locations: ["Scheduled"], unread: false, starred: false, labels: [], scheduled: date,
        messages: [{ ...pendingMessage, scheduledAt: date }],
      });
    }
    const included = this.unifiedMailboxIds();
    labelNames[UNIFIED_ACCOUNT] = [...new Set(included.flatMap(id => labelNames[id] ?? []))];
    mail.push(...unifiedMail(mail, included, accounts));
    mail.sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0) || a.id.localeCompare(b.id));
    const drafts = [...this.rawDrafts.values()].map(raw => {
      const edit = this.edits.get(raw.id);
      return { ...(edit?.draft ?? this.uiDraft(raw)), popOut: this.popouts.get(raw.id) ?? edit?.draft.popOut ?? false,
        saving: this.saves.has(raw.id) || !!edit && !edit.error && completeRecipients(edit.draft), dirty: !!edit, saveError: edit?.error };
    });
    this.publish({ accounts, mail, senderHistory: [...senderHistory.values()], drafts, labels: labelNames, unsaved: this.edits.size > 0 || this.saves.size > 0, operations: Object.fromEntries(this.operations) });
  }

  loadThread = (id: string): Promise<void> => {
    const pending = this.loadingThreads.get(id); if (pending) return pending;
    const mail = this.state.mail.find(mail => mail.id === id);
    if (!mail || mail.operationId) return Promise.resolve();
    const generation = this.generation;
    const bodyEpoch = this.bodyEpoch;
    const work = (async () => {
      for (const message of mail.messages) if (!message.pending && this.details.get(message.id)?.revision !== message.revision) {
        const mailboxId = message.memberships?.[0]?.mailboxId ?? mail.mailboxId!;
        const detail = await this.client.mailboxMessage(mailboxId, message.id, this.requestOptions());
        if (generation !== this.generation || bodyEpoch !== this.bodyEpoch) return;
        this.details.set(message.id, detail);
      }
      this.rebuild();
    })().catch(error => { this.fail(error, "read"); throw error; }).finally(() => {
      this.loadingThreads.delete(id);
      if (generation === this.generation && bodyEpoch !== this.bodyEpoch) void this.loadThread(id).catch(() => {});
    });
    this.loadingThreads.set(id, work); return work;
  };

  private saveRecovery() {
    const recovery = Object.fromEntries([...this.edits].map(([id, edit]) => [id, { draft: edit.draft, revision: edit.revision }]));
    this.recovery = recovery;
    if (!writeSaved(recoveryKey, recovery)) this.publish({ error: "Browser recovery storage is full. Keep this draft open until it is saved to the inbox." });
  }
  editDraft = (draft: Draft) => {
    const old = this.state.drafts.find(value => value.id === draft.id), raw = this.rawDrafts.get(draft.id);
    if (!raw) return;
    this.popouts.set(draft.id, draft.popOut ?? false);
    if (old && contentKey(old) === contentKey(draft)) { this.rebuild(); return; }
    const previous = this.edits.get(draft.id);
    this.edits.set(draft.id, { draft: { ...draft, updated: Date.now() }, revision: previous?.revision ?? raw.revision, version: (previous?.version ?? 0) + 1, ...(previous?.error ? { error: previous.error } : {}) });
    this.saveRecovery(); this.rebuild(); clearTimeout(this.saveTimers.get(draft.id));
    if (completeRecipients(draft) && !previous?.error) this.saveTimers.set(draft.id, setTimeout(() => void this.flushDraft(draft.id).catch(() => {}), 450));
  };

  private async uploadFile(file: Attachment, sourceId: string): Promise<BlobInfo> {
    if (file.blobId && file.sourceId === sourceId) return { id: file.blobId, accountId: sourceId, filename: file.name, contentType: file.type, size: file.size };
    let uploads = this.uploads.get(file); if (!uploads) { uploads = new Map(); this.uploads.set(file, uploads); }
    let upload = uploads.get(sourceId);
    if (!upload) {
      upload = (async () => {
        let content: Uint8Array;
        if (file.blobId) content = (await this.client.download(file.blobId, this.requestOptions())).content;
        else if (file.data?.startsWith("data:") && file.data.includes(";base64,")) {
          const raw = atob(file.data.slice(file.data.indexOf(",") + 1)); content = Uint8Array.from(raw, character => character.charCodeAt(0));
        } else throw new Error("This attachment has no available bytes. Remove it or choose the file again.");
        return this.client.upload(sourceId, { filename: file.name, contentType: file.type, content }, this.requestOptions());
      })(); uploads.set(sourceId, upload);
      void upload.catch(() => uploads!.delete(sourceId));
    }
    return upload;
  }
  private async draftInput(draft: Draft, sourceId: string): Promise<Partial<DraftInput>> {
    const uploaded = await Promise.all(draft.attachments.map(file => this.uploadFile(file, sourceId)));
    return { from: draft.from || this.account(draft.account).box.defaultSender || undefined, to: recipients(draft.to), cc: recipients(draft.cc), bcc: recipients(draft.bcc), subject: draft.subject,
      bodyHtml: draftHtml(draft.body), bodyText: plainText(draft.body), attachmentIds: uploaded.map(file => file.id) };
  }
  flushDraft = (id: string): Promise<SdkDraft> => {
    const existing = this.saves.get(id); if (existing) return existing.then(() => this.edits.has(id) ? this.flushDraft(id) : this.rawDrafts.get(id)!);
    clearTimeout(this.saveTimers.get(id)); this.saveTimers.delete(id);
    const work = (async () => {
      while (this.edits.has(id)) {
        const edit = this.edits.get(id)!;
        if (edit.error) throw new Error(edit.error);
        if (!completeRecipients(edit.draft)) throw new Error("Complete the recipient address before saving this draft.");
        const raw = this.rawDrafts.get(id); if (!raw) throw new Error("This draft is no longer active.");
        const input = await this.draftInput(edit.draft, raw.accountId);
        const saved = await this.client.updateDraft(id, input, edit.revision, this.requestOptions());
        this.draftEpoch++;
        this.rawDrafts.set(id, saved);
        const current = this.edits.get(id);
        if (current?.version === edit.version) this.edits.delete(id);
        else if (current) current.revision = saved.revision;
        this.saveRecovery(); this.rebuild();
      }
      const saved = this.rawDrafts.get(id); if (!saved) throw new Error("This draft is no longer active."); return saved;
    })().catch(error => {
      const edit = this.edits.get(id);
      if (edit) edit.error = error instanceof ApiError && error.status === 412 ? "This draft changed elsewhere. Your writing has been kept; reload or copy it before replacing the newer draft." : error instanceof Error ? error.message : "Draft save failed.";
      this.fail(error, "save-draft"); this.rebuild(); throw error;
    }).finally(() => { this.saves.delete(id); this.rebuild(); });
    this.saves.set(id, work); this.rebuild(); return work;
  };

  newDraft = async (boxId: string, input: { subject?: string; body?: string; popOut?: boolean; to?: string; mode?: Draft["mode"]; mail?: Mail; sourceMessageId?: string } = {}): Promise<Draft> => {
    if (boxId === UNIFIED_ACCOUNT) boxId = this.defaultMailbox(boxId, input.mail, input.sourceMessageId)?.id ?? "";
    const { box, source } = this.account(boxId);
    if (!this.state.accounts.find(account => account.id === boxId)?.canSend) throw new Error("This mailbox cannot send messages.");
    if (input.mode && input.mode !== "new" && input.mode !== "forward" && !source.capabilities.reply) throw new Error("This source cannot send replies.");
    if (input.mail) await this.loadThread(input.mail.id);
    if (input.sourceMessageId && !input.mail?.messages.some(message => message.id === input.sourceMessageId)) throw new Error("The selected message no longer belongs to this conversation.");
    const parent = input.sourceMessageId ?? input.mail?.messages.filter(message => !message.pending).at(-1)?.id;
    if (input.mail?.messages.find(message => message.id === parent)?.pending) throw new Error("Wait for the queued message to finish sending before replying to it.");
    const raw = await this.client.createDraft({ accountId: source.id, mailboxId: box.id, from: box.defaultSender!,
      mode: input.mode === "new" || !input.mode ? "compose" : input.mode, ...(parent ? { sourceMessageId: parent } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}), ...(input.body !== undefined ? { bodyHtml: draftHtml(input.body), bodyText: plainText(input.body) } : {}),
      ...(input.to !== undefined ? { to: recipients(input.to) } : {}),
    }, this.requestOptions());
    this.draftEpoch++; this.popouts.set(raw.id, input.popOut ?? false); this.rawDrafts.set(raw.id, raw); this.rebuild();
    return this.state.drafts.find(draft => draft.id === raw.id)!;
  };
  moveDraft = async (id: string, boxId: string): Promise<Draft> => {
    const raw = await this.flushDraft(id), current = this.state.drafts.find(draft => draft.id === id)!;
    const { source, box } = this.account(boxId);
    if (!this.state.accounts.find(account => account.id === boxId)?.canSend) throw new Error("This mailbox cannot send messages.");
    const input = await this.draftInput({ ...current, account: boxId, from: box.defaultSender! }, source.id);
    let saved: SdkDraft;
    if (source.id === raw.accountId) saved = await this.client.updateDraft(id, { ...input, mailboxId: boxId }, raw.revision, this.requestOptions());
    else {
      saved = await this.client.createDraft({ ...input, accountId: source.id, mailboxId: boxId, mode: "compose" }, this.requestOptions());
      await this.client.deleteDraft(id, raw.revision, this.requestOptions()); this.rawDrafts.delete(id);
    }
    this.draftEpoch++; this.popouts.set(saved.id, current.popOut ?? false); this.rawDrafts.set(saved.id, saved); this.rebuild();
    return this.state.drafts.find(draft => draft.id === saved.id)!;
  };
  discardDraft = async (id: string) => {
    clearTimeout(this.saveTimers.get(id)); this.saveTimers.delete(id);
    await this.saves.get(id)?.catch(() => {});
    const raw = this.rawDrafts.get(id); if (!raw) throw new Error("This draft is no longer active.");
    await this.client.deleteDraft(id, raw.revision, this.requestOptions()); this.draftEpoch++; this.rawDrafts.delete(id); this.edits.delete(id); this.saveRecovery(); this.rebuild();
  };
  reloadDraft = async (id: string) => {
    const raw = await this.client.draft(id, this.requestOptions()); this.draftEpoch++; this.edits.delete(id); this.rawDrafts.set(id, raw); this.saveRecovery(); this.rebuild();
  };

  submit = async (draft: Draft, sendAt?: string): Promise<Operation> => {
    if (!this.state.host?.allowProviderWrites) throw new Error("Sending is disabled by this read-only host.");
    this.editDraft(draft); const raw = await this.flushDraft(draft.id);
    const previous = this.references.filter(ref => ref.draftId === draft.id).at(-1);
    const previousStatus = previous && this.operations.get(previous.id)?.status;
    if (previousStatus === "cancelled" || previousStatus === "failed") this.submissions.delete(draft.id);
    let intent = this.submissions.get(draft.id);
    if (!intent) { intent = { idempotencyKey: crypto.randomUUID(), revision: raw.revision, ...(sendAt ? { sendAt } : {}) }; this.submissions.set(draft.id, intent); }
    let operation: Operation;
    try { operation = await this.client.submit(draft.id, intent, this.requestOptions()); }
    catch (error) { if (error instanceof ApiError && error.status >= 400 && error.status < 500) this.submissions.delete(draft.id); throw error; }
    const ref = { id: operation.id, draftId: raw.id, accountId: raw.accountId, mailboxId: raw.mailboxId || draft.account };
    this.references = [...this.references.filter(item => item.id !== ref.id), ref].slice(-200);
    if (!writeSaved(outboxKey, this.references)) this.publish({ error: "The send is queued, but this browser could not save its operation reference." });
    this.draftEpoch++; this.rawDrafts.delete(raw.id); this.edits.delete(raw.id); this.saveRecovery();
    this.operations.set(operation.id, operation);
    this.sending.set(operation.id, { ref, operation, draft: raw }); this.rebuild(); this.scheduleRefresh();
    return operation;
  };

  private async settled(operation: Operation): Promise<Operation> {
    const deadline = Date.now() + 20_000;
    while (["pending", "processing"].includes(operation.status)) {
      if (Date.now() >= deadline) throw new Error("This action is still pending in the SDK. Its status will update automatically.");
      await pause(200, this.controller.signal); operation = await this.client.operation(operation.id, this.requestOptions());
    }
    if (operation.status !== "succeeded") throw new Error(operation.problem?.message || `The SDK operation ${operation.status}.`);
    return operation;
  }
  private async mutation(boxId: string, ids: string[], changes: Changes): Promise<Operation> {
    if (!this.state.host?.allowProviderWrites && Object.keys(changes).some(key => !["addLabelIds", "removeLabelIds", "snoozedUntil"].includes(key))) {
      throw new Error("Provider changes are disabled by this read-only host.");
    }
    const rows = await Promise.all(ids.map(id => this.client.mailboxMessage(boxId, id, this.requestOptions())));
    const operation = await this.client.mutate({ messageIds: ids, viaMailboxId: boxId, changes, ifRevisions: Object.fromEntries(rows.map(row => [row.id, row.revision])), idempotencyKey: crypto.randomUUID() }, this.requestOptions());
    this.scheduleRefresh(); return this.settled(operation);
  }
  private mailboxTargets(mail: Mail, allMemberships = false): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const message of mail.messages) {
      if (message.pending || seen.has(message.id)) continue;
      seen.add(message.id);
      const memberships = message.memberships?.map(state => state.mailboxId);
      const ids = memberships?.length ? [...new Set(memberships)] : [mail.mailboxId ?? mail.account];
      for (const id of allMemberships ? ids : ids.slice(0, 1)) {
        const source = this.account(id).source;
        if (mail.sourceId && source.id !== mail.sourceId) throw new Error("A conversation cannot span unrelated source accounts.");
        const messages = result.get(id) ?? []; messages.push(message.id); result.set(id, messages);
      }
    }
    return result;
  }
  async act<T>(action: string, work: () => Promise<T>): Promise<T> {
    const previous = this.actionQueue;
    let release!: () => void;
    this.actionQueue = new Promise<void>(resolve => { release = resolve; });
    this.publish({ pending: this.state.pending + 1 });
    await previous;
    try { const result = await work(); await this.refresh(true); return result; }
    catch (error) { await this.refresh().catch(() => {}); this.fail(error, action); throw error; }
    finally { release(); this.publish({ pending: Math.max(0, this.state.pending - 1) }); }
  }
  action = (selected: Mail[], action: string, value?: string): Promise<() => Promise<void>> => this.act(action, async () => {
    // Keep the clicked message/membership scope: a queued action must not absorb
    // a newly arrived reply or a later change to Unified inbox configuration.
    const undo: Array<() => Promise<unknown>> = [];
    const starred = selected.some(mail => !mail.starred), unread = selected.some(mail => !mail.unread);
    const native = action === "star" ? { isStarred: starred } : action === "unread" ? { isRead: !unread } : action === "read" ? { isRead: true }
      : action === "trash" ? { folder: "trash" } : action === "spam" ? { folder: "spam" } : undefined;
    for (const mail of selected) {
      if (mail.operationId && !["trash", "cancel"].includes(action)) throw new Error("Cancel the queued send before changing it.");
      if (!mail.operationId && !native && !["done", "inbox", "remind"].includes(action)) throw new Error(`The SDK does not expose ${action}; no simulated mail change was made.`);
      if (native && !mail.operationId) for (const boxId of this.mailboxTargets(mail).keys()) {
        const capability = action === "star" ? "star" : action === "unread" && unread ? "markUnread" : ["unread", "read"].includes(action) ? "markRead" : action === "trash" ? "trash" : "folders";
        const { source } = this.account(boxId);
        if (!this.state.host?.allowProviderWrites || source.status !== "connected" || !source.capabilities[capability]) throw new Error(`A selected source does not support ${action}.`);
      }
    }
    try {
      for (const mail of selected) {
        if (mail.operationId) { await this.client.cancel(mail.operationId, this.requestOptions()); continue; }
        if (native) {
          for (const [boxId, ids] of this.mailboxTargets(mail)) {
            const operation = await this.mutation(boxId, ids, native);
            undo.push(() => this.client.undo(operation.id, this.requestOptions()).then(operation => this.settled(operation)));
          }
        } else {
          if (action === "inbox") for (const [boxId, ids] of this.mailboxTargets(mail)) {
            const rows = await Promise.all(ids.map(id => this.client.mailboxMessage(boxId, id, this.requestOptions())));
            const moved = rows.filter(row => !["inbox", "sent"].includes(row.folder));
            if (moved.length) {
              const operation = await this.mutation(boxId, moved.map(row => row.id), { folder: "inbox" });
              undo.push(() => this.client.undo(operation.id, this.requestOptions()).then(operation => this.settled(operation)));
            }
          }
          // Unified local actions affect only memberships represented by this view.
          for (const [boxId, ids] of this.mailboxTargets(mail, true)) for (const id of ids) {
            const row = await this.client.mailboxMessage(boxId, id, this.requestOptions());
            const before = row.memberships.find(state => state.mailboxId === boxId)!;
            const saved = await this.client.setMailboxState(boxId, id, action === "remind" ? { snoozedUntil: value ?? null } : { done: action === "done", snoozedUntil: null }, before.revision, this.requestOptions());
            undo.push(() => this.client.setMailboxState(boxId, id, { done: before.done, snoozedUntil: before.snoozedUntil }, saved.revision, this.requestOptions()));
          }
        }
      }
    } catch (error) {
      let incomplete = false;
      for (const reverse of [...undo].reverse()) try { await reverse(); } catch { incomplete = true; }
      if (incomplete) throw new Error("The action did not finish, and some changes could not be restored. Refresh the inbox before retrying.");
      throw error;
    }
    return async () => { await this.act("undo", async () => { for (const reverse of [...undo].reverse()) await reverse(); }); };
  });

  setLabel = (selected: Mail[], name: string, remove: boolean) => this.act("label", async () => {
    const operations: Operation[] = [];
    const plans: Array<{ boxId: string; ids: string[]; changes: Changes }> = [];
    for (const mail of selected) {
      if (mail.operationId) throw new Error("Queued sends cannot be relabeled.");
      for (const [boxId, ids] of this.mailboxTargets(mail)) {
        const { source } = this.account(boxId);
        const local = this.labels.find(label => label.accountId === source.id && label.name === name);
        const native = this.folders.get(source.id)?.find(folder => folder.kind === "label" && folder.name === name);
        if (!local && !native) throw new Error("This label is not available in every selected source. Choose an individual mailbox to manage its labels.");
        const changes: Changes = local ? (remove ? { removeLabelIds: [local.id] } : { addLabelIds: [local.id] }) : (remove ? { removeLabels: [native!.role] } : { addLabels: [native!.role] });
        plans.push({ boxId, ids, changes });
      }
    }
    try { for (const plan of plans) operations.push(await this.mutation(plan.boxId, plan.ids, plan.changes)); }
    catch (error) {
      let incomplete = false;
      for (const operation of [...operations].reverse()) try { await this.settled(await this.client.undo(operation.id, this.requestOptions())); } catch { incomplete = true; }
      if (incomplete) throw new Error("Label changes did not finish, and some changes could not be restored. Refresh before retrying.");
      throw error;
    }
    return async () => { await this.act("undo-label", async () => { for (const operation of operations) await this.settled(await this.client.undo(operation.id, this.requestOptions())); }); };
  });
  createLabel = async (boxId: string, name: string) => { if (boxId === UNIFIED_ACCOUNT) throw new Error("Choose an individual mailbox to create a source label."); const { source } = this.account(boxId); await this.client.createLabel(source.id, name, this.requestOptions()); await this.refresh(); };
  editLabel = async (boxId: string, name: string, value?: string) => {
    if (boxId === UNIFIED_ACCOUNT) throw new Error("Choose an individual mailbox to edit a source label.");
    const { source } = this.account(boxId), label = this.labels.find(label => label.accountId === source.id && label.name === name);
    if (!label) throw new Error("The SDK can only rename or delete local labels, not provider labels.");
    if (value === undefined) await this.client.deleteLabel(label.id, this.requestOptions()); else await this.client.updateLabel(label.id, value, label.revision, this.requestOptions());
    await this.refresh();
  };
  undoSend = async (id: string) => {
    const operation = await this.client.undo(id, this.requestOptions());
    this.operations.set(id, operation);
    if (operation.status === "cancelled") {
      const ref = this.references.find(ref => ref.id === id);
      if (ref) this.submissions.delete(ref.draftId);
      this.sending.delete(id);
      this.rebuild();
    }
    await this.refresh(true);
  };
  setPolicy = async (policy: Partial<Policy>) => {
    const saved = await this.client.setPolicy(policy, this.requestOptions());
    if (this.state.policy?.remoteImages !== saved.remoteImages) {
      this.bodyEpoch++;
      this.details.clear();
    }
    this.publish({ policy: saved });
    this.rebuild();
  };
  setViewPreferences = (input: Omit<InboxViewPreferences, "revision">): Promise<void> => {
    const revision = this.state.viewPreferences?.revision;
    return this.act("inbox-preferences", async () => {
      if (revision === undefined) throw new Error("Inbox preferences are still loading.");
      const viewPreferences = await writeInboxViewPreferences({ ...input, revision }, this.controller.signal);
      this.publish({ viewPreferences }); this.rebuild();
    });
  };
  sync = async (boxId: string) => this.act("sync", async () => {
    const ids = boxId === UNIFIED_ACCOUNT ? this.unifiedMailboxIds() : [boxId];
    const sources = new Set<string>();
    let failed = 0;
    for (const id of ids) {
      const { box } = this.account(id);
      if (box.status !== "active" || sources.has(box.sourceId)) continue;
      sources.add(box.sourceId);
      try { await this.client.syncMailbox(box.id, { folder: "inbox" }, this.requestOptions()); }
      catch (error) { if (this.controller.signal.aborted) throw error; failed++; }
    }
    if (failed) throw new Error(`${failed} ${failed === 1 ? "source could" : "sources could"} not refresh. Cached mail is still available.`);
  });
  retry = async () => {
    try { await this.refresh(); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        try {
          const response = await fetch("/session", { method: "POST", credentials: "include", headers: { "X-Superlocal": "1" }, signal: this.controller.signal });
          if (!response.ok) throw new Error("Sign in through the host application before opening this inbox.");
          this.client.clearCache(); await this.refresh();
        } catch (next) { this.fail(next, "connect"); }
      } else this.fail(error, "retry");
    }
  };
}
