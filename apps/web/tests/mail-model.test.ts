import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accounts, seedMail, defaultPreferences, type Draft, type Mail } from "../src/data.ts";
import { matchesSearch, splitRuleError } from "../src/mail-search.ts";
import { selectMailView } from "../src/mail-view.ts";
import { classifyAttention, conversationAttention } from "../../shared/mail-attention.ts";
import { normalizeSplits, attentionSplit } from "../../shared/splits.ts";
import { senderActivity, senderContact, senderHostname, type SenderHistoryMessage } from "../src/sender-context.ts";
import {
  advanceMail,
  appendOutgoing,
  inFolder,
  moveMail,
  normalizeSchedule,
  remindMail,
  restoreMail,
  unifiedMail,
  UNIFIED_ACCOUNT,
} from "../src/mail-model.ts";

const inbox = seedMail().find(
  (mail) =>
    mail.account === accounts[0] &&
    mail.folder === "Inbox" &&
    mail.messages.every((message) => message.email !== mail.account),
)!;
const deadline = "2026-10-01T12:00:00.000Z";
test("SDK-backed optimistic flags retain conditional intent through latency, failures and overlapping views", async () => {
  // The ordinary web runner is Node; the actual SDK intentionally uses
  // bun:sqlite. Run this same existing test in an isolated Bun process rather
  // than replacing SDK operations with mock acknowledgements or adding files.
  if (!process.versions.bun) {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn("bun", ["--no-env-file", "test", import.meta.filename, "--test-name-pattern", "SDK-backed optimistic flags", "--timeout", "90000"], {
        env: { ...process.env, INBOX_TEST_LIVE: "false" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject); child.once("close", code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    return;
  }
  const [{ createMockHost }, { MockInboxProvider }, { ProviderError }, { InboxStore, InboxActionError }, fs, { tmpdir }, { join }, { Database }, { createAttentionFeedbackStore }] = await Promise.all([
    import("../../mock-api/src/host.ts"), import("../../mock-api/src/provider.ts"), import("../../../packages/inbox-sdk/server/sdk/types.ts"),
    import("../src/inbox.ts"), import("node:fs/promises"), import("node:os"), import("node:path"), import("bun:sqlite"), import("../../local-host/src/attention-feedback.ts"),
  ]);
  const root = await fs.mkdtemp(join(tmpdir(), "optimistic-flags-"));
  const originalFetch = globalThis.fetch, originalInfo = console.info, originalWarn = console.warn;
  const originalMutate = MockInboxProvider.prototype.mutate;
  const host = await createMockHost({ dataDir: root, encryptionKey: Buffer.alloc(32, 29).toString("base64"), token: "fictional-optimistic-client-token", allowProviderWrites: true });
  const feedbackDatabase = new Database(":memory:");
  const feedback = createAttentionFeedbackStore(feedbackDatabase, host.inbox, host.owner);
  let stop: (() => void) | undefined;
  let stopReloaded: (() => void) | undefined;
  let providerFailures = 0, providerCalls = 0;
  let providerGate: Promise<void> | undefined, providerGateAt: number | undefined, releaseProvider: (() => void) | undefined, providerWork: Promise<void> | undefined;
  MockInboxProvider.prototype.mutate = async function (id, changes) {
    providerCalls++;
    if (providerGate && (providerGateAt === undefined || providerCalls >= providerGateAt)) await providerGate;
    if (providerFailures > 0) { providerFailures--; throw new ProviderError("superlocal-mock", "UPSTREAM", "The controlled provider rejected this flag.", { retryable: false }); }
    return originalMutate.call(this, id, changes);
  };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check: () => boolean, message: string, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (!check() && Date.now() < deadline) await sleep(10);
    assert.ok(check(), message);
  };
  let releaseResponse: (() => void) | undefined;
  let snapshotGate: Promise<void> | undefined, releaseSnapshot: (() => void) | undefined;
  let finalPageGate: Promise<void> | undefined, releaseFinalPage: (() => void) | undefined, finalPageHeld = false;
  let gate: Promise<void> | undefined, loseResponses = 0, replayAuthFailures = 0, snapshotFailures = 0, bodyReads = 0, operationReads = 0;
  const posted: Array<{ input: import("inbox-sdk/types").MutationInput; operation: import("inbox-sdk/types").Operation }> = [];
  const flagRequests: import("inbox-sdk/types").MutationInput[] = [];
  const membershipRequests: Array<Parameters<import("inbox-sdk/types").Inbox["setMailboxStates"]>[1]> = [];
  let loseMembershipResponses = 0;
  const feedbackRequests: Array<{ id: string; targets: import("../src/host.ts").AttentionFeedbackTarget[] }> = [];
  let loseFeedbackResponses = 0, denyFlagRequests = 0;
  try {
    console.info = () => {}; console.warn = () => {};
    const nativeBoxes = host.store.mailboxes(host.owner);
    const scopes = nativeBoxes.slice(0, 2).map(box => ({ owner: host.owner, storeId: box.id, accountId: host.store.link(host.owner, box.id)!.accountId }));
    const source = scopes[0];
    const native = host.store.receive(source, { from: { name: "Fictional sender", email: "sender@example.test" }, to: nativeBoxes[0].email,
      subject: "Optimistic client fixture", text: "Fictional unread message.", isRead: false, rfcMessageId: "<same-fixture@example.test>" });
    host.store.receive(scopes[1], { from: { name: "Fictional sender", email: "sender@example.test" }, to: nativeBoxes[1].email,
      subject: "Optimistic client fixture", text: "Separate source fixture.", isRead: false, rfcMessageId: "<same-fixture@example.test>" });
    for (const scope of scopes) await host.inbox.sync(host.owner, scope.accountId, { folder: "all", lane: "latest", limit: 100 });
    const boxes = await host.inbox.mailboxes(host.owner);
    const primary = boxes.find(box => box.sourceId === source.accountId)!;
    const candidate = (await host.inbox.mailboxCandidates(host.owner, primary.connectionId)).find(candidate => candidate.sourceId === source.accountId && candidate.selector.kind === "domain")!;
    const overlap = await host.inbox.createMailbox(host.owner, { sourceId: source.accountId, name: "Fictional overlap", selector: candidate.selector });
    const storage = new Map<string, string>();
    Object.assign(globalThis, {
      location: new URL("http://localhost:41999"), window: new EventTarget(),
      document: { visibilityState: "visible", createElement: () => ({ innerHTML: "", content: { querySelectorAll: () => [] } }) },
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    });
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === "/host/config") {
        if (snapshotFailures > 0) { snapshotFailures--; throw new TypeError("Controlled snapshot interruption"); }
        if (snapshotGate) await snapshotGate;
        init?.signal?.throwIfAborted();
        return Response.json({ mode: "mock", allowProviderWrites: true, providers: [], preferenceScope: "fictional-optimistic-client" });
      }
      if (url.pathname === "/host/inbox-preferences") return Response.json({ revision: 1, unifiedMode: "all", includedMailboxIds: [], pinnedMailboxIds: [] });
      if (url.pathname === "/host/split-preferences") return Response.json({ ...normalizeSplits({}), revision: 1 });
      if (url.pathname === "/host/attention-feedback") {
        if (init?.method !== "POST") return Response.json(await feedback.list());
        const input = JSON.parse(String(init.body)); feedbackRequests.push(input);
        const event = await feedback.record(input);
        if (loseFeedbackResponses > 0) { loseFeedbackResponses--; throw new TypeError("Controlled lost feedback response"); }
        return Response.json(event);
      }
      if (/^\/host\/attention-feedback\/[^/]+\/undo$/.test(url.pathname)) return Response.json(await feedback.undo(url.pathname.split("/")[3]));
      if (url.pathname === "/v1/events") return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Request cancelled", "AbortError"));
        if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      if (/\/mailboxes\/[^/]+\/messages\/[^/]+$/.test(url.pathname)) bodyReads++;
      if (/\/operations\/[^/]+$/.test(url.pathname)) operationReads++;
      const headers = new Headers(init?.headers); headers.set("Authorization", "Bearer fictional-optimistic-client-token");
      if (url.pathname === "/v1/operations" && init?.method === "POST") {
        flagRequests.push({ ...JSON.parse(String(init.body)), idempotencyKey: headers.get("Idempotency-Key") });
        if (denyFlagRequests > 0) { denyFlagRequests--; headers.set("Authorization", "Bearer deliberately-invalid-fictional-token"); }
        if (!loseResponses && replayAuthFailures > 0) {
          replayAuthFailures--;
          return Response.json({ code: "UNAUTHENTICATED", error: "The controlled session needs to reconnect." }, { status: 401 });
        }
      }
      const response = await host.fetch(new Request(url, { ...init, headers }));
      if (url.pathname === "/v1/mailbox-actions" && init?.method === "POST") {
        membershipRequests.push(JSON.parse(String(init.body)));
        if (response.ok && loseMembershipResponses > 0) { loseMembershipResponses--; throw new TypeError("Controlled lost Done response"); }
      }
      if (url.pathname === "/v1/mailbox-messages" && response.ok && finalPageGate && !(await response.clone().json()).nextCursor) {
        // Freeze a COMPLETE authoritative snapshot before any local command,
        // avoiding a later page's legitimate STALE_CURSOR restart masking it.
        finalPageHeld = true; await finalPageGate; init?.signal?.throwIfAborted();
      }
      if (url.pathname === "/v1/operations" && init?.method === "POST" && response.ok) {
        posted.push({ input: { ...JSON.parse(String(init!.body)), idempotencyKey: headers.get("Idempotency-Key") }, operation: await response.clone().json() });
        const held = gate; if (held) await held;
        init?.signal?.throwIfAborted();
        if (loseResponses > 0) { loseResponses--; throw new TypeError("Controlled lost acknowledgement"); }
      }
      return response;
    }) as typeof fetch;
    const store = new InboxStore(); stop = store.start();
    await until(() => store.getSnapshot().loaded, "real SDK snapshot loaded");
    const view = (boxId = primary.id) => store.getSnapshot().mail.find(mail => mail.account === boxId && mail.sourceId === source.accountId && mail.subject === "Optimistic client fixture")!;
    const other = () => store.getSnapshot().mail.find(mail => mail.account === UNIFIED_ACCOUNT && mail.sourceId === scopes[1].accountId && mail.subject === "Optimistic client fixture")!;
    const selected = view(), id = selected.messages[0].id;
    assert.ok(selected.unread && view(overlap.id).unread && other().unread);

    gate = new Promise(resolve => { releaseResponse = resolve; });
    const first = store.action([selected], "read"), duplicate = store.action([selected], "read");
    assert.equal(view().unread, false, "open/back is read synchronously, before any HTTP acknowledgement");
    assert.equal(view(overlap.id).unread, false, "overlapping receiving view shares the native flag immediately");
    assert.equal(view(UNIFIED_ACCOUNT).unread, false, "Unified shares the native flag immediately");
    assert.equal(other().unread, true, "same subject and RFC ID on another source are isolated");
    await until(() => posted.length === 1, "SDK accepted exactly one coalesced read");
    assert.equal(bodyReads, 0, "native flags need no body or attachment hydration");
    const arrival = host.store.receive(source, { from: "sender@example.test", to: nativeBoxes[0].email, subject: "Optimistic client fixture",
      text: "Fictional later arrival.", isRead: false, threadId: native.threadId });
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    await store.refresh();
    assert.equal(view().messages.find(message => message.id === id)!.isRead, true, "a pre-ack snapshot cannot erase the local intent");
    assert.ok(view().messages.some(message => message.id !== id && message.isRead === false), "later arrival is not implicitly included");
    assert.deepEqual(posted[0].input.messageIds, [id]);
    releaseResponse!(); gate = undefined;
    await Promise.all([first, duplicate]);
    const pendingId = posted[0].operation.id;
    providerGate = new Promise(resolve => { releaseProvider = resolve; });
    providerWork = host.inbox.runDue();
    await until(() => providerCalls > 0, "real SDK worker claimed the controlled slow provider command");
    await sleep(20_250);
    assert.equal((await host.inbox.operation(host.owner, pendingId)).status, "processing", "real durable SDK operation stayed processing beyond the former deadline");
    assert.equal(store.getSnapshot().issues.filter(issue => ["action", "thread"].includes(issue.scope)).length, 0, "accepted pending is quiet, not a conversation error or toast");
    releaseProvider!(); providerGate = undefined; await providerWork; providerWork = undefined;
    await until(() => !store.getSnapshot().refreshing, "settlement refresh idle");
    await store.refresh(true);
    assert.equal(view().messages.find(message => message.id === id)!.isRead, true);

    // All three intentions happen before their predecessor is acknowledged.
    const beforeRapid = posted.length;
    const read = store.action([view()], "read");
    const unread = store.action([view()], "unread");
    const reread = store.action([view()], "unread");
    assert.equal(view().unread, false, "latest rapid opposite wins synchronously");
    await Promise.all([read, unread, reread]);
    assert.equal(posted.length - beforeRapid, 3, "each intentional toggle has one accepted SDK operation");
    await host.inbox.runDue(); await host.inbox.runDue(); await host.inbox.runDue();
    await store.refresh(true);
    assert.equal(view().unread, false, "SDK projection retains final rapid toggle");
    assert.equal(bodyReads, 0);

    // Read -> Back -> W freezes the clicked memberships, then waits only for
    // the read's SDK acknowledgement. Own receipt edges advance its message
    // preconditions; the provider operation itself remains pending throughout.
    await store.action([view()], "unread"); await host.inbox.runDue(); await store.refresh(true);
    gate = new Promise(resolve => { releaseResponse = resolve; });
    const readBeforeW = store.action([view()], "read");
    const wSelection = view(UNIFIED_ACCOUNT);
    const capturedW = wSelection.messages.flatMap(message => message.memberships!.map(membership => ({ sourceId: wSelection.sourceId!, mailboxId: membership.mailboxId,
      messageId: message.id, messageRevision: message.revision!, revision: membership.revision })));
    const wRequestCount = feedbackRequests.length, readRequestCount = posted.length;
    loseFeedbackResponses = 1;
    const recordW = store.action([wSelection], "not-important");
    await until(() => posted.length > readRequestCount, "read before W accepted with acknowledgement held");
    await sleep(20);
    assert.equal(feedbackRequests.length, wRequestCount, "W does not post stale message revisions before relevant flag acknowledgement");
    const readReceipt = posted.at(-1)!.operation;
    releaseResponse!(); gate = undefined; await readBeforeW;
    const undoW = await recordW;
    assert.equal((await host.inbox.operation(host.owner, readReceipt.id)).status, "pending", "W does not wait for provider settlement");
    assert.equal(feedbackRequests.length - wRequestCount, 2, "ambiguous W response replays once");
    assert.deepEqual(feedbackRequests[wRequestCount], feedbackRequests[wRequestCount + 1], "feedback payload and ID remain frozen after its first POST");
    assert.deepEqual(feedbackRequests[wRequestCount].targets.map(target => ({ ...target, messageRevision: undefined })), capturedW.map(target => ({ ...target, messageRevision: undefined })), "W preserves exact clicked membership scope and revisions");
    for (const target of feedbackRequests[wRequestCount].targets) {
      const edge = readReceipt.mutationRevisions!.find(edge => edge.messageId === target.messageId)!;
      assert.equal(target.messageRevision, edge.after, "W advances only the accepted read's exact revision edge");
    }
    assert.ok(view().messages.every(message => message.memberships!.every(state => state.done)));
    assert.ok(view(overlap.id).messages.every(message => message.memberships!.every(state => state.done)));
    await undoW();
    assert.ok(view().messages.every(message => message.memberships!.every(state => !state.done)));
    assert.equal((await feedback.list())[0].status, "retracted");
    await host.inbox.runDue(); await store.refresh(true);

    denyFlagRequests = 1;
    const rejectedRead = store.action([view()], "unread");
    const wAfterRejectedFlag = store.action([view(UNIFIED_ACCOUNT)], "not-important");
    await assert.rejects(rejectedRead, InboxActionError);
    const undoAfterRejectedFlag = await wAfterRejectedFlag;
    assert.ok(view().messages.every(message => message.memberships!.every(state => state.done)), "definite flag rejection does not block local W");
    await undoAfterRejectedFlag();

    // The older read is accepted but its post-ack snapshot is held. A newer
    // unread rejects on a real unrelated SDK revision; it must reveal that
    // older still-active intent, not the raw unread snapshot underneath both.
    await store.action([view()], "unread"); await host.inbox.runDue(); await store.refresh(true);
    assert.equal(view().unread, true);
    snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
    await store.action([view()], "read");
    const newerBase = (await host.inbox.mailboxMessages(host.owner, { mailboxIds: [primary.id], limit: 100 })).items.find(row => row.id === id)!;
    await host.inbox.mutate(host.owner, { messageIds: [id], viaMailboxId: primary.id, changes: { isStarred: true }, ifRevisions: { [id]: newerBase.revision }, idempotencyKey: "external-between-opposites" });
    const rejectedOpposite = store.action([view()], "unread");
    assert.equal(view().unread, true, "newer opposite is initially projected");
    await assert.rejects(rejectedOpposite, InboxActionError);
    assert.equal(view().unread, false, "newer rejection restores older unreflected read intent");
    assert.equal(view(overlap.id).unread, false);
    releaseSnapshot!(); snapshotGate = undefined;
    await host.inbox.runDue(); await host.inbox.runDue(); await store.refresh(true);
    assert.equal(view().unread, false);

    const beforeLost = posted.length, beforeLostRequests = flagRequests.length;
    loseResponses = 1; replayAuthFailures = 1;
    await store.action([view()], "star");
    assert.equal(posted.length - beforeLost, 2, "lost acknowledgement was retried");
    assert.deepEqual(posted[beforeLost].input, posted[beforeLost + 1].input, "lost acknowledgement replays the exact key and payload");
    assert.equal(posted[beforeLost].operation.id, posted[beforeLost + 1].operation.id, "replay did not create a second SDK job");
    assert.equal(flagRequests.length - beforeLostRequests, 3, "an interrupted auth replay is not mistaken for rejection of the original write");
    assert.ok(flagRequests.slice(beforeLostRequests).every(input => JSON.stringify(input) === JSON.stringify(flagRequests[beforeLostRequests])), "even the interrupted auth replay retains the exact request");
    await host.inbox.runDue(); await store.refresh(true);

    // A definite SDK concurrency rejection must preserve unrelated current
    // state, rather than silently rebasing over another writer's change.
    const externalRow = (await host.inbox.mailboxMessages(host.owner, { mailboxIds: [primary.id], limit: 100 })).items.find(row => row.id === id)!;
    await host.inbox.mutate(host.owner, { messageIds: [id], viaMailboxId: primary.id, changes: { isStarred: false }, ifRevisions: { [id]: externalRow.revision }, idempotencyKey: "external-fictional-star" });
    await assert.rejects(store.action([view()], "unread"), InboxActionError);
    await store.refresh(true);
    assert.equal(view().unread, false, "rejected read intent rolls back to latest authoritative flags");
    assert.equal(view().messages.find(message => message.id === id)!.isStarred, false, "unrelated star change survives read rejection");
    assert.equal(store.getSnapshot().issues.filter(issue => issue.scope === "action").length, 1);
    assert.equal(store.getSnapshot().issues.filter(issue => issue.scope === "thread").length, 0);
    await host.inbox.runDue(); await store.refresh(true);

    // A provider failure from an older star cannot overwrite a newer opposite.
    if (view().starred) { await store.action([view()], "star"); await host.inbox.runDue(); await store.refresh(true); }
    await store.action([view()], "star");
    const off = store.action([view()], "star");
    assert.equal(view().starred, false);
    await off;
    const previousIssueCount = store.getSnapshot().issues.find(issue => issue.scope === "action")?.count ?? 0;
    providerFailures = 1;
    await host.inbox.runDue(); await host.inbox.runDue();
    await until(() => store.getSnapshot().issues.some(issue => issue.scope === "action" && issue.count > previousIssueCount), "terminal provider failure reported once in the action scope");
    await store.refresh(true);
    assert.equal(view().starred, false, "older failure cannot restore its stale previous flag");
    assert.equal(view(overlap.id).starred, false);
    assert.equal(store.getSnapshot().issues.filter(issue => issue.scope === "thread").length, 0);

    // Partial success keeps the successful message; no blanket compensation.
    providerFailures = 1;
    await store.action([view()], "star");
    const partialId = posted.at(-1)!.operation.id;
    await host.inbox.runDue();
    assert.equal((await host.inbox.operation(host.owner, partialId)).status, "partial");
    await sleep(5200); await store.refresh(true);
    assert.equal(view().messages.filter(message => message.isStarred).length, 1);
    assert.equal(view().messages.filter(message => !message.isStarred).length, 1);

    if (view().starred) { await store.action([view()], "star"); await host.inbox.runDue(); await store.refresh(true); }
    const undoStar = await store.action([view()], "star");
    await undoStar();
    assert.equal(view().starred, false, "flag Undo is immediate even before the original provider command executes");
    await host.inbox.runDue(); await host.inbox.runDue(); await store.refresh(true);
    assert.equal(view().starred, false);
    const obsoleteUndo = await store.action([view()], "star");
    await store.action([view()], "star");
    await assert.rejects(obsoleteUndo(), /newer change/, "Undo cannot override a newer opposite intent");
    await host.inbox.runDue(); await host.inbox.runDue(); await store.refresh(true);

    // Accepted local membership changes are not failed writes when rereading
    // the snapshot is interrupted; Done and Undo retain their real SDK scope.
    snapshotFailures = 1;
    const undoDone = await store.action([view(UNIFIED_ACCOUNT)], "done");
    await store.retry();
    assert.ok(view().messages.every(message => message.memberships!.every(state => state.done)));
    assert.ok(view(overlap.id).messages.every(message => message.memberships!.every(state => state.done)));
    await undoDone();
    assert.ok(view().messages.every(message => message.memberships!.every(state => !state.done)));

    // Hold a real complete pre-action SDK snapshot for more than two seconds.
    // Durable local receipts, not that scan, must own completion/projection.
    await store.refresh(true);
    finalPageHeld = false; finalPageGate = new Promise(resolve => { releaseFinalPage = resolve; });
    const oldSnapshot = store.refresh();
    await until(() => finalPageHeld, "old complete SDK snapshot is held before local actions");
    const heldAt = performance.now(), bodiesBeforeDone = bodyReads;
    const promptly = async <T>(work: Promise<T>, message: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), 750); })]); }
      finally { clearTimeout(timer); }
    };
    const frozenSelection = view(UNIFIED_ACCOUNT);
    const beforeDoneRequests = membershipRequests.length; loseMembershipResponses = 1;
    const firstDone = await promptly(store.action([frozenSelection], "done"), "Done waited for the full snapshot rather than its durable receipt");
    assert.deepEqual(membershipRequests[beforeDoneRequests], membershipRequests[beforeDoneRequests + 1], "lost Done acknowledgement replays the same durable ID and targets");
    assert.equal(store.getSnapshot().pending, 0, "the next action is not blocked behind the scan");
    assert.equal(view().folder, "Done"); assert.equal(view(overlap.id).folder, "Done"); assert.equal(view(UNIFIED_ACCOUNT).folder, "Done");
    assert.ok(!inFolder(view(), "Inbox"));
    assert.equal(bodyReads, bodiesBeforeDone, "Done performed zero body/ETag hydration reads");
    await promptly(firstDone(), "Done Undo waited for a scan");
    assert.equal(view().folder, "Inbox", "newer Undo receipt projects immediately");
    await assert.rejects(store.action([frozenSelection], "done"), /changed/i, "a stale membership selection conflicts rather than hiding the row");
    assert.equal(view().folder, "Inbox");
    const secondDone = await promptly(store.action([view(UNIFIED_ACCOUNT)], "done"), "a successive Done action was blocked behind a scan");
    assert.equal(view().folder, "Done");
    await promptly(secondDone(), "successive Undo was blocked behind a scan");
    const fastW = await promptly(store.action([view(UNIFIED_ACCOUNT)], "not-important"), "W waited for a full scan");
    assert.equal(view().folder, "Done");
    assert.ok(store.getSnapshot().attentionFeedback.some(event => event.status === "active"), "W is immediately available to durable Undo");
    await promptly(fastW(), "W Undo waited for a full scan");
    assert.equal(view().folder, "Inbox");
    const retainedW = await promptly(store.action([view(UNIFIED_ACCOUNT)], "not-important"), "a successive W action was blocked behind the scan");
    void retainedW;
    const activeW = store.getSnapshot().attentionFeedback.find(event => event.status === "active")!.id;
    assert.equal(view().folder, "Done");
    // A later reply belongs to the thread, not to the already-clicked action.
    const laterReply = host.store.receive(source, { from: "sender@example.test", to: nativeBoxes[0].email, subject: "Optimistic client fixture",
      text: "Fictional arrival after Done acknowledgement.", threadId: native.threadId, isRead: false });
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    await sleep(Math.max(0, 2050 - (performance.now() - heldAt)));
    assert.ok(finalPageGate, "all E/W actions and Undo completed while the old snapshot was still gated");
    releaseFinalPage!(); finalPageGate = undefined; await oldSnapshot;
    assert.equal(view().folder, "Done", "old snapshot cannot resurrect the acknowledged selected messages");
    assert.equal(store.getSnapshot().attentionFeedback.find(event => event.id === activeW)?.status, "active", "old feedback list cannot erase the current action");
    await store.refresh(true);
    assert.equal(view().folder, "Inbox", "fresh later reply legitimately returns this conversation to Inbox");
    const freshRows = (await host.inbox.mailboxMessages(host.owner, { mailboxIds: [primary.id], limit: 100 })).items;
    const latestNative = host.store.message(source, laterReply.id);
    const newCanonical = freshRows.find(row => row.threadId === view().sdkThreadId && row.receivedAt === latestNative.receivedAt && !frozenSelection.messages.some(message => message.id === row.id))!;
    assert.ok(newCanonical && newCanonical.memberships.every(state => !state.done), "later arrival was never implicitly marked Done");

    const reloaded = new InboxStore(); stopReloaded = reloaded.start();
    await until(() => reloaded.getSnapshot().loaded, "reloaded store reads durable W history");
    assert.ok(reloaded.getSnapshot().attentionFeedback.some(event => event.id === activeW && event.status === "active"));
    finalPageHeld = false; finalPageGate = new Promise(resolve => { releaseFinalPage = resolve; });
    const beforeReloadUndo = reloaded.refresh();
    await until(() => finalPageHeld, "reload's old snapshot held before Undo");
    await promptly(reloaded.undoFeedback(activeW), "reloaded W Undo waited for full scan instead of receipt");
    const reloadedView = () => reloaded.getSnapshot().mail.find(mail => mail.id === frozenSelection.id)!;
    assert.ok(reloadedView().messages.every(message => message.memberships!.every(state => !state.done)), "reloaded Undo restores only its exact membership receipt");
    releaseFinalPage!(); finalPageGate = undefined; await beforeReloadUndo;
    assert.ok(reloadedView().messages.every(message => message.memberships!.every(state => !state.done)), "older Done snapshot cannot override newer Undo");
    assert.equal(reloaded.getSnapshot().attentionFeedback.find(event => event.id === activeW)?.status, "retracted");
    stopReloaded(); stopReloaded = undefined; await store.refresh(true);

    // Scheduled sends remain genuinely pending and cancellable, not optimistic
    // flag operations masquerading as delivery; the draft is restored on Undo.
    const draft = await store.newDraft(primary.id, { mode: "new", to: "recipient@example.test", subject: "Fictional scheduled draft" });
    const send = await store.submit({ ...draft, body: "<p>Fictional scheduled content</p>" }, new Date(Date.now() + 60_000).toISOString());
    assert.equal(send.status, "pending");
    assert.ok(store.getSnapshot().mail.some(mail => mail.operationId === send.id && mail.folder === "Scheduled"));
    assert.ok(!store.getSnapshot().mail.some(mail => mail.operationId === send.id && mail.folder === "Sent"));
    await store.undoSend(send.id);
    assert.ok(store.getSnapshot().drafts.some(saved => saved.id === draft.id));

    // Release a second acknowledgement exactly as the previous operation's
    // terminal snapshot publishes. The reconciler may be finishing its last
    // loop; the newly accepted operation must still be polled to its outcome.
    await store.action([view()], "star");
    await store.refresh(true); await sleep(120); await store.refresh(true);
    gate = new Promise(resolve => { releaseResponse = resolve; });
    const finishingBoundary = store.action([view()], "star");
    const boundaryPostCount = posted.length;
    await until(() => posted.length > boundaryPostCount, "second boundary operation accepted with its response held");
    const boundaryId = posted.at(-1)!.operation.id;
    let wasRefreshing = false, boundaryReleased = false;
    const unsubscribe = store.subscribe(() => {
      const refreshing = store.getSnapshot().refreshing;
      if (wasRefreshing && !refreshing && !boundaryReleased) { boundaryReleased = true; releaseResponse!(); gate = undefined; }
      wasRefreshing = refreshing;
    });
    providerGateAt = providerCalls + view().messages.length + 1;
    providerGate = new Promise(resolve => { releaseProvider = resolve; });
    providerWork = host.inbox.runDue();
    await until(() => boundaryReleased, "older operation's terminal refresh releases the new acknowledgement");
    unsubscribe(); await finishingBoundary;
    const boundaryIssueCount = store.getSnapshot().issues.find(issue => issue.scope === "action")?.count ?? 0;
    providerFailures = 1; releaseProvider!(); providerGate = undefined; providerGateAt = undefined;
    await providerWork; providerWork = undefined;
    assert.equal((await host.inbox.operation(host.owner, boundaryId)).status, "partial");
    await until(() => store.getSnapshot().issues.some(issue => issue.scope === "action" && issue.count > boundaryIssueCount), "new acceptance during finalization is reconciled, not stranded");
    await store.refresh(true);

    await store.action([view()], "star");
    const lastAccepted = posted.at(-1)!.operation.id, writesBeforeStop = posted.length;
    assert.equal((await host.inbox.operation(host.owner, lastAccepted)).status, "pending");
    assert.ok(providerCalls > 0 && arrival.id);
    stop(); stop = undefined;
    await sleep(20);
    const readsAfterStop = operationReads;
    await sleep(600);
    assert.equal(operationReads, readsAfterStop, "unmount cancels operation pollers and queued requests");
    assert.equal((await host.inbox.operation(host.owner, lastAccepted)).status, "pending", "unmount does not cancel accepted durable work");
    stop = store.start(); await store.refresh(true);
    assert.equal(posted.length, writesBeforeStop, "remount tracks the existing operation without submitting again");
    await host.inbox.runDue(); await store.refresh(true);
  } finally {
    releaseResponse?.(); releaseSnapshot?.(); releaseFinalPage?.(); releaseProvider?.(); stopReloaded?.(); stop?.(); await providerWork;
    MockInboxProvider.prototype.mutate = originalMutate;
    feedbackDatabase.close(); await host.close(); await fs.rm(root, { recursive: true, force: true });
    globalThis.fetch = originalFetch; console.info = originalInfo; console.warn = originalWarn;
  }
});
test("custom filters implement exact sender addresses, OR, parentheses, negation, and stable cached-only matches", () => {
  const john = { ...inbox, from: "John", email: "john@doe.com", subject: "Planning", messages: [] };
  assert.equal(matchesSearch(john, "(from:john@doe.com OR from:jane@doe.com) subject:Planning", false), true);
  assert.equal(matchesSearch(john, "(from:jane@doe.com OR subject:nope)", false), false);
  assert.equal(matchesSearch(john, "-(from:jane@doe.com OR subject:nope)", false), true);
  assert.equal(matchesSearch({ ...john, email: "john@doe.com.attacker.test" }, "from:john@doe.com"), false);
  assert.equal(matchesSearch({ ...john, from: "john@doe.com", email: "attacker@evil.test" }, "from:john@doe.com"), false);
  assert.equal(matchesSearch({ ...john, email: "different@doe.com" }, "from:doe.com"), true);
  assert.equal(matchesSearch({ ...john, email: "different@notdoe.com" }, "from:doe.com"), false);
  assert.equal(splitRuleError("(from:john@doe.com OR from:jane@doe.com)"), null);
  for (const query of ["(from:john@doe.com", "from:john@doe.com OR", "unknown:value", 'subject:"open', ""]) assert.ok(splitRuleError(query));
  const withBody = { ...john, messages: [{ ...inbox.messages[0], body: "late-body-marker" }] };
  assert.equal(matchesSearch(withBody, "late-body-marker", false), false);
});

