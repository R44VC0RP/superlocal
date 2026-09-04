import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accounts, seedMail, defaultPreferences, type Draft, type Mail } from "../src/data.ts";
import { matchesSearch, splitRuleError } from "../src/mail-search.ts";
import { selectMailView } from "../src/mail-view.ts";
import { classifyAttention, conversationAttention } from "../../shared/mail-attention.ts";
import { AI_TRIAGE_VERSION, type AiDecision, type AiTriageState } from "../../shared/ai-triage.ts";
import { normalizeSplits, attentionSplit } from "../../shared/splits.ts";
import { senderActivity, senderContact, senderConversations, senderHostname, type SenderHistoryMessage } from "../src/sender-context.ts";
import {
  advanceMail,
  appendOutgoing,
  currentAiDecision,
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
      const child = spawn("bun", ["--no-env-file", "test", import.meta.filename, "--test-name-pattern", "SDK-backed optimistic flags", "--timeout", "180000"], {
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
  const originalSend = MockInboxProvider.prototype.send;
  const host = await createMockHost({ dataDir: root, encryptionKey: Buffer.alloc(32, 29).toString("base64"), token: "fictional-optimistic-client-token", allowProviderWrites: true });
  const feedbackDatabase = new Database(":memory:");
  const feedback = createAttentionFeedbackStore(feedbackDatabase, host.inbox, host.owner);
  let stop: (() => void) | undefined;
  let stopReloaded: (() => void) | undefined;
  let providerFailures = 0, providerCalls = 0;
  let changedBodyId: string | undefined, uncertainSend = false;
  let providerGate: Promise<void> | undefined, providerGateAt: number | undefined, releaseProvider: (() => void) | undefined, providerWork: Promise<void> | undefined;
  MockInboxProvider.prototype.mutate = async function (id, changes) {
    providerCalls++;
    if (providerGate && (providerGateAt === undefined || providerCalls >= providerGateAt)) await providerGate;
    if (providerFailures > 0) { providerFailures--; throw new ProviderError("superlocal-mock", "UPSTREAM", "The controlled provider rejected this flag.", { retryable: false }); }
    const message = await originalMutate.call(this, id, changes);
    return message && id === changedBodyId ? { ...message, bodyText: "Fictional changed body from the provider." } : message;
  };
  MockInboxProvider.prototype.send = async function (input) {
    const result = await originalSend.call(this, input);
    if (uncertainSend) throw new ProviderError("superlocal-mock", "NETWORK", "Controlled lost send acknowledgement.", { retryable: false });
    return result;
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
  let deltaGate: Promise<void> | undefined, releaseDelta: (() => void) | undefined, deltaHeld = false;
  let liveEvents = false, readyEvents = 0, mailEvents = 0, inventoryRequests = 0, deltaRequests = 0;
  let gate: Promise<void> | undefined, loseResponses = 0, replayAuthFailures = 0, snapshotFailures = 0, bodyReads = 0, operationReads = 0;
  let unrelatedOperationReads = 0;
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
    const storage = new Map<string, string>([["superlocal:sdk-outbox-references", JSON.stringify([
      { id: "unattached-operation", draftId: "unattached-draft", accountId: "unattached-source", mailboxId: "unattached-box" },
    ])]]);
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
      if (url.pathname === "/v1/events" && !liveEvents) return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Request cancelled", "AbortError"));
        if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      if (/\/mailboxes\/[^/]+\/messages\/[^/]+$/.test(url.pathname)) bodyReads++;
      if (/\/operations\/[^/]+$/.test(url.pathname)) operationReads++;
      if (url.pathname === "/v1/operations/unattached-operation") unrelatedOperationReads++;
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
      if (url.pathname === "/v1/mailbox-snapshot") inventoryRequests++;
      if (url.pathname === "/v1/mailbox-changes") {
        deltaRequests++;
        if (deltaGate && response.ok && !(await response.clone().json()).hasMore) { deltaHeld = true; await deltaGate; init?.signal?.throwIfAborted(); }
      }
      if (url.pathname === "/v1/events" && liveEvents && response.body) {
        let pending = ""; const decoder = new TextDecoder();
        return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = pending.indexOf("\n\n")) !== -1) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2);
            if (frame.includes("event: ready\n")) readyEvents++;
            if (frame.includes("event: mail.changed\n")) mailEvents++;
          }
          controller.enqueue(chunk);
        } })), { status: response.status, headers: response.headers });
      }
      if (url.pathname === "/v1/mailbox-actions" && init?.method === "POST") {
        membershipRequests.push(JSON.parse(String(init.body)));
        if (response.ok && loseMembershipResponses > 0) { loseMembershipResponses--; throw new TypeError("Controlled lost Done response"); }
      }
      if (url.pathname === "/v1/mailbox-snapshot" && response.ok && finalPageGate && !(await response.clone().json()).nextCursor) {
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
    assert.equal(unrelatedOperationReads, 0, "bootstrap does not request another source's saved outbox references");
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
    const precedingBoundaryId = posted.at(-1)!.operation.id;
    await store.refresh(true); await sleep(120); await store.refresh(true);
    gate = new Promise(resolve => { releaseResponse = resolve; });
    const finishingBoundary = store.action([view()], "star");
    void finishingBoundary.catch(() => {});
    const boundaryPostCount = posted.length;
    await until(() => posted.length > boundaryPostCount, "second boundary operation accepted with its response held");
    const boundaryId = posted.at(-1)!.operation.id;
    let boundaryReleased = false;
    const unsubscribe = store.subscribe(() => {
      if (!boundaryReleased) void host.inbox.operation(host.owner, precedingBoundaryId).then(operation => {
        if (operation.status === "succeeded" && !boundaryReleased) { boundaryReleased = true; releaseResponse!(); gate = undefined; }
      });
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

    // Populate the real offline provider/SDK, not a fabricated InboxSnapshot.
    // Only this final stage pays for the large initial scan; individual flag
    // and body interactions must preserve every unrelated Mail reference.
    let largeNativeId = "";
    for (let index = 0; index < 6000; index++) {
      const message = host.store.receive(source, { from: "scale-sender@example.test", to: nativeBoxes[0].email, subject: `Scale fixture ${index}`,
        text: "Fictional large-cache body.", isRead: false, receivedAt: new Date(Date.now() - index * 1000).toISOString() });
      if (!index) largeNativeId = message.id;
    }
    const calendarToday = new Date(); calendarToday.setHours(10, 15, 0, 0);
    const calendarYesterday = new Date(calendarToday); calendarYesterday.setDate(calendarYesterday.getDate() - 1);
    const calendarPreviousYear = new Date(calendarToday); calendarPreviousYear.setFullYear(calendarPreviousYear.getFullYear() - 1);
    for (const [name, time] of [["today", calendarToday], ["yesterday", calendarYesterday], ["year", calendarPreviousYear]] as const) {
      host.store.receive(source, { from: "scale-sender@example.test", to: nativeBoxes[0].email, subject: `Calendar fixture ${name}`, text: "Fictional calendar body.", receivedAt: time.toISOString() });
    }
    for (;;) { if (!(await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 })).hasMore) break; }
    await store.refresh(true);
    assert.ok(store.getSnapshot().mail.length >= 12_000, "large real SDK cache has overlapping projected conversations");
    const calendarView = (name: string) => store.getSnapshot().mail.find(mail => mail.account === primary.id && mail.subject === `Calendar fixture ${name}`)!;
    assert.equal(calendarView("today").date, calendarToday.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    assert.equal(calendarView("today").group, "Today");
    assert.equal(calendarView("yesterday").group, "Yesterday");
    assert.equal(calendarView("year").group, calendarPreviousYear.toLocaleDateString([], { month: "long", year: "numeric" }));
    await store.loadThread(calendarView("today").id);
    const RealDate = Date, tomorrow = new Date(calendarToday); tomorrow.setDate(tomorrow.getDate() + 1);
    try {
      Object.assign(globalThis, { Date: class extends RealDate {
        constructor(value?: string | number | Date) { super(value === undefined ? tomorrow.getTime() : value instanceof RealDate ? value.getTime() : value); }
        static now() { return tomorrow.getTime(); }
      } });
      await store.loadThread(calendarView("today").id);
      assert.equal(calendarView("today").group, "Yesterday", "new calendar day does not retain cached Today label");
      assert.equal(calendarView("yesterday").date, calendarYesterday.toLocaleDateString([], { month: "short", day: "numeric" }));
    } finally { Object.assign(globalThis, { Date: RealDate }); }
    const previousTimezone = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Honolulu";
      await store.loadThread(calendarView("yesterday").id);
      const changedDay = calendarToday.toDateString() === new Date().toDateString();
      assert.equal(calendarView("today").date, changedDay ? calendarToday.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : calendarToday.toLocaleDateString([], { month: "short", day: "numeric" }), "default-timezone changes refresh formatter context");
    } finally { if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone; }
    await store.refresh(true);
    const large = (account = primary.id) => store.getSnapshot().mail.find(mail => mail.account === account && mail.sourceId === source.accountId && mail.subject === "Scale fixture 0")!;
    const unrelated = () => store.getSnapshot().mail.find(mail => mail.account === primary.id && mail.subject === "Scale fixture 1")!;
    const beforeFirstBody = bodyReads, otherBeforeBody = unrelated();
    await Promise.all([store.loadThread(large().id), store.loadThread(large(UNIFIED_ACCOUNT).id)]);
    assert.equal(bodyReads - beforeFirstBody, 1, "canonical body load coalesces individual/Unified openings");
    assert.strictEqual(unrelated(), otherBeforeBody, "body load does not replace unrelated conversations");
    const cachedSnapshot = store.getSnapshot(), beforeCachedReads = bodyReads, cachedStart = performance.now();
    for (let index = 0; index < 30; index++) await store.loadThread(large().id);
    assert.equal(bodyReads, beforeCachedReads, "repeated cached opens perform no body reads");
    assert.strictEqual(store.getSnapshot(), cachedSnapshot, "cached opens do not publish or recreate Mail arrays");
    assert.ok(performance.now() - cachedStart < 250, "thirty cached opens avoid full large-mailbox rendering");

    const pendingReply = await store.newDraft(primary.id, { mode: "reply", mail: large() });
    const queuedReply = await store.submit({ ...pendingReply, body: "<p>Fictional queued reply.</p>" }, new Date(Date.now() + 60_000).toISOString());
    const queuedView = store.getSnapshot().mail.find(mail => mail.operationId === queuedReply.id)!;
    const otherBeforeFlag = unrelated(), historyBeforeFlag = store.getSnapshot().senderHistory, draftsBeforeFlag = store.getSnapshot().drafts;
    const startedFlag = performance.now(), fastRead = store.action([large()], "read");
    assert.equal(large().unread, false, "large-cache read is still synchronously projected before acknowledgement");
    assert.ok(performance.now() - startedFlag < 250, "one read does not synchronously rebuild the entire large cache");
    assert.strictEqual(unrelated(), otherBeforeFlag);
    assert.strictEqual(store.getSnapshot().senderHistory, historyBeforeFlag);
    assert.strictEqual(store.getSnapshot().drafts, draftsBeforeFlag);
    assert.strictEqual(store.getSnapshot().mail.find(mail => mail.operationId === queuedReply.id), queuedView);
    assert.ok(large().messages.some(message => message.pending && message.operationId === queuedReply.id), "scoped flag projection keeps queued replies");
    assert.ok(large(UNIFIED_ACCOUNT).messages.some(message => message.pending && message.operationId === queuedReply.id));
    await fastRead; await host.inbox.runDue(); await store.refresh(true);
    await store.loadThread(large().id);
    assert.equal(bodyReads, beforeCachedReads, "read-only native revision changes reuse immutable body identity");
    await store.action([large()], "star"); await host.inbox.runDue(); await store.refresh(true);
    await store.loadThread(large().id);
    assert.equal(bodyReads, beforeCachedReads, "star-only native revision changes do not hydrate bodies");
    const previousNeighbor = unrelated(); denyFlagRequests = 1;
    await assert.rejects(store.action([large()], "unread"), InboxActionError);
    assert.equal(large().unread, false);
    assert.strictEqual(unrelated(), previousNeighbor, "rejected flag rollback touches only its affected conversation");
    await store.undoSend(queuedReply.id);

    changedBodyId = largeNativeId;
    await store.action([large()], "star"); await host.inbox.runDue(); await store.refresh(true);
    const beforeChangedBody = bodyReads;
    await store.loadThread(large().id);
    assert.equal(bodyReads, beforeChangedBody + 1, "a real changed provider body invalidates the cached body identity");
    assert.equal(large().messages[0].bodyText, "Fictional changed body from the provider.");
    const changedSnapshot = store.getSnapshot(); await store.loadThread(large().id);
    assert.strictEqual(store.getSnapshot(), changedSnapshot);
    changedBodyId = undefined;
    await store.setPolicy({ remoteImages: false, undoSendSeconds: 0 });
    const beforePolicyBody = bodyReads; await store.loadThread(large().id);
    assert.equal(bodyReads, beforePolicyBody + 1, "policy/body epoch change still invalidates loaded presentations");

    const uncertainDraft = await store.newDraft(primary.id, { mode: "reply", mail: large() });
    uncertainSend = true;
    const uncertainOperation = await store.submit({ ...uncertainDraft, body: "<p>Fictional unconfirmed reply.</p>" });
    await host.inbox.runDue(); await store.refresh(true);
    assert.equal((await host.inbox.operation(host.owner, uncertainOperation.id)).status, "uncertain");
    const uncertainFlag = store.action([large()], "star");
    assert.ok(large().messages.some(message => message.operationId === uncertainOperation.id && message.sendStatus === "uncertain"), "targeted rebuild retains unconfirmed reply, never fake Sent");
    assert.ok(large(UNIFIED_ACCOUNT).messages.some(message => message.operationId === uncertainOperation.id && message.sendStatus === "uncertain"));
    await uncertainFlag;
    await host.inbox.runDue(); await store.refresh();

    // Actual SDK SSE wakes an already-running delta reader. No second mail
    // notification is sent after release; the dirty pass must catch this one.
    stop(); liveEvents = true; stop = store.start(); await store.refresh();
    await until(() => readyEvents > 0, "real SDK event stream is connected");

    // Deterministic performance contract: ordinary E/W and their Undo must
    // update their captured memberships without body hydration, native writes,
    // a new inventory, or replacement of unrelated rendered conversations.
    const interactive = () => store.getSnapshot().mail.find(mail => mail.account === UNIFIED_ACCOUNT && mail.sourceId === source.accountId && mail.subject === "Scale fixture 2")!;
    const guardScans = inventoryRequests, guardBodies = bodyReads, guardNativeCalls = providerCalls;
    const guardNeighbor = unrelated(), guardDrafts = store.getSnapshot().drafts;
    const guardUndoDone = await store.action([interactive()], "done");
    assert.ok(interactive().messages.every(message => message.memberships!.every(state => state.done)));
    assert.equal(store.getSnapshot().pending, 0, "Done releases the action queue after its durable receipt");
    await guardUndoDone();
    assert.ok(interactive().messages.every(message => message.memberships!.every(state => !state.done)));
    const guardUndoFeedback = await store.action([interactive()], "not-important");
    assert.ok(interactive().messages.every(message => message.memberships!.every(state => state.done)));
    assert.equal(store.getSnapshot().pending, 0, "W releases the action queue after its durable receipt");
    await guardUndoFeedback();
    await store.retry(); // Drain the real event/metadata path, not just the immediate local projection.
    assert.ok(interactive().messages.every(message => message.memberships!.every(state => !state.done)));
    assert.equal(inventoryRequests, guardScans, "E/W/Undo and their events never restart full-mailbox inventory paging");
    assert.equal(bodyReads, guardBodies, "E/W/Undo never hydrate message bodies over HTTP");
    assert.equal(providerCalls, guardNativeCalls, "mailbox-local workflows never invoke native flag writes");
    assert.strictEqual(unrelated(), guardNeighbor, "E/W/Undo preserve unrelated rendered conversation identity");
    assert.strictEqual(store.getSnapshot().drafts, guardDrafts, "local workflow updates preserve unchanged drafts");
    assert.equal(unrelatedOperationReads, 0, "forced metadata refresh ignores outbox references from unattached sources");
    assert.ok(JSON.parse(storage.get("superlocal:sdk-outbox-references")!).some((ref: { id: string }) => ref.id === "unattached-operation"), "ignoring unrelated references must not delete recovery data");

    deltaGate = new Promise(resolve => { releaseDelta = resolve; }); deltaHeld = false;
    window.dispatchEvent(new Event("focus"));
    await until(() => deltaHeld, "last delta response held after capturing its old head");
    const scansBeforeDelta = inventoryRequests, readsBeforeDelta = deltaRequests, notificationsBefore = mailEvents, stableNeighbor = unrelated();
    const lateNative = host.store.receive(source, { from: "delta-sender@example.test", to: nativeBoxes[0].email, subject: "Delta notification fixture", text: "Fictional incremental arrival." });
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    await until(() => mailEvents > notificationsBefore, "mail notification arrives while delta request is still held");
    releaseDelta!(); deltaGate = undefined;
    await until(() => store.getSnapshot().mail.some(mail => mail.account === primary.id && mail.subject === "Delta notification fixture"), "dirty recheck imports the final arrival without another notification");
    assert.equal(inventoryRequests, scansBeforeDelta, "routine mail event never scans the full inventory");
    assert.ok(deltaRequests > readsBeforeDelta, "reader performs another bounded delta after in-flight notification");
    assert.strictEqual(unrelated(), stableNeighbor, "incremental arrival preserves unaffected Mail identity");
    const incremental = () => store.getSnapshot().mail.find(mail => mail.account === primary.id && mail.subject === "Delta notification fixture")!;
    const deletedId = incremental().messages[0].id;
    host.store.mutate(source, lateNative.id, { deletePermanently: true });
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    await until(() => !store.getSnapshot().mail.some(mail => mail.messages.some(message => message.id === deletedId)), "removing a last message removes its thread from individual and Unified views");
    assert.ok(!store.getSnapshot().senderHistory.some(message => message.id === deletedId), "removed thread also leaves sender history");
    assert.equal(inventoryRequests, scansBeforeDelta);
    const beforeScope = inventoryRequests;
    const currentOverlap = await host.inbox.mailbox(host.owner, overlap.id);
    await host.inbox.updateMailbox(host.owner, overlap.id, { status: "detached" }, currentOverlap.revision);
    await until(() => !store.getSnapshot().accounts.some(account => account.id === overlap.id), "scope change resets from authorized mailbox metadata");
    await until(() => !store.getSnapshot().mail.some(mail => mail.account === overlap.id), "detached view rows disappear after scoped bootstrap");
    assert.ok(inventoryRequests > beforeScope);
    assert.ok(large().messages.length > 0, "another receiving view of the same source remains available");
  } finally {
    releaseResponse?.(); releaseSnapshot?.(); releaseFinalPage?.(); releaseDelta?.(); releaseProvider?.(); stopReloaded?.(); stop?.(); await providerWork;
    MockInboxProvider.prototype.mutate = originalMutate;
    MockInboxProvider.prototype.send = originalSend;
    feedbackDatabase.close(); await host.close(); await fs.rm(root, { recursive: true, force: true });
    globalThis.fetch = originalFetch; console.info = originalInfo; console.warn = originalWarn;
  }
});
test("SDK-backed AI triage preserves opt-in, scoped updates, cached opens, bounded arrival holds and aborted generations", async () => {
  if (!process.versions.bun) {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn("bun", ["--no-env-file", "test", import.meta.filename, "--test-name-pattern", "SDK-backed AI triage", "--timeout", "30000"], {
        env: { ...process.env, INBOX_TEST_LIVE: "false" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject); child.once("close", code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    return;
  }
  const [{ createMockHost }, { InboxStore }, { bindApplicationScope }, fs, { tmpdir }, { join }] = await Promise.all([
    import("../../mock-api/src/host.ts"), import("../src/inbox.ts"), import("../src/application-scope.ts"), import("node:fs/promises"), import("node:os"), import("node:path"),
  ]);
  const root = await fs.mkdtemp(join(tmpdir(), "ai-triage-client-"));
  const originalFetch = globalThis.fetch, originalInfo = console.info, originalWarn = console.warn;
  const globals = ["location", "window", "document", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let host: Awaited<ReturnType<typeof createMockHost>> | undefined, stop: (() => void) | undefined, releaseState: (() => void) | undefined;
  let stateGate: Promise<void> | undefined, gatedStates = 0, bodyReads = 0, inventories = 0, aiRequests = 0, changeRequests = 0;
  let decision: AiDecision | undefined, queuedChange: AiDecision | undefined;
  let aiState: AiTriageState = { configured: false, provider: null, problemCode: null,
    settings: { revision: 1, enabled: false, mode: "preview", model: "fixture-model", mailboxIds: null, personalization: false, readingSignals: false, interests: [] },
    queue: { pending: 0, processing: 0, failed: 0 }, jobs: [], cursor: 0,
    usage: { attempts: 0, completed: 0, failed: 0, reused: 0, unknownUsage: 0, unpriced: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 0, estimatedMinimumUsd: 0, estimatedMaximumUsd: 0 } };
  try {
    console.info = () => {}; console.warn = () => {};
    host = await createMockHost({ dataDir: root, encryptionKey: Buffer.alloc(32, 31).toString("base64"), token: "fictional-ai-triage-client-token-for-tests", allowProviderWrites: true });
    const nativeBox = host.store.mailboxes(host.owner)[0];
    const source = { owner: host.owner, storeId: nativeBox.id, accountId: host.store.link(host.owner, nativeBox.id)!.accountId };
    const native = host.store.receive(source, { from: "ai-fixture@example.test", to: nativeBox.email, subject: "AI client fixture", text: "Fictional incoming request.", isRead: false });
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    const primary = (await host.inbox.mailboxes(host.owner)).find(box => box.sourceId === source.accountId)!;
    const storage = new Map<string, string>();
    Object.assign(globalThis, { location: new URL("http://localhost:41999"), window: new EventTarget(),
      document: { visibilityState: "visible", createElement: () => ({ innerHTML: "", content: { querySelectorAll: () => [] } }) },
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    });
    const binding = bindApplicationScope("a".repeat(64));
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === "/host/config") return Response.json({ mode: "mock", allowProviderWrites: true, providers: [], preferenceScope: "fictional-ai-client" });
      if (url.pathname === "/host/inbox-preferences") return Response.json({ revision: 1, unifiedMode: "all", includedMailboxIds: [], pinnedMailboxIds: [] });
      if (url.pathname === "/host/split-preferences") return Response.json({ ...normalizeSplits({}), revision: 1 });
      if (url.pathname === "/host/attention-feedback") return Response.json([]);
      if (url.pathname.startsWith("/host/ai-triage")) {
        aiRequests++;
        assert.equal(new Headers(init?.headers).get("X-Superlocal-Scope"), binding.scope, "AI transport carries the store's immutable owner fence");
        if (url.pathname === "/host/ai-triage") {
          const value = structuredClone(aiState);
          if (stateGate) { gatedStates++; await stateGate; }
          return Response.json(value); // Deliberately ignore abort; the real scoped transport must fence late responses.
        }
        if (url.pathname.endsWith("/settings")) {
          aiState = { ...aiState, settings: { ...JSON.parse(String(init?.body)), revision: aiState.settings.revision + 1 } };
          return Response.json(aiState);
        }
        if (url.pathname.endsWith("/changes")) {
          changeRequests++;
          const decisions = queuedChange ? [queuedChange] : []; queuedChange = undefined;
          return Response.json({ decisions, removed: [], cursor: aiState.cursor, hasMore: false, resetRequired: false });
        }
        if (url.pathname.endsWith("/lookup") || url.pathname.endsWith("/results")) {
          if (url.pathname.endsWith("/lookup")) assert.deepEqual(JSON.parse(String(init?.body)).keys, [{ sourceId: decision!.sourceId, threadId: decision!.threadId }]);
          return Response.json({ decisions: decision ? [decision] : [], removed: [], cursor: aiState.cursor, hasMore: false, resetRequired: false });
        }
        throw new Error(`Unexpected AI endpoint ${url.pathname}`);
      }
      if (/\/mailboxes\/[^/]+\/messages\/[^/]+$/.test(url.pathname)) bodyReads++;
      if (url.pathname === "/v1/mailbox-snapshot") inventories++;
      const headers = new Headers(init?.headers); headers.set("Authorization", "Bearer fictional-ai-triage-client-token-for-tests");
      return host!.fetch(new Request(url, { ...init, headers }));
    }) as typeof fetch;
    const store = new InboxStore(); stop = store.start();
    for (let attempt = 0; attempt < 800 && !store.getSnapshot().loaded; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.getSnapshot().loaded, true, "real SDK fixture loaded");
    await store.retry();
    assert.equal(aiRequests, 0, "a host without the optional AI capability performs no AI bootstrap requests");
    const selected = store.getSnapshot().mail.find(mail => mail.account === primary.id && mail.subject === "AI client fixture")!;
    assert.ok(selected?.sourceId && selected.sdkThreadId && selected.messages[0].bodyRevision);
    const keys = [{ sourceId: selected.sourceId, threadId: selected.sdkThreadId }];
    const baselineCategory = conversationAttention(selected);
    assert.equal(baselineCategory, "Important");
    assert.equal(selected.aiHoldUntil, undefined, "startup mail never waits for AI");
    decision = { ...keys[0], revision: 1, settingsRevision: 1, state: "ready", mailboxIds: [primary.id], messageIds: selected.messages.map(message => message.id),
      contextVersions: selected.messages.map(message => ({ messageId: message.id, bodyRevision: message.bodyRevision! })), latestMessageId: selected.messages.at(-1)!.id,
      inputHash: "fictional-input", model: aiState.settings.model, schemaVersion: AI_TRIAGE_VERSION, updatedAt: new Date().toISOString(), holdUntil: null,
      assessment: { type: "notification", response: "not_needed", actions: [], urgency: "routine", deadline: null, topics: [], risk: "none_observed", certainty: "clear", reason: "Fictional assessment", evidence: [] },
      score: { category: "Other", score: 10, reasons: [], contributions: [], version: "fixture" }, override: null, problemCode: null };
    for (const [configured, enabled] of [[false, true], [true, false]]) {
      aiState = { ...aiState, configured, settings: { ...aiState.settings, revision: aiState.settings.revision + 1, enabled, mode: "apply" } };
      await store.ai.state(); await store.ai.lookup(keys);
      const unchanged = store.getSnapshot().mail.find(mail => mail.id === selected.id)!;
      assert.equal(conversationAttention(unchanged), baselineCategory, `configured=${configured}, enabled=${enabled} does not sort`);
      assert.equal(unchanged.triage, undefined);
      assert.equal(unchanged.aiHoldUntil, undefined);
      const subject = `AI inactive arrival ${configured}:${enabled}`;
      host.store.receive(source, { from: "inactive-ai@example.test", to: nativeBox.email, subject, text: "Fictional arrival without enabled, configured AI." });
      await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
      await store.retry();
      const arrival = store.getSnapshot().mail.find(mail => mail.account === primary.id && mail.subject === subject)!;
      assert.ok(arrival);
      assert.equal(arrival.aiHoldUntil, undefined, "disabled or unconfigured AI never holds a new arrival");
      assert.equal(selectMailView([arrival], primary.id, "Inbox", "Important", defaultPreferences, false, "", null).visibleMail.length, 1);
    }
    await store.ai.configure({ ...aiState.settings, enabled: true, mode: "preview" });
    await store.ai.lookup(keys);
    const preview = store.getSnapshot().mail.find(mail => mail.id === selected.id)!;
    assert.equal(preview.triage?.state, "ready");
    assert.equal(preview.attentionCategory, undefined, "explicit preview opt-in does not apply a score");
    assert.equal(conversationAttention(preview), baselineCategory);
    assert.equal(preview.aiHoldUntil, undefined);
    host.store.receive(source, { from: "preview-ai@example.test", to: nativeBox.email, subject: "AI preview arrival", text: "Fictional arrival during preview." });
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    await store.retry();
    const previewArrival = store.getSnapshot().mail.find(mail => mail.account === primary.id && mail.subject === "AI preview arrival")!;
    assert.ok(previewArrival);
    assert.equal(previewArrival.aiHoldUntil, undefined, "preview never holds a new arrival");
    const beforeApply = new Map(store.getSnapshot().mail.map(mail => [mail.id, mail]));
    const beforeAiBodies = bodyReads, beforeAiInventories = inventories;
    await store.ai.configure({ ...aiState.settings, mode: "apply" });
    const applied = store.getSnapshot().mail.find(mail => mail.id === selected.id)!;
    assert.equal(applied.attentionCategory, "Other");
    assert.equal(conversationAttention(applied), "Other");
    assert.notStrictEqual(applied, preview);
    for (const mail of store.getSnapshot().mail) {
      if (mail.sourceId === selected.sourceId && mail.sdkThreadId === selected.sdkThreadId) assert.equal(mail.attentionCategory, "Other", "individual and Unified views receive the same decision");
      else assert.strictEqual(mail, beforeApply.get(mail.id), "AI apply preserves every unrelated conversation identity");
    }
    assert.equal(bodyReads, beforeAiBodies, "AI apply never hydrates SDK bodies");
    assert.equal(inventories, beforeAiInventories, "AI apply never rescans the SDK inventory");
    await store.loadThread(selected.id);
    const cached = store.getSnapshot(), cachedReads = bodyReads;
    for (let index = 0; index < 3; index++) await store.loadThread(selected.id);
    assert.equal(bodyReads, cachedReads);
    assert.strictEqual(store.getSnapshot(), cached, "cached opens publish no replacement model with AI enabled");

    // Only the app-owned AI HTTP boundary is controlled; all mail continues
    // through the actual offline provider, SDK persistence, summaries and deltas.
    decision = { ...decision, revision: 2, score: { ...decision.score!, category: "Important", score: 90 } };
    queuedChange = decision; aiState = { ...aiState, cursor: 2 };
    const beforeChanges = changeRequests, unaffected = new Map(store.getSnapshot().mail.filter(mail => mail.sdkThreadId !== selected.sdkThreadId).map(mail => [mail.id, mail]));
    for (let attempt = 0; attempt < 400 && store.getSnapshot().mail.find(mail => mail.id === selected.id)?.triage?.revision !== 2; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(changeRequests > beforeChanges, "background AI changes transport ran");
    assert.equal(store.getSnapshot().mail.find(mail => mail.id === selected.id)?.attentionCategory, "Important");
    for (const [id, mail] of unaffected) assert.strictEqual(store.getSnapshot().mail.find(value => value.id === id), mail);
    assert.equal(bodyReads, cachedReads);
    assert.equal(inventories, beforeAiInventories);

    host.store.receive(source, { from: "ai-fixture@example.test", to: nativeBox.email, subject: "AI client fixture", threadId: native.threadId,
      text: "Fictional new reply in the open conversation.", isRead: false });
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    await store.retry();
    const replied = store.getSnapshot().mail.find(mail => mail.id === selected.id)!;
    assert.equal(replied.messages.length, selected.messages.length + 1);
    assert.equal(replied.triage?.state, "stale");
    assert.equal(replied.attentionCategory, undefined);
    assert.equal(replied.aiHoldUntil, undefined, "a new reply never hides an already-open conversation");
    assert.equal(selectMailView([replied], primary.id, "Inbox", "Important", defaultPreferences, false, "", null).visibleMail.length, 1);

    host.store.receive(source, { from: "new-ai-fixture@example.test", to: nativeBox.email, subject: "Bounded AI arrival", text: "Fictional new conversation awaiting assessment.", isRead: false });
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    const holdStart = Date.now();
    await store.retry();
    const arriving = store.getSnapshot().mail.find(mail => mail.account === primary.id && mail.subject === "Bounded AI arrival")!;
    assert.ok(arriving.aiHoldUntil && arriving.aiHoldUntil > Date.now(), "a genuinely new Inbox conversation receives a short presentation hold");
    assert.ok(arriving.aiHoldUntil - Date.now() <= 1500);
    assert.ok(arriving.aiHoldUntil >= holdStart);
    const held = selectMailView([arriving], primary.id, "Inbox", "Important", defaultPreferences, false, "", null);
    assert.equal(held.holdingMail, true); assert.equal(held.visibleMail.length, 0);
    assert.equal(selectMailView([arriving], primary.id, "Inbox", "Important", defaultPreferences, true, "", null, new Set([arriving.id])).visibleMail.length, 1);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, arriving.aiHoldUntil! - Date.now())));
    const released = store.getSnapshot().mail.find(mail => mail.id === arriving.id)!;
    const fallback = selectMailView([released], primary.id, "Inbox", "Important", defaultPreferences, false, "", null);
    assert.equal(fallback.holdingMail, false);
    assert.equal(fallback.visibleMail.length, 1, "deadline releases unassessed mail without waiting for inference");
    assert.equal(conversationAttention(released), "Important");
    assert.equal(inventories, beforeAiInventories, "reply and arrival holds use bounded SDK deltas");

    const currentAi = store.getSnapshot().ai;
    aiState = { ...aiState, settings: { ...aiState.settings, revision: 999, model: "obsolete-owner-model" } };
    stateGate = new Promise(resolve => { releaseState = resolve; });
    const obsolete = store.ai.state();
    const rejected = assert.rejects(obsolete, error => error instanceof DOMException && error.name === "AbortError");
    for (let attempt = 0; attempt < 100 && !gatedStates; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(gatedStates);
    stop(); stop = undefined;
    const stopped = store.getSnapshot();
    releaseState!(); stateGate = undefined;
    await rejected;
    assert.strictEqual(store.getSnapshot(), stopped, "a late state response cannot publish into a stopped generation");
    assert.strictEqual(store.getSnapshot().ai, currentAi);
    const ownerBoundStore = new InboxStore(), beforeOwnerLock = ownerBoundStore.getSnapshot();
    const previouslyGated = gatedStates;
    stateGate = new Promise(resolve => { releaseState = resolve; });
    const ownerRead = ownerBoundStore.ai.state();
    const rejectedOwner = assert.rejects(ownerRead, error => error instanceof DOMException && error.name === "AbortError");
    for (let attempt = 0; attempt < 100 && gatedStates === previouslyGated; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(gatedStates > previouslyGated);
    binding.lock();
    releaseState!(); stateGate = undefined;
    await rejectedOwner;
    assert.strictEqual(ownerBoundStore.getSnapshot(), beforeOwnerLock, "late AI state is rejected on owner lock even when the store controller remains active");
    const requestsAtLock = aiRequests;
    await assert.rejects(ownerBoundStore.ai.lookup(keys), error => error instanceof DOMException && error.name === "AbortError");
    assert.equal(aiRequests, requestsAtLock, "a locked owner cannot dispatch AI requests");
  } finally {
    releaseState?.(); stop?.(); await host?.close(); await fs.rm(root, { recursive: true, force: true });
    globalThis.fetch = originalFetch; console.info = originalInfo; console.warn = originalWarn;
    for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
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

test("AI triage fences ready decisions by source, thread, receiving mailbox, confirmed latest message, body and model", () => {
  const mail: Mail = { ...inbox, id: "box:thread", account: "box", mailboxId: "box", sourceId: "source", sdkThreadId: "thread",
    messages: [{ ...inbox.messages[0], id: "earlier", bodyRevision: "body-1", outgoing: false },
      { ...inbox.messages[0], id: "latest", bodyRevision: "body-2", outgoing: false }] };
  const decision: AiDecision = { sourceId: "source", threadId: "thread", revision: 1, settingsRevision: 1, state: "ready", mailboxIds: ["box"],
    messageIds: ["earlier", "latest"], contextVersions: [{ messageId: "earlier", bodyRevision: "body-1" }, { messageId: "latest", bodyRevision: "body-2" }],
    latestMessageId: "latest", inputHash: "fictional-input", model: "fixture-model", schemaVersion: AI_TRIAGE_VERSION, updatedAt: deadline, holdUntil: null,
    assessment: null, score: { category: "Other", score: 10, reasons: [], contributions: [], version: "fixture" },
    override: { category: "Other", inputHash: "fictional-input", at: deadline }, problemCode: null };
  const before = structuredClone({ mail, decision });
  assert.strictEqual(currentAiDecision(mail, decision, decision.model), decision);
  assert.equal(currentAiDecision(mail, undefined, decision.model), undefined);
  for (const changed of [{ sourceId: "other-source" }, { sdkThreadId: "other-thread" }, { mailboxId: "unrelated-box", account: "unrelated-box" }, { operationId: "unsent-operation" }]) {
    assert.equal(currentAiDecision({ ...mail, ...changed }, decision, decision.model), undefined, JSON.stringify(changed));
  }
  for (const [label, candidate, value, model] of [
    ["later confirmed incoming", { ...mail, messages: [...mail.messages, { ...mail.messages[1], id: "new-reply" }] }, decision, decision.model],
    ["later confirmed outgoing", { ...mail, messages: [...mail.messages, { ...mail.messages[1], id: "sent-reply", outgoing: true }] }, decision, decision.model],
    ["earlier context body changed", { ...mail, messages: mail.messages.map((message, index) => index ? message : { ...message, bodyRevision: "changed-body" }) }, decision, decision.model],
    ["latest body changed", { ...mail, messages: mail.messages.map((message, index) => index ? { ...message, bodyRevision: "changed-body" } : message) }, decision, decision.model],
    ["model changed", mail, decision, "different-model"],
    ["older decision latest", mail, { ...decision, latestMessageId: "earlier" }, decision.model],
  ] satisfies Array<[string, Mail, AiDecision, string]>) {
    const stale = currentAiDecision(candidate, value, model);
    assert.equal(stale?.state, "stale", label);
    assert.equal(stale?.score, null, `${label} cannot change sorting`);
    assert.equal(stale?.override, null, `${label} cannot retain an override for the old input`);
  }
  for (const sendStatus of ["pending", "processing", "uncertain"] as const) {
    const pending = { ...mail.messages[1], id: "unsent-reply", outgoing: true, pending: true, sendStatus };
    assert.strictEqual(currentAiDecision({ ...mail, messages: [...mail.messages, pending] }, decision, decision.model), decision, `${sendStatus} is not a confirmed latest reply`);
    assert.equal(currentAiDecision({ ...mail, messages: [...mail.messages, pending] }, { ...decision, latestMessageId: pending.id }, decision.model)?.state, "stale");
  }
  assert.deepEqual({ mail, decision }, before, "validation never mutates shared inputs");
});

test("AI triage unified merging invalidates a score when another receiving view has the newest reply", () => {
  const boxes = ["a", "b"].map(id => ({ id, sourceId: "source", name: id, email: `${id}@example.test`, canSend: true }));
  const decision: AiDecision = { sourceId: "source", threadId: "thread", revision: 1, settingsRevision: 1, state: "ready", mailboxIds: ["a"],
    messageIds: ["old"], contextVersions: [{ messageId: "old", bodyRevision: "old-body" }], latestMessageId: "old", inputHash: "old-input",
    model: "fixture-model", schemaVersion: AI_TRIAGE_VERSION, updatedAt: deadline, holdUntil: null, assessment: null,
    score: { category: "Other", score: 10, reasons: [], contributions: [], version: "fixture" }, override: null, problemCode: null };
  const first: Mail = { ...inbox, id: "a:thread", sourceId: "source", sdkThreadId: "thread", account: "a", mailboxId: "a", locations: ["Inbox"],
    receivedAt: Date.parse(deadline) + 3000, triage: decision, attentionCategory: "Other",
    messages: [{ ...inbox.messages[0], id: "old", bodyRevision: "old-body", receivedAt: deadline, outgoing: false, nativeFolder: "inbox",
      memberships: [{ mailboxId: "a", messageId: "old", revision: 1, done: false, snoozedUntil: null }] }] };
  const later: Mail = { ...first, id: "b:thread", account: "b", mailboxId: "b", receivedAt: Date.parse(deadline) + 2000, triage: undefined, attentionCategory: undefined,
    messages: [{ ...first.messages[0], id: "new-reply", bodyRevision: "new-body", receivedAt: new Date(Date.parse(deadline) + 2000).toISOString(),
      memberships: [{ mailboxId: "b", messageId: "new-reply", revision: 1, done: false, snoozedUntil: null }] }] };
  for (const copies of [[first, later], [later, first]]) {
    const merged = unifiedMail(copies, ["a", "b"], boxes)[0];
    assert.equal(merged.messages.at(-1)?.id, "new-reply");
    assert.equal(merged.triage?.state, "stale");
    assert.equal(merged.triage?.score, null);
    assert.equal(merged.attentionCategory, undefined);
    assert.equal(conversationAttention(merged), "Important", "new unassessed reply is never hidden by a receiving alias's old score");
    assert.equal(currentAiDecision(merged, { ...decision, mailboxIds: ["unrelated-box"] }, decision.model), undefined);
  }
  assert.equal(unifiedMail([first, later], ["a"], boxes)[0].attentionCategory, "Other", "an excluded receiving view does not change the included conversation");
});

test("AI triage categories partition eligible Inbox without overriding Done, snooze, or native Spam", () => {
  const now = Date.now();
  const preferences = { ...defaultPreferences, ...normalizeSplits({ splits: ["Important", "Other"] }) };
  const values: Mail[] = ["eligible", "done", "snoozed", "spam", "outgoing", "pending"].map(kind => ({ ...inbox, id: kind, account: "box", mailboxId: "box",
    sourceId: "source", sdkThreadId: kind, folder: kind === "done" ? "Done" : kind === "snoozed" ? "Reminders" : kind === "spam" ? "Spam" : "Inbox",
    locations: [kind === "done" ? "Done" : kind === "snoozed" ? "Reminders" : kind === "spam" ? "Spam" : "Inbox"], attentionCategory: "Other",
    messages: [{ ...inbox.messages[0], id: kind, outgoing: kind === "outgoing", pending: kind === "pending", nativeFolder: kind === "spam" ? "spam" : "inbox",
      memberships: [{ mailboxId: "box", messageId: kind, revision: 1, done: kind === "done", snoozedUntil: kind === "snoozed" ? new Date(now + 60_000).toISOString() : null }] }] }));
  const other = selectMailView(values, "box", "Inbox", "Other", preferences, false, "", null);
  assert.deepEqual(other.visibleMail.map(mail => mail.id), ["eligible"]);
  assert.deepEqual(other.splitCounts, { Important: 2, Other: 1 });
  for (const value of values.slice(1)) assert.equal(conversationAttention(value, now), "Important", `${value.id} is not eligible for the AI Inbox override`);
  for (const [folder, id] of [["Done", "done"], ["Reminders", "snoozed"], ["Spam", "spam"]]) {
    assert.deepEqual(selectMailView(values, "box", folder, "Other", preferences, false, "", null).visibleMail.map(mail => mail.id), [id]);
  }
  assert.deepEqual(selectMailView(values, "box", "Inbox", "Important", preferences, false, "", null).visibleMail.map(mail => mail.id), ["outgoing", "pending"]);
});

test("AI triage filters distinguish requested replies and actions from the legacy outgoing No reply filter", () => {
  const decision: AiDecision = { sourceId: "source", threadId: "thread", revision: 1, settingsRevision: 1, state: "ready", mailboxIds: ["box"], messageIds: ["message"],
    contextVersions: [{ messageId: "message", bodyRevision: "body" }], latestMessageId: "message", inputHash: "input", model: "fixture-model", schemaVersion: AI_TRIAGE_VERSION,
    updatedAt: deadline, holdUntil: null, assessment: { type: "request", response: "needed", actions: [], urgency: "routine", deadline: null, topics: [], risk: "none_observed", certainty: "clear", reason: "Fictional request", evidence: [] },
    score: { category: "Important", score: 80, reasons: [], contributions: [], version: "fixture" }, override: null, problemCode: null };
  const base: Mail = { ...inbox, account: "box", mailboxId: "box", sourceId: "source", sdkThreadId: "thread", locations: ["Inbox"], triage: decision,
    messages: [{ ...inbox.messages[0], id: "message", bodyRevision: "body", outgoing: false, nativeFolder: "inbox" }] };
  const values: Mail[] = [
    { ...base, id: "needs-reply" },
    { ...base, id: "review", triage: { ...decision, assessment: { ...decision.assessment!, response: "not_needed", actions: ["review"] } } },
    { ...base, id: "deadline", triage: { ...decision, assessment: { ...decision.assessment!, response: "optional", urgency: "deadline", deadline } } },
    { ...base, id: "immediate", triage: { ...decision, assessment: { ...decision.assessment!, response: "unknown", urgency: "immediate" } } },
    { ...base, id: "phishing", triage: { ...decision, assessment: { ...decision.assessment!, response: "not_needed", risk: "phishing_suspected" } } },
    { ...base, id: "spam", triage: { ...decision, assessment: { ...decision.assessment!, response: "not_needed", risk: "spam_suspected" } } },
    { ...base, id: "waiting", messages: [{ ...base.messages[0], outgoing: true }], triage: { ...decision, assessment: { ...decision.assessment!, response: "waiting" } } },
    { ...base, id: "unassessed", triage: undefined },
    ...(["pending", "processing", "failed", "stale"] as const).map(state => ({ ...base, id: state, triage: { ...decision, state } })),
  ];
  for (const [filter, expected] of [
    ["Needs reply", ["needs-reply"]], ["Action requested", ["review"]], ["Time-sensitive", ["deadline", "immediate"]],
    ["Suspicious", ["phishing", "spam"]], ["No reply", ["waiting"]], ["Unassessed", ["unassessed", "pending", "processing", "failed", "stale"]],
  ] as const) {
    assert.deepEqual(selectMailView(values, "box", "All Mail", "Important", defaultPreferences, false, "", filter).visibleMail.map(mail => mail.id), expected, filter);
  }
});

test("AI triage holds only future Inbox presentation, preserves search and other folders, and releases at expiry", () => {
  const now = Date.now(), realNow = Date.now;
  const preferences = { ...defaultPreferences, ...normalizeSplits({ splits: ["Important", "Other"] }) };
  const held: Mail = { ...inbox, id: "held", account: "box", folder: "Inbox", locations: ["Inbox", "Sent"], split: "Important", aiHoldUntil: now + 1500,
    messages: [{ ...inbox.messages[0], nativeFolder: "inbox", outgoing: false }] };
  try {
    Date.now = () => now;
    const hidden = selectMailView([held], "box", "Inbox", "Important", preferences, false, "", null);
    assert.deepEqual(hidden.visibleMail, []);
    assert.equal(hidden.holdingMail, true, "a held new arrival suppresses the ordinary empty Inbox state");
    assert.deepEqual(hidden.splitCounts, { Important: 0, Other: 0 });
    for (const folder of ["Sent", "All Mail"]) {
      const view = selectMailView([held], "box", folder, "Important", preferences, false, "", null);
      assert.deepEqual(view.visibleMail, [held], folder);
      assert.equal(view.holdingMail, false);
    }
    const search = selectMailView([held], "box", "Inbox", "Important", preferences, true, "", null, new Set([held.id]));
    assert.deepEqual(search.visibleMail, [held]);
    assert.equal(search.holdingMail, false);
    Date.now = () => now + 1500;
    const released = selectMailView([held], "box", "Inbox", "Important", preferences, false, "", null);
    assert.deepEqual(released.visibleMail, [held], "the row releases at, not after, the hold deadline");
    assert.equal(released.holdingMail, false);
    assert.equal(released.inboxCount, 1);
    for (const aiHoldUntil of [undefined, 0, now - 1, Number.NaN]) {
      assert.equal(selectMailView([{ ...held, aiHoldUntil }], "box", "Inbox", "Important", preferences, false, "", null).visibleMail.length, 1);
    }
  } finally { Date.now = realNow; }
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
  assert.equal(senderActivity(history, base.from.email, ["box"], null, due + 1001).received, 2, "a reused index still evaluates the current time");
  assert.equal(senderActivity(history, base.from.email, [], null, due + 1001).received, 0, "a reused index does not retain another mailbox scope");
  const changedHistory = history.map(message => message.id === base.id ? { ...message, revision: 2, folder: "trash" } : message);
  assert.equal(senderActivity(changedHistory, base.from.email, ["box"], null, due).received, 0, "new immutable history invalidates indexed facts");
});

test("bounded sender conversations preserve rank and the last receiving copy", () => {
  const conversations: Mail[] = Array.from({ length: 9 }, (_, index) => ({ ...inbox, id: `view-${index}`, sourceId: "source", sdkThreadId: `thread-${index}` }));
  const duplicate = { ...conversations[3], id: "overlapping-view" };
  const wrongSource = { ...conversations[0], id: "other-source", sourceId: "other" };
  const pending = { ...conversations[0], id: "pending", operationId: "pending-operation" };
  const keys = ["source\0missing", "source\0thread-7", "source\0thread-3", "source\0thread-8", "source\0thread-0", "source\0thread-5", "source\0thread-1"];
  const selected = senderConversations([...conversations, wrongSource, duplicate, pending], keys);
  assert.deepEqual(selected.map(mail => mail.id), ["view-7", "overlapping-view", "view-8", "view-0", "view-5"]);
  assert.strictEqual(selected[1], duplicate);
  assert.deepEqual(senderConversations(conversations, []), []);
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