test("Important and Other partition eligible unified conversations while custom filters intentionally overlap", () => {
  const other = classifyAttention({ subject: "Weekly digest", preview: "", facts: { version: 1, listId: true, listUnsubscribe: true } });
  const important = classifyAttention({ subject: "Please reply", preview: "" });
  const make = (id: string, sourceId: string, box: string, attention = other): Mail => ({ ...inbox, id: `${box}:${id}`, sourceId, sdkThreadId: id, mailboxId: box, account: box,
    folder: "Inbox", locations: ["Inbox"], split: "Important", email: "john@doe.com", messages: [{ ...inbox.messages[0], id: `${sourceId}:${id}`, email: "john@doe.com", outgoing: false, nativeFolder: "inbox", attention,
      memberships: [{ mailboxId: box, messageId: `${sourceId}:${id}`, revision: 1, done: false, snoozedUntil: null }] }] });
  const copies = [make("one", "source-a", "a"), make("one", "source-a", "b"), make("one", "source-b", "c"), make("two", "source-a", "a", important)];
  const boxes = ["a", "b", "c"].map(id => ({ id, sourceId: id === "c" ? "source-b" : "source-a", name: id, email: `${id}@test.example`, canSend: false }));
  const unified = unifiedMail(copies, ["a", "b", "c"], boxes);
  assert.equal(unified.length, 3);
  const preferences = { ...defaultPreferences, ...normalizeSplits({ splits: ["Focus", "Other", "John"], splitAliases: { Focus: "Important" }, splitRules: { John: "from:john@doe.com" } }) };
  assert.equal(attentionSplit(preferences, "Focus"), "Important");
  const view = (split: string, values = unified) => selectMailView(values, UNIFIED_ACCOUNT, "Inbox", split, preferences, false, "", null);
  assert.deepEqual(view("Focus").splitCounts, { Focus: 1, Other: 2, John: 3 });
  assert.equal(view("Focus").visibleMail.length + view("Other").visibleMail.length, unified.length);
  assert.equal(view("John").visibleMail.length, 3);
  const thread = unified.find(mail => mail.sourceId === "source-a" && mail.sdkThreadId === "one")!;
  const arrival = { ...thread, messages: [...thread.messages, { ...thread.messages[0], id: "new-reply", attention: undefined }] };
  assert.equal(conversationAttention(arrival), "Important");
  assert.equal(view("Other", unified.map(mail => mail.id === thread.id ? arrival : mail)).visibleMail.length, 1);
  const loaded = { ...thread, messages: thread.messages.map(message => ({ ...message, body: "password receipt please reply", loaded: true })) };
  assert.equal(conversationAttention(loaded), "Other");
});

test("seed migration preserves customized names, aliases, filters and ordering", () => {
  assert.deepEqual(normalizeSplits({ splits: ["Important", "Github", "Inbound", "Calendar", "Other"] }).splits, ["Important", "Other"]);
  const authored = normalizeSplits({ splits: ["Important", "Github", "Inbound", "Calendar", "Other", "John"], splitRules: { Github: "from:review@example.test", John: "from:john@doe.com" } });
  assert.deepEqual(authored.splits, ["Important", "Github", "Other", "John"]);
  assert.equal(authored.splitRules.Github, "from:review@example.test");
  const renamed = normalizeSplits({ splits: ["Focus", "My Github", "Other"], splitAliases: { Focus: "Important", "My Github": "Github" } });
  assert.deepEqual(renamed.splits, ["Focus", "My Github", "Other"]);
  assert.equal(renamed.splitRules["My Github"], "from:notifications@github.com");
  const reordered = ["Important", "Calendar", "Github", "Inbound", "Other"];
  assert.deepEqual(normalizeSplits({ splits: reordered }).splits, reordered);
});

const due = Date.parse(deadline);
function reply(mail = inbox): Draft {
  return {
    id: "regression-reply",
    account: mail.account,
    mode: "reply",
    threadId: mail.id,
    to: mail.email,
    cc: "",
    bcc: "",
    subject: `Re: ${mail.subject}`,
    body: "<p>A reply</p>",
    attachments: [],
    updated: due - 1000,
  };
}
function scheduled(mail: Mail | undefined = inbox, when = deadline) {
  return appendOutgoing(mail, reply(mail), {
    sender: "Ryan",
    preview: "A reply",
    when,
    now: due - 1000,
  });
}

test("a reply is found consistently in Sent, sent search, and recipient/sender search", () => {
  const sent = appendOutgoing(inbox, reply(), {
    sender: "Ryan",
    preview: "A reply",
  });
  assert.equal(sent.folder, "Inbox");
  assert.equal(inFolder(sent, "Sent"), true);
  assert.equal(matchesSearch(sent, "in:sent"), true);
  assert.equal(matchesSearch(sent, `to:${inbox.email}`), true);
  assert.equal(matchesSearch(sent, `from:${inbox.account}`), true);
  assert.equal(matchesSearch(sent, "-in:sent"), false);
  assert.equal(matchesSearch(sent, `from:${inbox.email}`), true);
});

test("an unsent scheduled reply does not appear in Sent", () => {
  const pending = scheduled();
  assert.equal(inFolder(pending, "Scheduled"), true);
  assert.equal(inFolder(pending, "Sent"), false);
  assert.equal(matchesSearch(pending, "in:scheduled"), true);
  assert.equal(matchesSearch(pending, "in:sent"), false);
});

for (const folder of ["Inbox", "Done"]) {
  test(`moving scheduled mail to ${folder} does not strand delivery`, () => {
    const moved = moveMail(scheduled(), folder);
    assert.equal(inFolder(moved, "Scheduled"), true);
    const early = [moved];
    assert.equal(advanceMail(early, due - 1), early);
    const delivered = advanceMail(early, due);
    assert.equal(inFolder(delivered[0], "Sent"), true);
    assert.equal(inFolder(delivered[0], "Scheduled"), false);
    assert.equal(delivered[0].folder, folder);
    assert.equal(delivered[0].messages.length, moved.messages.length);
    assert.equal(advanceMail(delivered, due + 60000), delivered);
  });
}

test("a reminder cannot prevent a scheduled message from sending", () => {
  const pending = remindMail(
    scheduled(),
    "2026-10-01T11:00:00.000Z",
    due - 3600000,
  );
  assert.equal(advanceMail([pending], due - 1)[0].unread, pending.unread);
  const delivered = advanceMail([pending], due)[0];
  assert.equal(inFolder(delivered, "Sent"), true);
  assert.equal(inFolder(delivered, "Scheduled"), false);
  assert.equal(delivered.folder, "Inbox");
  assert.equal(delivered.reminder, undefined);
  assert.equal(delivered.unread, true);
});

test("sending immediately does not erase an earlier queued reply", () => {
  const pending = scheduled();
  const sent = appendOutgoing(pending, reply(), {
    sender: "Ryan",
    preview: "Send now",
    now: due - 500,
  });
  assert.equal(inFolder(sent, "Sent"), true);
  assert.equal(inFolder(sent, "Scheduled"), true);
  assert.equal(sent.messages.at(-2)?.scheduledAt, deadline);
  assert.equal(sent.messages.at(-1)?.scheduledAt, undefined);
  const delivered = advanceMail([sent], due)[0];
  assert.equal(delivered.messages.length, inbox.messages.length + 2);
  assert.equal(inFolder(delivered, "Scheduled"), false);
});

test("multiple queued messages deliver at their own deadlines", () => {
  const later = "2026-10-02T12:00:00.000Z";
  const pending = scheduled(scheduled(), later);
  const first = advanceMail([pending], due)[0];
  assert.equal(inFolder(first, "Sent"), true);
  assert.equal(first.scheduled, later);
  assert.equal(
    first.messages.filter((message) => message.scheduledAt).length,
    1,
  );
  const last = advanceMail([first], Date.parse(later))[0];
  assert.equal(inFolder(last, "Scheduled"), false);
  assert.equal(last.messages.length, inbox.messages.length + 2);
});

for (const folder of ["Trash", "Spam"]) {
  test(`${folder} cancels queued sending without deleting the message text`, () => {
    const pending = scheduled();
    const trashed = moveMail(pending, folder);
    assert.equal(trashed.messages.at(-1)?.body, pending.messages.at(-1)?.body);
    assert.equal(trashed.messages.at(-1)?.cancelled, true);
    assert.equal(trashed.scheduled, undefined);
    const restored = moveMail(advanceMail([trashed], due)[0], "Inbox");
    assert.equal(inFolder(restored, "Sent"), false);
    assert.equal(inFolder(restored, "Scheduled"), false);
  });
}

test("previously persisted thread-level schedules remain deliverable", () => {
  const pending = scheduled();
  const legacy: Mail = {
    ...pending,
    folder: "Done",
    messages: pending.messages.map(({ scheduledAt, ...message }) => message),
  };
  const normalized = normalizeSchedule(legacy);
  assert.equal(normalized.messages.at(-1)?.scheduledAt, deadline);
  assert.equal(legacy.messages.at(-1)?.scheduledAt, undefined);
  assert.equal(inFolder(advanceMail([legacy], due)[0], "Sent"), true);
});

test("a new scheduled conversation leaves the Scheduled folder after sending", () => {
  const pending = appendOutgoing(undefined, reply(), {
    sender: "Ryan",
    preview: "New mail",
    when: deadline,
  });
  assert.equal(pending.folder, "Scheduled");
  const sent = advanceMail([pending], due)[0];
  assert.equal(sent.folder, "Sent");
  assert.equal(matchesSearch(sent, "in:sent"), true);
});

test("Undo restores only affected conversations and their pending sends", () => {
  const pending = scheduled();
  const unrelated = { ...inbox, id: "unrelated", unread: true };
  const restored = restoreMail(
    [moveMail(pending, "Trash"), unrelated],
    [pending],
  );
  assert.deepEqual(restored[0], pending);
  assert.equal(restored[1], unrelated);
  assert.equal(inFolder(advanceMail(restored, due)[0], "Sent"), true);
});

test("scheduled mail from another account retains its owner when it delivers", () => {
  const other = { ...reply(), account: accounts[1], threadId: undefined };
  const pending = appendOutgoing(undefined, other, {
    sender: "Ryan",
    preview: "Work mail",
    when: deadline,
  });
  const sent = advanceMail([pending], due)[0];
  assert.equal(sent.account, accounts[1]);
  assert.equal(sent.messages[0].email, accounts[1]);
  assert.equal(inFolder(sent, "Sent"), true);
});

test("a draft cannot be appended to another account's conversation", () => {
  assert.throws(
    () =>
      appendOutgoing(
        inbox,
        { ...reply(), account: accounts[1] },
        { sender: "Ryan", preview: "Wrong account" },
      ),
    /another account/,
  );
  assert.equal(
    inbox.messages.some((message) => message.email === accounts[1]),
    false,
  );
});

for (const folder of ["Trash", "Spam"]) {
  test(`scheduling from ${folder} is rejected rather than silently stranded`, () => {
    const original = moveMail(inbox, folder);
    const draft = reply();
    assert.throws(
      () =>
        appendOutgoing(original, draft, {
          sender: "Ryan",
          preview: "A reply",
          when: deadline,
        }),
      /before scheduling/,
    );
    assert.deepEqual(original.messages, inbox.messages);
    assert.equal(draft.body, "<p>A reply</p>");
  });
}

test("changing From creates a sent conversation owned by the chosen account", () => {
  const draft = { ...reply(), account: accounts[1] };
  const sent = appendOutgoing(undefined, draft, {
    sender: "Ryan",
    preview: "A reply",
  });
  assert.notEqual(sent.id, inbox.id);
  assert.equal(sent.account, accounts[1]);
  assert.equal(sent.messages[0].email, accounts[1]);
  assert.equal(sent.messages[0].to, inbox.email);
  assert.equal(inFolder(sent, "Sent"), true);
});

test("unified mail deduplicates overlapping receiving views without merging different sources", () => {
  const boxes = [
    { id: "all", sourceId: "source-a", name: "All mail", email: "sender@example.test", canSend: true },
    { id: "domain", sourceId: "source-a", name: "Example domain", email: "sender@example.test", canSend: true },
    { id: "other", sourceId: "source-b", name: "Other source", email: "other@example.test", canSend: true },
  ];
  const message = { ...inbox.messages[0], id: "canonical-a", receivedAt: deadline, revision: 1, nativeFolder: "inbox", isRead: false, isStarred: false };
  const first: Mail = { ...inbox, id: "all:thread", account: "all", sourceId: "source-a", mailboxId: "all", sdkThreadId: "native-thread", locations: ["Inbox"],
    messages: [{ ...message, memberships: [{ mailboxId: "all", messageId: message.id, revision: 1, done: false, snoozedUntil: null }] }] };
  const overlapping: Mail = { ...first, id: "domain:thread", account: "domain", mailboxId: "domain",
    messages: [{ ...message, memberships: [{ mailboxId: "domain", messageId: message.id, revision: 1, done: false, snoozedUntil: null }] }] };
  const other: Mail = { ...first, id: "other:thread", account: "other", sourceId: "source-b", mailboxId: "other",
    messages: [{ ...message, id: "canonical-b", memberships: [{ mailboxId: "other", messageId: "canonical-b", revision: 1, done: false, snoozedUntil: null }] }] };
  const original = [first, overlapping, other], before = structuredClone(original);
  const combined = unifiedMail(original, boxes.map(box => box.id), boxes, due);
  assert.equal(combined.length, 2);
  const shared = combined.find(mail => mail.sourceId === "source-a")!;
  assert.equal(shared.account, UNIFIED_ACCOUNT);
  assert.equal(shared.messages.length, 1);
  assert.equal(shared.messages[0].id, "canonical-a");
  assert.deepEqual(new Set(shared.messages[0].memberships?.map(state => state.mailboxId)), new Set(["all", "domain"]));
  assert.equal(combined.find(mail => mail.sourceId === "source-b")!.messages[0].id, "canonical-b");
  assert.deepEqual(original, before);
  assert.equal(unifiedMail([...original].reverse(), boxes.map(box => box.id), boxes, due).find(mail => mail.sourceId === "source-a")!.id, shared.id);
});

test("unified inclusion is explicit and an empty selection never falls back to all mail", () => {
  const box = { id: "one", sourceId: "source", name: "One", email: "one@example.test", canSend: true };
  const mail: Mail = { ...inbox, account: box.id, mailboxId: box.id, sourceId: box.sourceId, sdkThreadId: "thread" };
  assert.deepEqual(unifiedMail([mail], [], [box]), []);
  assert.deepEqual(unifiedMail([mail], ["unrelated"], [box]), []);
  assert.equal(unifiedMail([mail], [box.id], [box]).length, 1);
});

test("unified Done and snooze use all represented memberships, not an arbitrary primary mailbox", () => {
  const boxes = ["a", "b"].map(id => ({ id, sourceId: "source", name: id, email: `${id}@example.test`, canSend: true }));
  const copies: Mail[] = boxes.map(box => ({ ...inbox, id: `${box.id}:thread`, account: box.id, mailboxId: box.id, sourceId: box.sourceId, sdkThreadId: "thread", locations: ["Inbox"],
    messages: [{ ...inbox.messages[0], id: "shared", nativeFolder: "inbox", receivedAt: deadline,
      memberships: [{ mailboxId: box.id, messageId: "shared", revision: 1, done: box.id === "a", snoozedUntil: null }] }] }));
  const mixed = unifiedMail(copies, ["a", "b"], boxes, due)[0];
  assert.equal(inFolder(mixed, "Inbox"), true);
  assert.equal(inFolder(mixed, "Done"), false);
  const done = copies.map(mail => ({ ...mail, messages: mail.messages.map(message => ({ ...message, memberships: message.memberships!.map(state => ({ ...state, done: true })) })) }));
  assert.equal(inFolder(unifiedMail(done, ["a", "b"], boxes, due)[0], "Done"), true);
  assert.equal(inFolder(unifiedMail(done, ["a", "b"], boxes, due)[0], "Inbox"), false);
  const sleeping = copies.map((mail, index) => ({ ...mail, messages: mail.messages.map(message => ({ ...message, memberships: message.memberships!.map(state => ({ ...state, done: false, snoozedUntil: index === 0 ? new Date(due + 60000).toISOString() : null })) })) }));
  const partial = unifiedMail(sleeping, ["a", "b"], boxes, due)[0];
  assert.equal(inFolder(partial, "Inbox"), true);
  assert.equal(inFolder(partial, "Reminders"), true);
  assert.equal(inFolder(unifiedMail(sleeping, ["a"], boxes, due)[0], "Inbox"), false);
});

test("unified rendering retains the newest canonical revision rather than a stale loaded alias", () => {
  const boxes = ["a", "b"].map(id => ({ id, sourceId: "source", name: id, email: `${id}@example.test`, canSend: true }));
  const copies: Mail[] = boxes.map((box, index) => ({ ...inbox, id: `${box.id}:thread`, account: box.id, mailboxId: box.id, sourceId: box.sourceId, sdkThreadId: "thread", unread: index === 1,
    messages: [{ ...inbox.messages[0], id: "shared", nativeFolder: "inbox", receivedAt: deadline, revision: index === 0 ? 2 : 1, loaded: index === 1,
      isRead: index === 0, body: index === 1 ? "stale content" : "", memberships: [{ mailboxId: box.id, messageId: "shared", revision: 1, done: false, snoozedUntil: null }] }] }));
  const combined = unifiedMail(copies, ["a", "b"], boxes, due)[0];
  assert.equal(combined.messages[0].revision, 2);
  assert.equal(combined.messages[0].loaded, false);
  assert.equal(combined.messages[0].body, "");
  assert.equal(combined.unread, false);
});

test("sender levels count reciprocal conversations, not inbound volume or message opens", () => {
  const received: SenderHistoryMessage = { id: "in", sourceId: "source", threadId: "thread", revision: 1,
    from: { name: "Alex", email: "alex@news.example.test" }, to: [{ name: "Me", email: "me@example.test" }], cc: [],
    subject: "An exchange", receivedAt: deadline, folder: "inbox", outgoing: false, mailboxIds: ["box"] };
  const newsletters = Array.from({ length: 100 }, (_, index) => ({ ...received, id: `newsletter-${index}`, threadId: `newsletter-${index}` }));
  assert.equal(senderActivity(newsletters, received.from.email, ["box"], null, due).level, 1);
  assert.equal(senderActivity([], received.from.email, ["box"], null, due).level, 0);
  for (const [count, expected] of [[1, 2], [2, 2], [3, 3], [9, 3], [10, 4], [24, 4], [25, 5]]) {
    const history = Array.from({ length: count }, (_, index) => [
      { ...received, id: `in-${index}`, threadId: `t-${index}` },
      { ...received, id: `out-${index}`, threadId: `t-${index}`, outgoing: true, folder: "sent", from: received.to[0], to: [received.from] },
    ]).flat();
    const before = structuredClone(history);
    const activity = senderActivity(history, "ALEX@NEWS.EXAMPLE.TEST", ["box"], null, due);
    assert.equal(activity.twoWay, count);
    assert.equal(activity.level, expected);
    assert.equal(activity.sent, count);
    assert.equal(activity.received, count);
    assert.equal(activity.weeks.reduce((sum, week) => sum + week.sent + week.received, 0), count * 2);
    assert.deepEqual(history, before);
  }
});

test("sender history deduplicates view overlap, retains newest facts and never invents cross-source exchanges", () => {
  const base: SenderHistoryMessage = { id: "shared", sourceId: "a", threadId: "same-thread-id", revision: 1,
    from: { name: "Alex", email: "alex@example.test" }, to: [{ name: "Me", email: "me@example.test" }], cc: [],
    subject: "Same subject", receivedAt: deadline, folder: "inbox", outgoing: false, mailboxIds: ["all"] };
  const alias = { ...base, mailboxIds: ["address"] };
  const unrelatedReply = { ...base, id: "out", sourceId: "b", mailboxIds: ["other"], outgoing: true, folder: "sent", from: base.to[0], to: [base.from] };
  const activity = senderActivity([base, alias, unrelatedReply], base.from.email, ["all", "address", "other"], null, due);
  assert.equal(activity.received, 1);
  assert.equal(activity.sent, 1);
  assert.equal(activity.conversations, 2);
  assert.equal(activity.twoWay, 0);
  assert.equal(activity.level, 1);
  assert.equal(senderActivity([base, unrelatedReply], base.from.email, [], null, due).conversations, 0);
  const current = { ...alias, revision: 2, folder: "trash" };
  assert.equal(senderActivity([current, base], base.from.email, ["all"], null, due).received, 0);
  assert.equal(senderActivity([base, alias], base.from.email, ["address"], null, due).received, 1);
});

test("sender history matches exact addresses or explicit domain boundaries and excludes unsent or hidden mail", () => {
  const base: SenderHistoryMessage = { id: "a", sourceId: "source", threadId: "t", revision: 1,
    from: { name: "A", email: "a@em1.example.test" }, to: [{ name: "Me", email: "me@example.test" }], cc: [],
    subject: "Mail", receivedAt: deadline, folder: "inbox", outgoing: false, mailboxIds: ["box"] };
  const other = { ...base, id: "b", from: { name: "B", email: "b@example.test" } };
  const unrelated = { ...base, id: "evil", from: { name: "Other", email: "a@notexample.test" } };
  const child = { ...base, id: "child", from: { name: "Child", email: "a@example.test.evil.test" } };
  const excluded = ["trash", "spam", "draft", "drafts", "scheduled"].map(folder => ({ ...base, id: folder, folder }));
  const future = { ...base, id: "future", receivedAt: new Date(due + 1000).toISOString() };
  const invalidDate = { ...base, id: "bad-date", receivedAt: "not a date" };
  const sent = { ...base, id: "cc-sent", outgoing: true, folder: "sent", from: base.to[0], to: [], cc: [base.from] };
  const history = [base, other, unrelated, child, ...excluded, future, invalidDate, sent];
  assert.equal(senderActivity(history, base.from.email, ["box"], null, due).received, 1);
  const grouped = senderActivity(history, base.from.email, ["box"], "example.test", due);
  assert.equal(grouped.received, 2);
  assert.equal(grouped.sent, 1);
  assert.equal(grouped.twoWay, 1);
  assert.equal(grouped.lastSent, due);
});

test("sender selection follows the exact message or outgoing recipient, never the latest self reply", () => {
  const incoming: SenderHistoryMessage = { id: "first", sourceId: "source", threadId: "thread", revision: 1,
    from: { name: "Alex", email: "alex@example.test" }, to: [{ name: "Me", email: "me@example.test" }], cc: [],
    subject: "Mail", receivedAt: deadline, folder: "inbox", outgoing: false, mailboxIds: ["box"] };
  const later = { ...incoming, id: "second", from: { name: "Jamie", email: "jamie@example.test" }, receivedAt: new Date(due + 1000).toISOString() };
  const outgoing = { ...incoming, id: "reply", from: incoming.to[0], to: [incoming.to[0], incoming.from], outgoing: true, folder: "sent", receivedAt: new Date(due + 2000).toISOString() };
  const boxes = [{ id: "box", sourceId: "source", name: "Me", email: incoming.to[0].email, canSend: true }];
  const thread: Mail = { ...inbox, sourceId: "source", messages: [incoming, later, outgoing].map(item => ({ id: item.id, email: item.from.email, from: item.from.name, to: "", date: "Today", body: "" })) };
  const history = [incoming, later, outgoing];
  assert.equal(senderContact(thread, history, boxes).email, later.from.email);
  assert.equal(senderContact(thread, history, boxes, incoming.id).email, incoming.from.email);
  assert.deepEqual(senderContact(thread, history, boxes, outgoing.id), { ...incoming.from, messageId: outgoing.id, role: "recipient" });
  assert.equal(senderContact({ ...thread, messages: [thread.messages[2]] }, history, boxes).role, "recipient");
});

test("sender host extraction normalizes IDNs without accepting URLs, extra addresses or IP literals", () => {
  assert.equal(senderHostname("mail@em1.Cloudflare.com"), "em1.cloudflare.com");
  assert.equal(senderHostname("mail@bücher.de"), "xn--bcher-kva.de");
  assert.equal(senderHostname("mail@em1.cloudflare.com."), "em1.cloudflare.com");
  for (const address of ["a@b@cloudflare.com", "Cloudflare <mail@cloudflare.com>", "a@cloudflare.com/path", "a@cloudflare.com?x=1", "a@cloudflare.com:443", "a@127.0.0.1", "a@[::1]", "a@localhost"]) {
    assert.equal(senderHostname(address), null, address);
  }
});
