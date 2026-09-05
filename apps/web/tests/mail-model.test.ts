import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accounts, seedMail, defaultPreferences, type Draft, type Mail } from "../src/data.ts";
import { matchesSearch, splitRuleError } from "../src/mail-search.ts";
import { selectMailView, selectZeroQueue, zeroEligible, zeroScope, sameZeroScope, zeroStorageKey, zeroReviewVersion, zeroBatchCandidate, normalizeZeroSession, ZERO_QUEUE_LIMIT, type ZeroSession } from "../src/mail-view.ts";
import { classifyAttention, conversationAttention } from "../../shared/mail-attention.ts";
import { AI_INPUT_POLICY_VERSION, AI_TRIAGE_VERSION, aiSortingStatus, type AiDecision, type AiTriageState } from "../../shared/ai-triage.ts";
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

test("guided zero snapshots all active Important work without unread, custom-split or receiving-view leaks", () => {
  const now = Date.parse(deadline);
  const boxes = ["a", "b", "c"].map(id => ({ id, sourceId: id === "c" ? "source-b" : "source-a", sourceGeneration: 1, name: id, email: `${id}@example.test`, canSend: false }));
  const scope = zeroScope(UNIFIED_ACCOUNT, ["b", "a", "c"], boxes);
  const make = (thread: string, box = "a"): Mail => ({ ...inbox, id: `${box}:${thread}`, account: box, mailboxId: box, sourceId: box === "c" ? "source-b" : "source-a", sdkThreadId: thread,
    split: "Custom overlapping filter", folder: "Inbox", locations: ["Inbox"], unread: false,
    messages: [{ ...inbox.messages[0], id: `message:${thread}`, outgoing: false, nativeFolder: "inbox", bodyRevision: "body-1", receivedAt: deadline,
      attention: classifyAttention({ subject: "Please reply", preview: "" }), memberships: [{ mailboxId: box, messageId: `message:${thread}`, revision: 1, done: false, snoozedUntil: null }] }] });
  const read = make("read"), unread = { ...make("unread"), unread: true }, other = make("other"), done = make("done"), sleeping = make("sleeping"), doneSleeping = make("done-sleeping");
  other.messages[0].attention = classifyAttention({ subject: "Weekly digest", preview: "", facts: { version: 1, listId: true, listUnsubscribe: true } });
  done.messages[0].memberships![0].done = true;
  sleeping.messages[0].memberships![0].snoozedUntil = new Date(now + 60000).toISOString();
  doneSleeping.messages[0].memberships![0] = { ...doneSleeping.messages[0].memberships![0], done: true, snoozedUntil: sleeping.messages[0].memberships![0].snoozedUntil };
  const all = unifiedMail([read, make("read", "b"), make("read", "c"), unread, other, done, sleeping, doneSleeping], ["a", "b", "c"], boxes, now);
  const before = structuredClone(all);
  const queue = selectZeroQueue([...all, ...all], scope, now);
  assert.equal(queue.total, 3, "read Important and a same-thread-ID different source count separately; overlapping views do not");
  assert.equal(queue.overflowCount, 0);
  assert.deepEqual(new Set(queue.ids), new Set(all.filter(mail => ["read", "unread"].includes(mail.sdkThreadId!)).map(mail => mail.id)));
  assert.ok(queue.ids.every(id => all.find(mail => mail.id === id)?.messages.some(message => message.memberships?.some(state => !state.done))));
  assert.equal(zeroEligible({ ...all[0], operationId: "queued-send" }, scope, now), false);
  assert.equal(zeroEligible(read, scope, now), false, "individual views cannot enter a Unified snapshot");
  assert.equal(selectZeroQueue(all, zeroScope(UNIFIED_ACCOUNT, [], boxes), now).total, 0, "empty Unified selection never falls back to all mail");
  const expanded = all.find(mail => mail.sourceId === "source-a" && mail.sdkThreadId === "read")!;
  assert.equal(zeroEligible(expanded, zeroScope(UNIFIED_ACCOUNT, ["a"], boxes), now), false, "a projection containing an uncaptured receiving membership is rejected");
  const mixed = unifiedMail([sleeping, make("sleeping", "b")], ["a", "b"], boxes, now)[0];
  assert.equal(zeroEligible(mixed, scope, now), true, "one future reminder cannot hide another awake receiving membership");
  const mixedDone = { ...unifiedMail([done, make("done", "b")], ["a", "b"], boxes, now)[0], locations: ["Inbox", "Done"] };
  assert.equal(zeroEligible(mixedDone, scope, now), true, "an aggregate Done location cannot hide another awake receiving membership");
  assert.deepEqual(selectZeroQueue([mixedDone], scope, now).ids, [mixedDone.id]);
  const mixedFolders = { ...expanded, locations: ["Inbox", "Spam"], messages: [
    { ...expanded.messages[0], id: "old-spam", nativeFolder: "spam", memberships: expanded.messages[0].memberships!.map(state => ({ ...state, messageId: "old-spam" })) },
    ...expanded.messages,
  ] };
  assert.equal(selectMailView([mixedFolders], UNIFIED_ACCOUNT, "Inbox", "Important", defaultPreferences, false, "", null).visibleMail.length, 1);
  assert.deepEqual(selectZeroQueue([mixedFolders], scope, now).ids, [mixedFolders.id], "old hidden history cannot exclude a currently visible Important request");
  assert.equal(zeroEligible({ ...mixedFolders, messages: mixedFolders.messages.map(message => ({ ...message, nativeFolder: "spam" })) }, scope, now), false);
  const fullyDone = { ...unifiedMail([done], ["a"], boxes, now)[0], locations: ["Inbox", "Done"], unread: true };
  assert.equal(zeroEligible(fullyDone, scope, now), false, "fully Done memberships remain excluded even with unread and an Inbox location");
  const held = { ...expanded, aiHoldUntil: Math.max(now, Date.now()) + 60000 };
  assert.equal(zeroEligible(held, scope, now), true, "explicit session start does not wait for automatic inference");
  assert.deepEqual(selectZeroQueue([held], scope, now), { ids: [held.id], total: 1, overflowCount: 0 }, "held Important cannot produce a false zero");
  const presentation = selectMailView([held], UNIFIED_ACCOUNT, "Inbox", "Important", defaultPreferences, false, "", null);
  assert.equal(presentation.holdingMail, true); assert.deepEqual(presentation.visibleMail, [], "normal-screen arrival presentation keeps its existing hold");
  const due = unifiedMail([sleeping], ["a"], boxes, now + 60001)[0];
  assert.equal(zeroEligible(due, scope, now + 60001), true);
  assert.deepEqual(all, before, "snapshot selection never changes mail or membership state");
  const later = unifiedMail([make("later-arrival")], ["a"], boxes, now)[0];
  assert.equal(queue.ids.includes(later.id), false, "a captured queue remains ID-only and does not absorb later arrivals");
});

test("guided zero review identity ignores opens and flag revisions but fences content, replies and receiving state", () => {
  const boxes = ["a", "b"].map(id => ({ id, sourceId: "source", sourceGeneration: 1, name: id, email: `${id}@example.test`, canSend: false }));
  const scope = zeroScope("a", [], boxes);
  const mail: Mail = { ...inbox, id: "a:thread", account: "a", sourceId: "source", sdkThreadId: "thread", locations: ["Inbox"],
    messages: [{ ...inbox.messages[0], id: "message", bodyRevision: "body-1", revision: 1, receivedAt: deadline, nativeFolder: "inbox", outgoing: false,
      memberships: [{ mailboxId: "a", messageId: "message", revision: 1, done: false, snoozedUntil: null }] }] };
  const version = zeroReviewVersion(mail, scope);
  const opened = { ...mail, unread: false, starred: true, opened: "Just now", messages: mail.messages.map(message => ({ ...message, isRead: true, isStarred: true, revision: 9, loaded: true, body: "loaded later", memberships: message.memberships!.map(state => ({ ...state, revision: 8 })) })) };
  assert.equal(zeroReviewVersion(opened, scope), version);
  assert.equal(zeroReviewVersion({ ...mail, messages: [...mail.messages, { ...mail.messages[0], id: "pending-send", pending: true, outgoing: true }] }, scope), version, "pending is not a confirmed reply");
  for (const changed of [
    { ...mail, subject: "Changed subject" },
    { ...mail, messages: [...mail.messages, { ...mail.messages[0], id: "new-reply" }] },
    { ...mail, messages: mail.messages.map(message => ({ ...message, bodyRevision: "body-2" })) },
    { ...mail, messages: mail.messages.map(message => ({ ...message, nativeFolder: "archive" })) },
    { ...mail, messages: mail.messages.map(message => ({ ...message, memberships: message.memberships!.map(state => ({ ...state, done: true })) })) },
    { ...mail, messages: mail.messages.map(message => ({ ...message, memberships: message.memberships!.map(state => ({ ...state, snoozedUntil: deadline })) })) },
  ]) assert.notEqual(zeroReviewVersion(changed, scope), version);
  assert.notEqual(zeroReviewVersion(mail, zeroScope("a", [], boxes.map(box => ({ ...box, sourceGeneration: 2 })))), version);
  assert.notEqual(zeroReviewVersion(mail, zeroScope(UNIFIED_ACCOUNT, ["a", "b"], boxes)), version);
  assert.equal(zeroEligible({ ...mail, messages: [...mail.messages, { ...mail.messages[0], id: "new-reply" }] }, scope, Date.parse(deadline)), true, "changed context remains reviewable rather than becoming completed");
});

test("guided zero batches require current quiet proof and never route around manual choices or uncertainty", () => {
  const now = Date.parse(deadline);
  const scope = zeroScope("box", [], [{ id: "box", sourceId: "source", sourceGeneration: 1, name: "Box", email: "me@example.test", canSend: false }]);
  const ai = { configured: true, settings: { enabled: true, revision: 2, model: "fixture-model", mode: "apply" } } as AiTriageState;
  const decision: AiDecision = { sourceId: "source", threadId: "thread", revision: 1, settingsRevision: 2, state: "ready", mailboxIds: ["box"], messageIds: ["message"],
    contextVersions: [{ messageId: "message", bodyRevision: "body-1" }], latestMessageId: "message", inputHash: "fixture-hash", model: "fixture-model", schemaVersion: AI_TRIAGE_VERSION,
    updatedAt: deadline, holdUntil: null, assessment: { type: "newsletter", response: "not_needed", task: "none", actions: [], urgency: "none", deadline: null, topics: [], risk: "none_observed", certainty: "clear", reason: "Fictional quiet campaign", evidence: [{ messageRef: "m1", field: "type", quote: "Newsletter" }] },
    score: { category: "Important", score: 55, reasons: [], contributions: [], version: "preference-2" }, override: null, problemCode: null };
  const mail: Mail = { ...inbox, id: "box:thread", account: "box", mailboxId: "box", sourceId: "source", sdkThreadId: "thread", locations: ["Inbox"], attentionCategory: "Important", triage: decision,
    messages: [{ ...inbox.messages[0], id: "message", bodyRevision: "body-1", revision: 1, nativeFolder: "inbox", outgoing: false,
      attention: classifyAttention({ subject: "Weekly digest", preview: "", facts: { version: 1, listId: true, listUnsubscribe: true } }),
      memberships: [{ mailboxId: "box", messageId: "message", revision: 1, done: false, snoozedUntil: null }] }] };
  const candidate = zeroBatchCandidate(mail, scope, ai, now)!;
  assert.equal(candidate.basis, "no-outstanding-work", "a legacy Important score does not defeat explicit quiet assessment proof");
  assert.equal(candidate.membershipCount, 1);
  assert.equal(candidate.reviewVersion, zeroReviewVersion(mail, scope));
  const legacy = { ...mail, triage: { ...decision, schemaVersion: "triage-1", assessment: { ...decision.assessment!, task: undefined } } };
  assert.equal(zeroBatchCandidate(legacy, scope, ai, now)?.basis, "quiet-legacy-campaign");
  assert.equal(zeroBatchCandidate({ ...legacy, triage: { ...legacy.triage, assessment: { ...legacy.triage.assessment, evidence: [] } } }, scope, ai, now), null);
  for (const change of [
    { certainty: "insufficient" }, { certainty: "ambiguous" }, { task: "unknown" }, { task: "required" }, { task: "optional" },
    { response: "unknown" }, { response: "waiting" }, { response: "optional" }, { response: "needed" }, { type: "unknown" },
    { actions: ["review"] }, { urgency: "immediate" }, { urgency: "routine" }, { deadline }, { risk: "unknown" }, { risk: "unsolicited" }, { risk: "phishing_suspected" },
  ] satisfies Array<Partial<NonNullable<AiDecision["assessment"]>>>) {
    assert.equal(zeroBatchCandidate({ ...mail, triage: { ...decision, assessment: { ...decision.assessment!, ...change } } }, scope, ai, now), null, JSON.stringify(change));
  }
  for (const state of ["pending", "processing", "failed", "stale"] as const) assert.equal(zeroBatchCandidate({ ...mail, triage: { ...decision, state } }, scope, ai, now), null);
  for (const triage of [
    { ...decision, model: "old-model" }, { ...decision, settingsRevision: 1 }, { ...decision, problemCode: "AI_INSUFFICIENT_CONTEXT" },
    { ...decision, contextVersions: [] }, { ...decision, contextVersions: [{ messageId: "message", bodyRevision: null }] },
    { ...decision, override: { category: "Important" as const, inputHash: "fixture-hash", at: deadline } },
    { ...decision, override: { category: "Other" as const, inputHash: "fixture-hash", at: deadline } },
  ]) assert.equal(zeroBatchCandidate({ ...mail, triage }, scope, ai, now), null);
  for (const category of ["Important", "Other"] as const) {
    const manual = { ...mail, attentionOverride: { sourceId: "source", threadId: "thread", revision: 1, override: { category,
      context: { sourceId: "source", threadId: "thread", sourceGeneration: 1, mailboxIds: ["box"], latestMessageId: "message",
        messages: [{ messageId: "message", revision: 1, bodyRevision: "body-1", memberships: [{ mailboxId: "box", revision: 1 }] }] } } } };
    assert.equal(zeroBatchCandidate(manual, scope, ai, now), null, `explicit ${category} is never suggested again`);
  }
  assert.equal(zeroBatchCandidate(mail, scope, null, now), null);
  assert.equal(zeroBatchCandidate(mail, scope, { ...ai, settings: { ...ai.settings, enabled: false } }, now), null);
  assert.equal(zeroBatchCandidate(mail, scope, { ...ai, settings: { ...ai.settings, mode: "preview" } }, now)?.basis, "no-outstanding-work", "a current preview may inform an explicit user-confirmed suggestion");
  assert.equal(zeroBatchCandidate({ ...mail, triage: undefined }, scope, ai, now), null, "an unexplained applied Important category cannot fall back around missing AI proof");
  assert.equal(zeroBatchCandidate({ ...mail, messages: [...mail.messages, { ...mail.messages[0], id: "pending", pending: true }] }, scope, ai, now), null);
  assert.equal(zeroBatchCandidate({ ...mail, messages: [...mail.messages, { ...mail.messages[0], id: "new-reply" }] }, scope, ai, now), null);
  assert.equal(zeroBatchCandidate({ ...mail, messages: [{ ...mail.messages[0], bodyRevision: "body-2" }] }, scope, ai, now), null);
  assert.equal(zeroBatchCandidate({ ...mail, messages: Array.from({ length: 501 }, (_, index) => ({ ...mail.messages[0], id: `message-${index}`, memberships: [{ ...mail.messages[0].memberships![0], messageId: `message-${index}` }] })) }, scope, ai, now), null, "the action cap counts memberships, not conversations");
});

test("guided zero snapshots and persisted sessions are bounded, immutable-scope and ID-only", () => {
  const now = Date.parse(deadline), boxes = [{ id: "box", sourceId: "source", sourceGeneration: 1, name: "Box", email: "me@example.test", canSend: false }];
  const scope = zeroScope("box", [], boxes);
  const base: Mail = { ...inbox, id: "box:thread", account: "box", sourceId: "source", sdkThreadId: "thread", locations: ["Inbox"], messages: [{ ...inbox.messages[0], id: "message", outgoing: false, nativeFolder: "inbox", memberships: [{ mailboxId: "box", messageId: "message", revision: 1, done: false, snoozedUntil: null }] }] };
  const queue = selectZeroQueue(Array.from({ length: ZERO_QUEUE_LIMIT + 1 }, (_, index) => ({ ...base, id: `box:${index}`, sdkThreadId: String(index) })), scope, now);
  assert.equal(queue.ids.length, ZERO_QUEUE_LIMIT); assert.equal(queue.total, ZERO_QUEUE_LIMIT + 1); assert.equal(queue.overflowCount, 1);
  const saved: ZeroSession = { version: 1, id: "session", scope, startedAt: now, phase: "review", paused: true, remainingIds: ["box:thread"], currentId: "box:thread", initialCount: 2, decidedCount: 1, overflowCount: 0 };
  const restored = normalizeZeroSession({ ...saved, mail: [base], undo: "not-restorable" }, scope)!;
  assert.deepEqual(restored, saved); assert.notStrictEqual(restored.remainingIds, saved.remainingIds);
  assert.equal(Object.hasOwn(restored, "reviewOnlyIds"), false, "older sessions keep the optional field absent");
  const individual = { ...saved, reviewOnlyIds: ["box:thread", "box:already-decided"] };
  const restoredIndividual = normalizeZeroSession(individual, scope)!;
  assert.deepEqual(restoredIndividual, individual, "unchecked conversations retain individual-review intent, including IDs already decided during this session");
  assert.notStrictEqual(restoredIndividual.reviewOnlyIds, individual.reviewOnlyIds);
  assert.deepEqual(normalizeZeroSession({ ...saved, reviewOnlyIds: [] }, scope), { ...saved, reviewOnlyIds: [] });
  assert.equal(normalizeZeroSession({ ...saved, reviewOnlyIds: queue.ids }, scope)?.reviewOnlyIds?.length, ZERO_QUEUE_LIMIT);
  for (const reviewOnlyIds of [undefined, null, "box:thread", {}, [base], [42], [""], ["x".repeat(1025)], ["duplicate", "duplicate"], queue.ids.concat("overflow")]) {
    assert.equal(normalizeZeroSession({ ...saved, reviewOnlyIds }, scope), null, "malformed, duplicate, or oversized individual-review IDs reject the saved session");
  }
  assert.equal(Object.hasOwn(restored, "mail"), false); assert.equal(Object.hasOwn(restored, "undo"), false);
  assert.equal(Object.isFrozen(scope), true); assert.equal(Object.isFrozen(scope.mailboxes), true); assert.equal(Object.isFrozen(scope.mailboxes[0]), true);
  boxes[0].sourceGeneration = 2;
  assert.equal(scope.mailboxes[0].sourceGeneration, 1, "capture never follows mutable account metadata");
  const changed = zeroScope("box", [], boxes);
  assert.equal(sameZeroScope(scope, changed), false); assert.notEqual(zeroStorageKey(scope), zeroStorageKey(changed));
  assert.equal(normalizeZeroSession(saved, changed), null);
  assert.equal(normalizeZeroSession(saved, zeroScope(UNIFIED_ACCOUNT, ["box"], boxes)), null);
  const bootstrap = zeroScope("box", [], []);
  assert.deepEqual(bootstrap, { account: "box", mailboxes: [] }, "a known route with loading accounts cannot throw during ordinary startup");
  assert.deepEqual(zeroScope("missing", [], boxes), { account: "missing", mailboxes: [] });
  assert.equal(selectZeroQueue([base], bootstrap, now).total, 0);
  assert.equal(sameZeroScope(scope, bootstrap), false, "an active session detects unavailable receiving scope and can pause");
  assert.equal(normalizeZeroSession(saved, bootstrap), null);
  const partial = zeroScope(UNIFIED_ACCOUNT, ["box", "removed"], boxes);
  assert.deepEqual(partial.mailboxes, [], "one missing requested mailbox fails the entire scope closed, never silently shrinking it");
  assert.equal(selectZeroQueue([{ ...base, account: UNIFIED_ACCOUNT }], partial, now).total, 0);
  for (const invalid of [
    null, [], { ...saved, version: 2 }, { ...saved, phase: "unknown" }, { ...saved, startedAt: Infinity }, { ...saved, initialCount: -1 }, { ...saved, decidedCount: 3 },
    { ...saved, currentId: "missing" }, { ...saved, remainingIds: ["same", "same"] }, { ...saved, remainingIds: [base] }, { ...saved, remainingIds: [""] },
    { ...saved, initialCount: ZERO_QUEUE_LIMIT + 1 }, { ...saved, remainingIds: queue.ids.concat("overflow") },
    { ...saved, scope: { ...scope, mailboxes: [...scope.mailboxes, ...scope.mailboxes] } },
    { ...saved, scope: { ...scope, mailboxes: [{ ...scope.mailboxes[0], sourceGeneration: NaN }] } },
  ]) assert.equal(normalizeZeroSession(invalid, scope), null);
  assert.equal(zeroStorageKey(zeroScope(UNIFIED_ACCOUNT, ["b", "a"], [
    { ...boxes[0], id: "a" }, { ...boxes[0], id: "b" },
  ])), zeroStorageKey(zeroScope(UNIFIED_ACCOUNT, ["a", "b"], [{ ...boxes[0], id: "a" }, { ...boxes[0], id: "b" }])));
});

for (const scenario of ["scope and sparse reload", "lost acknowledgements and late pages", "snooze receipts before refresh", "durable cleanup reload", "feedback cleanup reload"]) test(`SDK-backed manual categories ${scenario}`, async () => {
  // Isolate owner-lifetime state and exercise the real Bun-backed SDK in either runner.
  if (process.env.INBOX_CATEGORY_TEST_CHILD !== scenario) {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn("bun", ["--no-env-file", "test", import.meta.filename, "--test-name-pattern", `SDK-backed manual categories ${scenario}`, "--timeout", "30000"], {
        env: { ...process.env, INBOX_TEST_LIVE: "false", INBOX_CATEGORY_TEST_CHILD: scenario }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject); child.once("close", code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output); return;
  }
  const [{ createMockHost }, { MockInboxProvider }, { InboxStore, InboxClassificationError }, { InboxError }, { Database }, { createAttentionOverridesStore }, fs, { tmpdir }, { join }] = await Promise.all([
    import("../../mock-api/src/host.ts"), import("../../mock-api/src/provider.ts"), import("../src/inbox.ts"), import("inbox-sdk"), import("bun:sqlite"),
    import("../../local-host/src/attention-overrides.ts"), import("node:fs/promises"), import("node:os"), import("node:path"),
  ]);
  const root = await fs.mkdtemp(join(tmpdir(), "manual-categories-client-"));
  const originalFetch = globalThis.fetch, originalInfo = console.info, originalWarn = console.warn;
  const originals = { getMessage: MockInboxProvider.prototype.getMessage, mutate: MockInboxProvider.prototype.mutate, send: MockInboxProvider.prototype.send };
  const globals = ["location", "window", "document", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const host = await createMockHost({ dataDir: root, encryptionKey: Buffer.alloc(32, 37).toString("base64"), token: "fictional-category-client-token-for-tests", allowProviderWrites: false });
  let database = new Database(join(root, "categories.sqlite"));
  let categories = createAttentionOverridesStore(database, host.inbox, host.owner), stop: (() => void) | undefined;
  const feedback = scenario === "feedback cleanup reload" ? (await import("../../local-host/src/attention-feedback.ts")).createAttentionFeedbackStore(database, host.inbox, host.owner) : null;
  let lostFeedbackAcks = 0, lostFeedbackUndoAcks = 0;
  const feedbackCommands: Array<{ id: string; targets: import("../src/host.ts").AttentionFeedbackTarget[] }> = [], feedbackUndos: string[] = [];
  let bodyReads = 0, providerReads = 0, providerWrites = 0, aiRequests = 0, inventories = 0, lostAcks = 0;
  let holdPage = false, pageHeld = false, releasePage: (() => void) | undefined, returnedPages = 0;
  let holdDelta = false, deltaHeld = false, releaseDelta: (() => void) | undefined, stateWrites = 0, failStateWrite = 0;
  const pages: Array<{ after: number; count: number; cursor: number }> = [];
  const commands: import("../../shared/attention-overrides.ts").CategoryCommand[] = [];
  let commandPlan: import("../src/inbox.ts").InboxCommandRecovery | undefined, lostStateAcks = 0, lostInverseAcks = 0;
  const stateCommands: unknown[] = [], inverseCommands: string[] = [];
  const capturePlan = (plan: import("../src/inbox.ts").InboxCommandRecovery) => { commandPlan = JSON.parse(JSON.stringify(plan)); };
  const until = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 800 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), "category SDK fixture reached the expected state");
  };
  try {
    console.info = () => {}; console.warn = () => {};
    const nativeBox = host.store.mailboxes(host.owner)[0];
    const source = { owner: host.owner, storeId: nativeBox.id, accountId: host.store.link(host.owner, nativeBox.id)!.accountId };
    const native = host.store.receive(source, { from: "category-fixture@example.test", to: nativeBox.email, subject: "Manual category fixture", text: "Fictional unassessed request.", isRead: false });
    host.store.receive(source, { from: "unrelated@example.test", to: nativeBox.email, subject: "Unrelated category fixture", text: "A separate fictional conversation." });
    if (scenario === "durable cleanup reload") for (let i = 0; i < 60; i++) host.store.receive(source, { from: "fixture@example.test", to: nativeBox.email, subject: `Recovery group ${i}`, text: "Fictional recovery content." });
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    const primary = (await host.inbox.mailboxes(host.owner)).find(box => box.sourceId === source.accountId)!;
    const candidate = (await host.inbox.mailboxCandidates(host.owner, primary.connectionId)).find(value => value.sourceId === source.accountId && value.selector.kind === "domain")!;
    const overlap = await host.inbox.createMailbox(host.owner, { sourceId: source.accountId, name: "Category receiving overlap", selector: candidate.selector });
    let preferences = { revision: 1, unifiedMode: "selected", includedMailboxIds: [primary.id], pinnedMailboxIds: [] as string[] };
    const storage = new Map<string, string>();
    Object.assign(globalThis, { location: new URL("http://localhost:41999"), window: new EventTarget(),
      document: { visibilityState: "visible", createElement: () => ({ innerHTML: "", content: { querySelectorAll: () => [] } }) },
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    });
    MockInboxProvider.prototype.getMessage = async function (id) { providerReads++; return originals.getMessage.call(this, id); };
    MockInboxProvider.prototype.mutate = async function (id, changes) { providerWrites++; return originals.mutate.call(this, id, changes); };
    MockInboxProvider.prototype.send = async function (input) { providerWrites++; return originals.send.call(this, input); };
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === "/host/config") return Response.json({ mode: "mock", allowProviderWrites: false, providers: [], preferenceScope: "fictional-category-client", attentionOverrides: true, aiTriage: false });
      if (url.pathname === "/host/inbox-preferences") {
        if (init?.method === "PUT") preferences = { ...JSON.parse(String(init.body)), revision: preferences.revision + 1 };
        return Response.json(preferences);
      }
      if (url.pathname === "/host/split-preferences") return Response.json({ ...normalizeSplits({}), revision: 1 });
      if (url.pathname.startsWith("/host/attention-feedback")) {
        if (!feedback) return Response.json([]);
        try {
          if (url.pathname.endsWith("/undo")) {
            const id = url.pathname.split("/")[3]; feedbackUndos.push(id);
            const event = await feedback.undo(id);
            if (lostFeedbackUndoAcks) { lostFeedbackUndoAcks--; throw new TypeError("Lost feedback Undo acknowledgement"); }
            return Response.json(event);
          }
          if (init?.method === "POST") {
            const input = JSON.parse(String(init.body)); feedbackCommands.push(input);
            assert.ok(commandPlan?.kind === "attention-feedback");
            assert.deepEqual(commandPlan.input, input, "feedback ID and targets are saved before every dispatch");
            const event = await feedback.record(input);
            if (lostFeedbackAcks) { lostFeedbackAcks--; throw new TypeError("Lost feedback acknowledgement"); }
            return Response.json(event);
          }
          return Response.json(await feedback.list());
        } catch (error) {
          if (error instanceof InboxError) return Response.json({ code: error.code, error: error.message }, { status: error.status });
          throw error;
        }
      }
      if (url.pathname.startsWith("/host/ai-triage")) { aiRequests++; throw new Error("Manual categorization must not contact AI."); }
      if (url.pathname.startsWith("/host/attention-overrides")) {
        try {
          if (url.pathname.endsWith("/lookup")) return Response.json(await categories.lookup(JSON.parse(String(init?.body)).keys));
          if (url.pathname.endsWith("/undo")) return Response.json(await categories.undo(url.pathname.split("/")[3]));
          if (init?.method === "POST") {
            const command = JSON.parse(String(init.body)); commands.push(command);
            if (scenario === "durable cleanup reload") {
              assert.equal(commandPlan?.kind, "category");
              assert.deepEqual(commandPlan!.kind === "category" && commandPlan!.groups.find(group => group.input.id === command.id)?.input, command, "every exact category body is persisted before POST");
              if (commands.length === 2) lostAcks = 2;
            }
            const receipt = await categories.classify(command);
            if (lostAcks) { lostAcks--; throw new TypeError("Controlled lost category acknowledgement"); }
            return Response.json(receipt);
          }
          const after = Number(url.searchParams.get("after")), page = await categories.changes(after);
          pages.push({ after, count: page.entries.length, cursor: page.cursor });
          if (holdPage) { holdPage = false; pageHeld = true; await new Promise<void>(resolve => { releasePage = resolve; }); }
          returnedPages++;
          return Response.json(page);
        } catch (error) {
          if (error instanceof InboxError) return Response.json({ code: error.code, error: error.message }, { status: error.status });
          throw error;
        }
      }
      if (url.pathname === "/v1/events") return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Request cancelled", "AbortError"));
        if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      if (/\/mailboxes\/[^/]+\/messages\/[^/]+$/.test(url.pathname)) bodyReads++;
      if (url.pathname === "/v1/mailbox-snapshot") inventories++;
      if ((url.pathname.endsWith("/state") && init?.method === "PATCH" || url.pathname === "/v1/mailbox-actions" && init?.method === "POST") && ++stateWrites === failStateWrite) return Response.json({ code: "CONFLICT", error: "Controlled membership conflict" }, { status: 412 });
      if (scenario === "durable cleanup reload" && url.pathname === "/v1/mailbox-actions" && init?.method === "POST") {
        const command = JSON.parse(String(init.body)); stateCommands.push(command);
        assert.equal(commandPlan?.kind, "mailbox-state");
        assert.deepEqual(commandPlan!.kind === "mailbox-state" && commandPlan!.input, command, "mailbox command is durable before dispatch");
      }
      if (scenario === "durable cleanup reload" && /\/v1\/mailbox-actions\/[^/]+\/undo$/.test(url.pathname)) inverseCommands.push(url.pathname);
      const headers = new Headers(init?.headers); headers.set("Authorization", "Bearer fictional-category-client-token-for-tests");
      const response = await host.fetch(new Request(url, { ...init, headers }));
      if (response.ok && url.pathname === "/v1/mailbox-actions" && init?.method === "POST" && lostStateAcks) { lostStateAcks--; throw new TypeError("Lost mailbox command acknowledgement"); }
      if (response.ok && /\/v1\/mailbox-actions\/[^/]+\/undo$/.test(url.pathname) && lostInverseAcks) { lostInverseAcks--; throw new TypeError("Lost mailbox inverse acknowledgement"); }
      if (url.pathname === "/v1/mailbox-changes" && holdDelta) {
        holdDelta = false; deltaHeld = true;
        await new Promise<void>(resolve => { releaseDelta = resolve; });
      }
      return response;
    }) as typeof fetch;
    let store = new InboxStore(); stop = store.start();
    const current = (account = UNIFIED_ACCOUNT) => store.getSnapshot().mail.find(mail => mail.account === account && mail.subject === "Manual category fixture")!;
    await until(() => store.getSnapshot().loaded && !!current() && returnedPages > 0);
    if (scenario === "feedback cleanup reload") {
      const { validInboxCommandRecovery } = await import("../src/inbox.ts");
      const initial = current();
      lostFeedbackAcks = 2;
      await assert.rejects(store.action([initial], "not-important", undefined, capturePlan), /Lost feedback acknowledgement/);
      assert.ok(commandPlan?.kind === "attention-feedback" && commandPlan.status === "uncertain");
      assert.ok(validInboxCommandRecovery(commandPlan));
      assert.equal(JSON.stringify(commandPlan).includes(initial.subject), false); assert.equal(JSON.stringify(commandPlan).includes("@"), false);
      const livePlan = JSON.parse(JSON.stringify(commandPlan));
      assert.equal(feedbackCommands.length, 2); assert.deepEqual(feedbackCommands[0], feedbackCommands[1]);
      const liveUndo = await store.replayCommand(livePlan, capturePlan);
      assert.deepEqual(feedbackCommands[2], feedbackCommands[0], "the original tab retries the same feedback command after two lost responses");
      assert.deepEqual(liveUndo.receipts, [{ kind: "attention-feedback", id: livePlan.input.id }]);
      const once = await host.inbox.mailboxStateReceipt(host.owner, `attention:${livePlan.input.id}`);
      assert.equal(once.states[0].revision, livePlan.input.targets[0].revision + 1, "one durable Done is applied despite repeated feedback requests");
      assert.equal((await feedback!.list()).length, 1);
      await liveUndo(); await store.retry();
      const captured = current(); lostFeedbackAcks = 2;
      await assert.rejects(store.action([captured], "not-important", undefined, capturePlan), /Lost feedback acknowledgement/);
      const reloadPlan = JSON.parse(JSON.stringify(commandPlan));
      const postCount = feedbackCommands.length;
      host.store.receive(source, { from: "fixture@example.test", to: nativeBox.email, subject: captured.subject, threadId: native.threadId, text: "New reply after frozen feedback." });
      await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
      stop!(); store = new InboxStore(); stop = store.start(); await until(() => store.getSnapshot().loaded && !!current());
      assert.equal(feedbackCommands.length, postCount, "reload does not automatically replay feedback mutations");
      const reloadedUndo = await store.replayCommand(reloadPlan, capturePlan);
      assert.deepEqual(feedbackCommands.at(-1), reloadPlan.input, "explicit reload Retry sends the original ID and body without newer reply targets");
      assert.equal((await feedback!.list()).length, 2, "each user choice creates exactly one feedback event");
      assert.ok(current().messages.some(message => !captured.messages.some(old => old.id === message.id) && message.memberships?.every(state => !state.done)), "feedback recovery never inherits a newer reply");
      lostFeedbackUndoAcks = 1;
      await assert.rejects(reloadedUndo(), /Lost feedback Undo acknowledgement/);
      const inverse = JSON.parse(JSON.stringify(commandPlan));
      stop!(); store = new InboxStore(); stop = store.start(); await until(() => store.getSnapshot().loaded && !!current());
      assert.deepEqual(await store.undoCommand(inverse, capturePlan), [{ kind: "attention-feedback", id: reloadPlan.input.id }]);
      assert.equal(feedbackUndos.at(-1), feedbackUndos.at(-2), "lost inverse acknowledgement reuses the feedback ID");
      assert.ok(current().messages.every(message => message.memberships?.every(state => !state.done)));
      await store.action([current()], "not-important", undefined, capturePlan);
      const stale = JSON.parse(JSON.stringify(commandPlan));
      const receipt = await host.inbox.mailboxStateReceipt(host.owner, `attention:${stale.input.id}`), member = receipt.states[0];
      const newer = await host.inbox.setMailboxState(host.owner, member.mailboxId, member.messageId, { done: false }, member.revision);
      await assert.rejects(store.undoCommand(stale, capturePlan), /Newer mailbox changes were not overwritten/);
      assert.deepEqual((await host.inbox.mailboxMessageSummary(host.owner, member.mailboxId, member.messageId)).memberships.find(state => state.mailboxId === member.mailboxId), newer);
      assert.equal(commandPlan?.kind === "attention-feedback" && commandPlan.undoStatus, "rejected", "a rejected conditional mail inverse cannot credit Zero Undo");
      assert.equal(providerWrites, 0); assert.equal(aiRequests, 0); return;
    }
    if (scenario === "durable cleanup reload") {
      const { validInboxCommandRecovery, InboxRecoveryRejected } = await import("../src/inbox.ts");
      const { ZeroActionRecovery, restoreZeroRecovery } = await import("../src/GuidedZero.tsx");
      const selected = store.getSnapshot().mail.filter(mail => mail.account === UNIFIED_ACCOUNT && mail.subject.startsWith("Recovery group "));
      assert.equal(selected.length, 60);
      await assert.rejects(store.classify(selected, "Other", capturePlan), error => error instanceof InboxClassificationError && error.completed === 50 && !!error.retry);
      assert.equal(commandPlan?.kind, "category");
      const categoryPlan = JSON.parse(JSON.stringify(commandPlan)) as import("../src/inbox.ts").InboxCommandRecovery;
      assert.ok(validInboxCommandRecovery(categoryPlan));
      if (categoryPlan.kind !== "category") throw new Error("Expected category recovery");
      assert.deepEqual(categoryPlan.groups.map(group => group.status), ["accepted", "uncertain"]);
      assert.equal(categoryPlan.groups[0].input.targets.length, 50); assert.equal(categoryPlan.groups[1].input.targets.length, 10);
      assert.equal(JSON.stringify(categoryPlan).includes("Recovery group"), false);
      assert.equal(JSON.stringify(categoryPlan).includes("@"), false);
      const categoryBodies = commands.length;
      stop!(); store = new InboxStore(); stop = store.start();
      await until(() => store.getSnapshot().loaded && !!current());
      assert.equal(commands.length, categoryBodies, "mount/reload never replays saved mutations");
      const reverseCategories = await store.replayCommand(categoryPlan, capturePlan);
      assert.equal(commands.length, categoryBodies + 1, "accepted groups are not re-executed");
      assert.deepEqual(commands.at(-1), categoryPlan.groups[1].input, "unconfirmed category group reuses its original ID and exact captured body after reload");
      assert.equal(reverseCategories.receipts?.length, 2);
      await store.undoCommand(commandPlan!, capturePlan);
      assert.equal(commandPlan!.kind === "category" && commandPlan!.groups.every(group => group.status === "retracted"), true);
      await store.retry();
      // Done was accepted, but both transport acknowledgements were lost.
      const chosen = current(); lostStateAcks = 2;
      await assert.rejects(store.action([chosen], "done", undefined, capturePlan), /Lost mailbox command/);
      const donePlan = JSON.parse(JSON.stringify(commandPlan)) as import("../src/inbox.ts").InboxCommandRecovery;
      assert.equal(donePlan.kind, "mailbox-state");
      assert.deepEqual(stateCommands.at(-1), stateCommands.at(-2), "even immediate ambiguous retries use the same membership-only body");
      const postCount = stateCommands.length;
      host.store.receive(source, { from: "fixture@example.test", to: nativeBox.email, subject: chosen.subject, threadId: native.threadId, text: "New reply after the captured command." });
      await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
      stop!(); store = new InboxStore(); stop = store.start(); await until(() => store.getSnapshot().loaded && !!current());
      const recoveredDone = await store.replayCommand(donePlan, capturePlan);
      assert.equal(stateCommands.length, postCount, "receipt lookup recovers accepted Done without new mutation");
      assert.equal(recoveredDone.receipts?.[0].kind, "mailbox-state");
      assert.ok(current().messages.some(message => !chosen.messages.some(old => old.id === message.id) && message.memberships?.every(state => !state.done)), "later replies never enter recovered targets");
      await store.undoCommand(commandPlan!, capturePlan); await store.retry();
      // Reminder uses the same SDK durable local-state command, not PATCH.
      const at = new Date(Date.now() + 86400000).toISOString(); lostStateAcks = 2;
      await assert.rejects(store.action([current()], "remind", at, capturePlan), /Lost mailbox command/);
      const pendingReminder = JSON.parse(JSON.stringify(commandPlan)) as import("../src/inbox.ts").InboxCommandRecovery;
      assert.equal(pendingReminder.kind, "mailbox-state");
      assert.ok(pendingReminder.kind === "mailbox-state" && pendingReminder.before.length === pendingReminder.input.targets.length);
      stop!(); store = new InboxStore(); stop = store.start(); await until(() => store.getSnapshot().loaded && !!current());
      await store.replayCommand(pendingReminder, capturePlan);
      assert.ok(commandPlan?.kind === "mailbox-state" && commandPlan.accepted.every(state => state.snoozedUntil === at));
      lostInverseAcks = 1;
      await assert.rejects(store.undoCommand(commandPlan!, capturePlan), /Lost mailbox inverse/);
      const pendingInverse = JSON.parse(JSON.stringify(commandPlan)) as import("../src/inbox.ts").InboxCommandRecovery;
      assert.ok(pendingInverse.kind === "mailbox-state" && pendingInverse.undoStatus === "uncertain");
      const inversePath = inverseCommands.at(-1);
      stop!(); store = new InboxStore(); stop = store.start(); await until(() => store.getSnapshot().loaded && !!current());
      const inverses = await store.undoCommand(pendingInverse, capturePlan);
      assert.equal(inverseCommands.at(-1), inversePath, "lost Undo response reuses the server-owned inverse by original receipt ID");
      assert.equal(inverses[0].kind, "mailbox-state");
      assert.ok(current().messages.every(message => message.memberships?.every(state => !state.done && state.snoozedUntil === null)));
      await store.action([current()], "remind", at, capturePlan);
      const stale = JSON.parse(JSON.stringify(commandPlan)) as import("../src/inbox.ts").InboxCommandRecovery;
      if (stale.kind !== "mailbox-state") throw new Error("Expected reminder plan");
      const accepted = stale.accepted[0];
      const later = await host.inbox.setMailboxState(host.owner, accepted.mailboxId, accepted.messageId, { snoozedUntil: null, done: true }, accepted.revision);
      await assert.rejects(store.undoCommand(stale, capturePlan), error => !!error && typeof error === "object" && "status" in error && error.status === 412);
      assert.deepEqual((await host.inbox.mailboxMessageSummary(host.owner, accepted.mailboxId, accepted.messageId)).memberships.find(state => state.mailboxId === accepted.mailboxId), later, "stale reminder inverse cannot overwrite newer state even when original values look reusable");
      const writesBeforeFence = stateCommands.length;
      const otherOwner = { ...stale, owner: "a".repeat(64) };
      await assert.rejects(store.replayCommand(otherOwner, capturePlan), error => error instanceof InboxRecoveryRejected);
      const otherGeneration = structuredClone(stale); otherGeneration.sources[0].generation++;
      await assert.rejects(store.replayCommand(otherGeneration, capturePlan), error => error instanceof InboxRecoveryRejected);
      assert.equal(stateCommands.length, writesBeforeFence);
      assert.equal(validInboxCommandRecovery({ ...stale, subject: "must not persist" }), false);
      // Rehydrating a UI journal only restores data; its explicit Retry owns I/O.
      const session = { version: 2 as const, id: "zero-reload", account: primary.id, scopeKey: "frozen-scope", revision: 1, startedAt: 1, phase: "review" as const, paused: true, currentId: chosen.id, status: "ready" as const,
        progress: { initialCount: 1, remainingCount: 1, decidedCount: 0, ineligibleCount: 0, unknownCount: 0, captureComplete: true } };
      const journal = { version: 1 as const, session, selection: [{ id: chosen.id, reviewVersion: "opaque-review-token", decision: "done" as const }], command: donePlan,
        completedIds: [], undoneIds: [], receipts: [], inverseReceipts: [], attempts: [], mailPending: true, undoRequested: false, problem: "" };
      const restored = restoreZeroRecovery(JSON.parse(JSON.stringify(journal)), session); assert.ok(restored);
      let replayCount = 0;
      new ZeroActionRecovery(restored!, { transport: {} as any, save: () => true, session: () => {}, undoMail: async () => [], replayMail: async () => { replayCount++; throw new Error("must be explicit"); } });
      assert.equal(replayCount, 0);
      assert.equal(providerWrites, 0); return;
    }
    if (scenario === "snooze receipts before refresh") {
      await store.setViewPreferences({ unifiedMode: "selected", includedMailboxIds: [primary.id, overlap.id], pinnedMailboxIds: [] });
      await store.retry();
      const scope = zeroScope(UNIFIED_ACCOUNT, [primary.id, overlap.id], store.getSnapshot().accounts);
      const when = new Date(Date.now() + 86400000).toISOString();
      assert.equal(current().messages.flatMap(message => message.memberships ?? []).length, 2);
      assert.equal(zeroEligible(current(), scope), true);
      const reverse = await store.action([current()], "remind", when);
      // Match the observed UI: the first reminder has already reached the mail model.
      await store.retry();
      assert.equal(zeroEligible(current(), scope), false);
      holdDelta = true; const delayedRefresh = store.retry(); await until(() => deltaHeld);
      const inventoryBaseline = inventories;
      const unrelated = new Map(store.getSnapshot().mail.filter(mail => mail.sdkThreadId !== current().sdkThreadId).map(mail => [mail.id, mail]));
      const snoozedRevisions = new Map(current().messages.flatMap(message => (message.memberships ?? []).map(state => [state.mailboxId, state.revision] as const)));
      await reverse();
      assert.equal(zeroEligible(current(), scope), true, "Undo must restore the guided current conversation before a delayed mail refresh returns");
      assert.ok(current().messages.every(message => message.memberships?.every(state => !state.done && state.snoozedUntil === null && state.revision > snoozedRevisions.get(state.mailboxId)!)));
      const reverseAgain = await store.action([current()], "remind", when);
      assert.equal(zeroEligible(current(), scope), false, "Later publishes its authoritative memberships before returning the Undo closure");
      assert.ok(current().messages.every(message => message.memberships?.every(state => state.snoozedUntil === when)));
      await reverseAgain(); assert.equal(zeroEligible(current(), scope), true);
      let sawPartialSnooze = false;
      const unsubscribe = store.subscribe(() => { sawPartialSnooze ||= current().messages.some(message => message.memberships?.some(state => state.snoozedUntil === when)); });
      try {
        const beforeRollback = stateWrites; failStateWrite = beforeRollback + 1;
        await assert.rejects(store.action([current()], "remind", when));
        assert.equal(stateWrites - beforeRollback, 1, "one atomic durable reminder command rejects without sequential PATCH rollback");
      } finally { unsubscribe(); }
      assert.equal(sawPartialSnooze, false, "a rejected durable reminder never publishes partial membership changes");
      assert.equal(zeroEligible(current(), scope), true);
      assert.ok(current().messages.every(message => message.memberships?.every(state => !state.done && state.snoozedUntil === null)), "rollback receipts restore all represented memberships immediately");
      assert.equal(inventories, inventoryBaseline, "action completion does not wait for or restart a full inventory");
      for (const mail of store.getSnapshot().mail) if (unrelated.has(mail.id)) assert.strictEqual(mail, unrelated.get(mail.id));
      releaseDelta!(); releaseDelta = undefined; await delayedRefresh;
      assert.equal(zeroEligible(current(), scope), true, "the older delayed snooze snapshot cannot replace authoritative Undo/rollback receipts");
      assert.equal(providerWrites, 0); assert.equal(aiRequests, 0);
      return;
    }
    const initial = current(), unrelated = new Map(store.getSnapshot().mail.filter(mail => mail.sdkThreadId !== initial.sdkThreadId).map(mail => [mail.id, mail]));
    const baseline = { bodyReads, providerReads, providerWrites, aiRequests, inventories };
    assert.equal(initial.triage, undefined); assert.equal(store.getSnapshot().ai, null); assert.equal(conversationAttention(initial), "Important");
    const undoOther = await store.classify([initial], "Other");
    assert.equal(conversationAttention(current()), "Other"); assert.equal(current().attentionOverride?.override?.category, "Other");
    assert.equal(inFolder(current(), "Inbox"), true); assert.equal(current().unread, initial.unread);
    assert.ok(current().messages.every(message => message.nativeFolder === "inbox" && message.memberships?.every(state => !state.done && !state.snoozedUntil)));
    for (const mail of store.getSnapshot().mail) if (unrelated.has(mail.id)) assert.strictEqual(mail, unrelated.get(mail.id), "category receipts preserve unrelated Mail identities");
    assert.deepEqual({ bodyReads, providerReads, providerWrites, aiRequests, inventories }, baseline, "a local category receipt performs no AI, provider, body, or full-inventory work");

    if (scenario === "scope and sparse reload") {
      await undoOther(); assert.equal(conversationAttention(current()), "Important"); assert.equal(current().attentionOverride, undefined);
      await store.classify([current()], "Other");
      const undoRepeat = await store.classify([current()], "Other"); await undoRepeat();
      assert.equal(conversationAttention(current()), "Other", "Undo of a repeated choice restores the prior explicit Other");
      const undoImportant = await store.classify([current()], "Important"); assert.equal(conversationAttention(current()), "Important");
      await undoImportant(); assert.equal(conversationAttention(current()), "Other");
      assert.deepEqual({ bodyReads, providerReads, providerWrites, aiRequests, inventories }, baseline);
      const durableRevision = current().attentionOverride!.revision, beforeReload = pages.length;
      stop(); stop = undefined; database.close(); database = new Database(join(root, "categories.sqlite"));
      categories = createAttentionOverridesStore(database, host.inbox, host.owner);
      store = new InboxStore(); stop = store.start();
      await until(() => store.getSnapshot().loaded && current()?.attentionOverride?.revision === durableRevision);
      assert.equal(conversationAttention(current()), "Other", "a restarted service and InboxStore restore the durable explicit choice");
      assert.equal(pages[beforeReload].after, 0); assert.equal(pages[beforeReload].count, 1);
      const reloadPages = pages.slice(beforeReload);
      assert.ok(reloadPages.length <= 2, "bootstrap and its existing mail-delta catch-up use bounded sparse reads, not per-conversation requests");
      assert.ok(reloadPages.slice(1).every(page => page.after === durableRevision && page.count === 0), "catch-up starts at the saved choice cursor instead of reloading the inventory");
      await store.setViewPreferences({ unifiedMode: "selected", includedMailboxIds: [primary.id, overlap.id], pinnedMailboxIds: [] });
      assert.equal(conversationAttention(current()), "Important", "expanded receiving scope does not inherit the narrower choice");
      assert.equal(current().attentionOverride, undefined);
      assert.equal(conversationAttention(current(primary.id)), "Other", "the original receiving scope keeps its applicable choice");
      await store.classify([current()], "Other");
      const captured = current(), beforeReplyCommands = commands.length;
      host.store.receive(source, { from: "category-fixture@example.test", to: nativeBox.email, subject: "Manual category fixture", threadId: native.threadId, text: "A newer fictional reply needs review.", isRead: false });
      await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 }); await store.retry();
      assert.equal(conversationAttention(current()), "Important"); assert.equal(current().attentionOverride, undefined);
      assert.ok(current().messages.length > captured.messages.length);
      await assert.rejects(store.classify([captured], "Other"), error => error instanceof InboxClassificationError && error.code === "HOST_CATEGORY_CONTEXT_CHANGED");
      assert.equal(commands.length, beforeReplyCommands, "a stale captured conversation is rejected before sending a broadened command");
    } else {
      holdPage = true; const refresh = store.retry(); await until(() => pageHeld); await refresh;
      const priorReturned = returnedPages;
      await store.classify([current()], "Important");
      const newRevision = current().attentionOverride!.revision;
      releasePage!(); releasePage = undefined; await until(() => returnedPages > priorReturned);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(current().attentionOverride?.revision, newRevision); assert.equal(conversationAttention(current()), "Important", "a late old Other page cannot replace a newer Important receipt");
      lostAcks = 2; const commandOffset = commands.length;
      let interrupted: InstanceType<typeof InboxClassificationError> | undefined;
      try { await store.classify([current()], "Other"); assert.fail("both controlled acknowledgements should be interrupted"); }
      catch (error) { assert.ok(error instanceof InboxClassificationError); interrupted = error; }
      assert.ok(interrupted);
      assert.equal(interrupted.code, "HOST_CATEGORY_ACK_PENDING"); assert.equal(interrupted.completed, 0); assert.equal(interrupted.remaining, 1);
      assert.equal(interrupted.undoCompleted, undefined); assert.equal(typeof interrupted.retry, "function");
      assert.equal(commands.length - commandOffset, 2); assert.deepEqual(commands[commandOffset], commands[commandOffset + 1]);
      const undoRetried = await interrupted.retry!();
      assert.equal(commands.length - commandOffset, 3); assert.deepEqual(commands[commandOffset], commands[commandOffset + 2], "explicit Retry replays the same durable ID and captured payload");
      assert.equal(conversationAttention(current()), "Other");
      await store.classify([current()], "Important");
      await assert.rejects(undoRetried(), error => error instanceof InboxClassificationError && error.code === "HOST_CATEGORY_UNDO_CONFLICT");
      assert.equal(conversationAttention(current()), "Important", "Undo cannot overwrite a later explicit choice");
    }
    assert.equal(aiRequests, 0); assert.equal(providerWrites, 0); assert.equal(bodyReads, baseline.bodyReads);
  } finally {
    releasePage?.(); releaseDelta?.(); stop?.(); await host.close(); database.close();
    globalThis.fetch = originalFetch; console.info = originalInfo; console.warn = originalWarn;
    Object.assign(MockInboxProvider.prototype, originals);
    for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SDK-backed sending identities stay composer-scoped and preserve explicit draft senders", async () => {
  // Isolate the irreversible owner lock from the other existing SDK cases.
  if (process.env.INBOX_SENDER_TEST_CHILD !== "1") {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn("bun", ["--no-env-file", "test", import.meta.filename, "--test-name-pattern", "SDK-backed sending identities", "--timeout", "30000"], {
        env: { ...process.env, INBOX_TEST_LIVE: "false", INBOX_SENDER_TEST_CHILD: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject); child.once("close", code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    return;
  }
  const [{ createMockHost }, { InboxStore }, { ApiError }, { bindApplicationScope }, fs, { tmpdir }, { join }] = await Promise.all([
    import("../../mock-api/src/host.ts"), import("../src/inbox.ts"), import("inbox-sdk/client"), import("../src/application-scope.ts"),
    import("node:fs/promises"), import("node:os"), import("node:path"),
  ]);
  const root = await fs.mkdtemp(join(tmpdir(), "sending-identities-client-"));
  const originalFetch = globalThis.fetch, originalInfo = console.info, originalWarn = console.warn;
  const globals = ["location", "window", "document", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let host: Awaited<ReturnType<typeof createMockHost>> | undefined, stop: (() => void) | undefined;
  let identityGate: Promise<void> | undefined, releaseIdentity: (() => void) | undefined, identityHeld = false, failIdentity = false;
  const identityReads: URL[] = [], created: Array<Record<string, unknown>> = [];
  const until = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 800 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), "SDK fixture reached the expected state");
  };
  try {
    console.info = () => {}; console.warn = () => {};
    host = await createMockHost({ dataDir: root, encryptionKey: Buffer.alloc(32, 33).toString("base64"), token: "fictional-sender-client-token-for-tests", allowProviderWrites: true });
    const [nativeBox, secondBox] = host.store.mailboxes(host.owner);
    const sourceId = host.store.link(host.owner, nativeBox.id)!.accountId;
    const alias = nativeBox.aliases[0]!;
    host.store.receive({ owner: host.owner, storeId: nativeBox.id, accountId: sourceId }, {
      from: "sender@example.test", to: alias, subject: "Explicit alias reply", text: "Fictional alias recipient.",
    });
    await host.inbox.sync(host.owner, sourceId, { folder: "all", lane: "latest", limit: 100 });
    const storage = new Map<string, string>();
    Object.assign(globalThis, { location: new URL("http://localhost:41999"), window: new EventTarget(),
      document: { visibilityState: "visible", createElement: () => ({ innerHTML: "", content: { querySelectorAll: () => [] } }) },
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    });
    const binding = bindApplicationScope("b".repeat(64));
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === "/host/config") return Response.json({ mode: "mock", allowProviderWrites: true, providers: [], preferenceScope: "fictional-sender-client" });
      if (url.pathname === "/host/inbox-preferences") return Response.json({ revision: 1, unifiedMode: "all", includedMailboxIds: [], pinnedMailboxIds: [] });
      if (url.pathname === "/host/split-preferences") return Response.json({ ...normalizeSplits({}), revision: 1 });
      if (url.pathname === "/host/attention-feedback") return Response.json([]);
      if (url.pathname === "/v1/events") return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Request cancelled", "AbortError"));
        if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      const identities = url.pathname.endsWith("/sending-identities");
      if (identities) {
        identityReads.push(url);
        assert.equal(new Headers(init?.headers).get("X-Superlocal-Scope"), binding.scope);
        assert.equal(init?.cache, "no-store");
        if (failIdentity) return Response.json({ code: "PROVIDER_UNAVAILABLE", error: "Sending addresses are temporarily unavailable." }, { status: 503 });
      }
      if (url.pathname === "/v1/drafts" && init?.method === "POST") created.push(JSON.parse(String(init.body)));
      const headers = new Headers(init?.headers); headers.set("Authorization", "Bearer fictional-sender-client-token-for-tests");
      const response = await host!.fetch(new Request(url, { ...init, headers }));
      if (identities && identityGate) { identityHeld = true; await identityGate; } // Deliberately ignore abort to exercise the owner fence.
      return response;
    }) as typeof fetch;
    const store = new InboxStore(); stop = store.start();
    await until(() => store.getSnapshot().loaded);
    assert.equal(identityReads.length, 0, "inbox bootstrap never discovers sending identities");
    const primary = store.getSnapshot().accounts.find(box => box.sourceId === sourceId)!;
    const secondary = store.getSnapshot().accounts.find(box => box.sourceId === host!.store.link(host!.owner, secondBox.id)!.accountId)!;
    assert.equal(primary.sourceGeneration, (await host.inbox.account(host.owner, sourceId)).generation);
    const values = await store.sendingIdentities(primary.id);
    assert.equal(values.sourceId, sourceId);
    assert.ok(values.identities.some(identity => identity.email === alias));
    assert.ok(identityReads.every(url => url.pathname === `/v1/accounts/${sourceId}/sending-identities`), "only the active composer's source is read");
    const beforeFailure = identityReads.length;
    failIdentity = true;
    await assert.rejects(store.sendingIdentities(primary.id, { refresh: true }), error => error instanceof ApiError && error.code === "PROVIDER_UNAVAILABLE");
    assert.equal(identityReads.length, beforeFailure + 1, "lookup failure does not poll or retry silently");
    failIdentity = false;
    await store.sendingIdentities(primary.id, { refresh: true });
    assert.equal(identityReads.at(-1)!.searchParams.get("refresh"), "true", "manual retry forces a fresh lookup");

    const compose = await store.newDraft(primary.id, { to: "recipient@example.test", subject: "Explicit sender", body: "<p>Keep this writing</p>" });
    assert.equal(created.at(-1)!.from, primary.email, "new compose retains the existing mailbox default");
    store.editDraft({ ...compose, from: alias, popOut: true });
    await store.flushDraft(compose.id);
    await store.reloadDraft(compose.id);
    let saved = store.getSnapshot().drafts.find(draft => draft.id === compose.id)!;
    assert.equal(saved.from, alias); assert.equal(saved.id, compose.id); assert.equal(saved.account, primary.id); assert.equal(saved.popOut, true);
    assert.equal(created.length, 1, "same-source alias changes update rather than recreate the draft");
    const mail = store.getSnapshot().mail.find(mail => mail.account === primary.id && mail.subject === "Explicit alias reply")!;
    const sourceMessageId = mail.messages.at(-1)!.id;
    assert.equal(mail.to, alias, "row To is the actual header recipient, not the source owner");
    assert.deepEqual(mail.toAddresses, [alias]);
    assert.deepEqual(store.getSnapshot().mail.find(value => value.account === UNIFIED_ACCOUNT && value.subject === mail.subject)!.toAddresses, [alias]);
    for (const mode of ["reply", "replyAll"] as const) {
      const reply = await store.newDraft(primary.id, { mode, mail, sourceMessageId });
      assert.equal(Object.hasOwn(created.at(-1)!, "from"), false, "implicit replies leave sender selection to the SDK");
      assert.equal(reply.from, alias, "SDK's chosen verified reply alias is retained");
      await store.discardDraft(reply.id);
    }
    const forward = await store.newDraft(primary.id, { mode: "forward", mail, sourceMessageId });
    assert.equal(created.at(-1)!.from, primary.email, "forward default is unchanged");
    await store.discardDraft(forward.id);

    store.editDraft({ ...saved, from: "removed@example.test" });
    await store.flushDraft(saved.id);
    saved = store.getSnapshot().drafts.find(draft => draft.id === compose.id)!;
    await assert.rejects(store.submit(saved), error => error instanceof ApiError && error.code === "FORBIDDEN_SENDER");
    saved = store.getSnapshot().drafts.find(draft => draft.id === compose.id)!;
    assert.equal(saved.from, "removed@example.test"); assert.equal(saved.body, "<p>Keep this writing</p>");
    assert.equal(saved.sendError?.code, "FORBIDDEN_SENDER", "send rejection remains visible on the kept draft");
    store.editDraft({ ...saved, body: "<p>Still kept</p>", popOut: false });
    await store.flushDraft(saved.id);
    saved = store.getSnapshot().drafts.find(draft => draft.id === compose.id)!;
    assert.equal(saved.sendError?.code, "FORBIDDEN_SENDER", "typing, autosave, and popout changes cannot erase a sender failure");
    await store.reloadDraft(saved.id);
    saved = store.getSnapshot().drafts.find(draft => draft.id === compose.id)!;
    assert.equal(saved.from, "removed@example.test", "reload never replaces an unavailable saved sender");
    store.editDraft({ ...saved, from: alias }); await store.flushDraft(saved.id);
    assert.equal(store.getSnapshot().drafts.find(draft => draft.id === compose.id)!.sendError, undefined);

    identityGate = new Promise(resolve => { releaseIdentity = resolve; }); identityHeld = false;
    const detachedRead = store.sendingIdentities(secondary.id, { refresh: true });
    const rejectedDetached = assert.rejects(detachedRead, error => error instanceof DOMException && error.name === "AbortError");
    await until(() => identityHeld);
    const box = await host.inbox.mailbox(host.owner, secondary.id);
    await host.inbox.updateMailbox(host.owner, secondary.id, { status: "detached" }, box.revision);
    await store.refresh(true);
    releaseIdentity!(); identityGate = undefined; await rejectedDetached;

    identityGate = new Promise(resolve => { releaseIdentity = resolve; }); identityHeld = false;
    const lateRead = store.sendingIdentities(primary.id, { refresh: true });
    const rejectedLate = assert.rejects(lateRead, error => error instanceof DOMException && error.name === "AbortError");
    await until(() => identityHeld); stop(); stop = undefined;
    const stopped = store.getSnapshot();
    releaseIdentity!(); identityGate = undefined; await rejectedLate;
    assert.strictEqual(store.getSnapshot(), stopped, "late lookup cannot publish into a stopped store generation");
    stop = store.start(); await store.refresh(true);
    identityGate = new Promise(resolve => { releaseIdentity = resolve; }); identityHeld = false;
    const ownerRead = store.sendingIdentities(primary.id, { refresh: true });
    const rejectedOwner = assert.rejects(ownerRead, error => error instanceof DOMException && error.name === "AbortError");
    await until(() => identityHeld); binding.lock(); releaseIdentity!(); identityGate = undefined; await rejectedOwner;
    const lockedReads = identityReads.length;
    await assert.rejects(store.sendingIdentities(primary.id), error => error instanceof DOMException && error.name === "AbortError");
    assert.equal(identityReads.length, lockedReads, "owner lock fences cached lookups before dispatch");
  } finally {
    releaseIdentity?.(); stop?.(); await host?.close(); await fs.rm(root, { recursive: true, force: true });
    globalThis.fetch = originalFetch; console.info = originalInfo; console.warn = originalWarn;
    for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test("MailRow renders actual To recipients without mailbox or Bcc substitution", async () => {
  if (!process.versions.bun) {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn("bun", ["--no-env-file", "test", import.meta.filename, "--test-name-pattern", "MailRow renders actual To"], {
        env: { ...process.env, INBOX_TEST_LIVE: "false" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject); child.once("close", code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output); return;
  }
  const [{ createElement }, { renderToStaticMarkup }, { default: MailRow }] = await Promise.all([
    import("react"), import("react-dom/server"), import("../src/MailRow.tsx"),
  ]);
  const render = (to: string, sent = false, unified = false, toAddresses?: string[]) => renderToStaticMarkup(createElement(MailRow, {
    mail: { ...inbox, to, toAddresses, account: unified ? UNIFIED_ACCOUNT : inbox.account, accountEmail: "owner@example.test",
      mailboxNames: unified ? ["Receiving mailbox"] : undefined,
      messages: [{ ...inbox.messages[0], to, cc: "cc-only@example.test", bcc: "private-bcc@example.test" }] },
    index: 0, highlighted: false, selected: false, sent, showSnippets: false,
  }));
  const alias = render("Project <project@example.test>");
  assert.match(alias, /To: Project &lt;project@example.test&gt;/);
  assert.match(alias, /title="To: Project &lt;project@example.test&gt;"/);
  const projectedAlias = render("Project <project@example.test>", false, false, ["project@example.test"]);
  assert.match(projectedAlias, />To: project@example.test<\/span>/);
  assert.match(projectedAlias, /title="To: Project &lt;project@example.test&gt;"/);
  const multiple = render("first@example.test, second@example.test", false, true);
  assert.match(multiple, /To: first@example.test, second@example.test/);
  assert.match(render("recipient@example.test", true), /To: recipient@example.test/, "sent rows use the real To too");
  const absent = render("");
  assert.match(absent, /No To recipients/);
  assert.match(render("owner@example.test", false, true, []), /No To recipients/, "an authoritative empty To never falls back to an ownership address");
  for (const html of [alias, projectedAlias, multiple, absent, render("", true, true), render("owner@example.test", false, true, [])]) {
    assert.doesNotMatch(html, /private-bcc@example.test|cc-only@example.test|owner@example.test/);
  }
});
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
  let draftSaveCalls = 0, loseDraftResponse = false, draftReadHeld = false, gatedDraftRead: string | undefined;
  let draftSaveGate: Promise<void> | undefined, releaseDraftSave: (() => void) | undefined;
  let draftReadGate: Promise<void> | undefined, releaseDraftRead: (() => void) | undefined;
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
      const savingDraft = /^\/v1\/drafts\/[^/]+$/.test(url.pathname) && init?.method === "PATCH";
      if (savingDraft) draftSaveCalls++;
      const response = await host.fetch(new Request(url, { ...init, headers }));
      if (savingDraft && response.ok) {
        if (draftSaveGate) await draftSaveGate;
        if (loseDraftResponse) { loseDraftResponse = false; throw new TypeError("Controlled lost draft acknowledgement"); }
      }
      if (draftReadGate && url.pathname === `/v1/drafts/${gatedDraftRead}` && init?.method !== "PATCH") { draftReadHeld = true; await draftReadGate; }
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
      if (url.pathname === "/v1/mailbox-snapshot" && response.ok && finalPageGate) {
        // Drain through EOF before freezing the COMPLETE authoritative snapshot.
        // Holding an earlier page would let a later page's legitimate cursor
        // restart mask whether newer E/W/Undo receipts survive this old snapshot.
        assert.match(response.headers.get("Content-Type") ?? "", /^application\/x-ndjson\b/);
        const frames = (await response.clone().text()).trim().split("\n").map(line => JSON.parse(line));
        assert.ok(frames.length > 0 && frames.every(frame => frame.type === "page"));
        assert.equal(frames.at(-1).page.nextCursor, null);
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

    // Correcting a local recipient error can save again; conflicts and lost
    // acknowledgements still require reload, and recovery owns one incident.
    const editable = await store.newDraft(primary.id, { to: "qa-other@example.test", subject: "Recipient recovery" });
    const otherDraft = await store.newDraft(primary.id, { to: "other@example.test", subject: "Independent error" });
    store.editDraft({ ...editable, to: "qa-other@example.test, other@" });
    await assert.rejects(store.flushDraft(editable.id), /Complete the recipient/);
    await assert.rejects(store.flushDraft(editable.id), /Complete the recipient/);
    store.editDraft({ ...otherDraft, to: "other@" });
    await assert.rejects(store.flushDraft(otherDraft.id), /Complete the recipient/);
    const otherIssue = store.getSnapshot().issues.find(issue => issue.key === `draft:${otherDraft.id}`)!;
    const recipientIssue = store.getSnapshot().issues.find(issue => issue.key === `draft:${editable.id}`)!;
    assert.equal(recipientIssue.count, 2, "repeat validation errors coalesce without losing their local origin");
    const beforeCorrection = draftSaveCalls;
    store.editDraft({ ...store.getSnapshot().drafts.find(value => value.id === editable.id)!, body: "<p>Still incomplete</p>" });
    await sleep(550);
    assert.equal(draftSaveCalls, beforeCorrection, "incomplete recipients never autosave");
    assert.ok(store.getSnapshot().drafts.find(value => value.id === editable.id)!.saveError);
    draftSaveGate = new Promise(resolve => { releaseDraftSave = resolve; });
    store.editDraft({ ...store.getSnapshot().drafts.find(value => value.id === editable.id)!, to: "qa-other@example.test", cc: "", bcc: "", body: "<p>Corrected body</p>" });
    await until(() => draftSaveCalls > beforeCorrection, "corrected recipient triggers an actual automatic save");
    assert.equal(store.getSnapshot().drafts.find(value => value.id === editable.id)!.saveError, undefined);
    assert.equal(store.getSnapshot().drafts.find(value => value.id === editable.id)!.dirty, true);
    assert.strictEqual(store.getSnapshot().issues.find(issue => issue.key === recipientIssue.key), recipientIssue, "editing or a pending acknowledgement cannot retire the failure");
    releaseDraftSave!(); draftSaveGate = undefined;
    await until(() => !store.getSnapshot().drafts.find(value => value.id === editable.id)!.dirty, "successful save acknowledges corrected recipients");
    assert.equal((await host.inbox.draft(host.owner, editable.id)).bodyHtml, "<p>Corrected body</p>");
    assert.equal(store.getSnapshot().issues.some(issue => issue.key === recipientIssue.key), false);
    assert.strictEqual(store.getSnapshot().issues.find(issue => issue.key === otherIssue.key), otherIssue);
    const savedCalls = draftSaveCalls;
    await store.flushDraft(editable.id);
    assert.equal(draftSaveCalls, savedCalls, "a clean flush is a no-op");
    assert.strictEqual(store.getSnapshot().issues.find(issue => issue.key === otherIssue.key), otherIssue);

    store.editDraft({ ...store.getSnapshot().drafts.find(value => value.id === editable.id)!, body: "<p>Local conflict</p>" });
    const serverDraft = await host.inbox.draft(host.owner, editable.id);
    await host.inbox.updateDraft(host.owner, editable.id, { subject: "Newer server writing" }, serverDraft.revision);
    await assert.rejects(store.flushDraft(editable.id));
    assert.match(store.getSnapshot().drafts.find(value => value.id === editable.id)!.saveError!, /changed elsewhere/);
    const conflictCalls = draftSaveCalls;
    store.editDraft({ ...store.getSnapshot().drafts.find(value => value.id === editable.id)!, to: "corrected@example.test", body: "<p>Keep conflicting writing</p>" });
    await sleep(550);
    await assert.rejects(store.flushDraft(editable.id), /changed elsewhere/);
    assert.equal(draftSaveCalls, conflictCalls, "complete recipients cannot retry an HTTP 412 conflict");
    await store.reloadDraft(editable.id);
    assert.equal(store.getSnapshot().drafts.find(value => value.id === editable.id)!.subject, "Newer server writing");
    assert.equal(store.getSnapshot().issues.some(issue => issue.key === recipientIssue.key), false);

    loseDraftResponse = true;
    store.editDraft({ ...store.getSnapshot().drafts.find(value => value.id === editable.id)!, body: "<p>Lost acknowledgement</p>" });
    await assert.rejects(store.flushDraft(editable.id), TypeError);
    const ambiguousCalls = draftSaveCalls;
    store.editDraft({ ...store.getSnapshot().drafts.find(value => value.id === editable.id)!, to: "complete@example.test", body: "<p>Keep ambiguous writing</p>" });
    await sleep(550);
    await assert.rejects(store.flushDraft(editable.id), /lost draft acknowledgement/);
    assert.equal(draftSaveCalls, ambiguousCalls, "complete recipients cannot retry an ambiguous network save");
    await store.reloadDraft(editable.id);
    assert.equal((await host.inbox.draft(host.owner, editable.id)).bodyHtml, "<p>Lost acknowledgement</p>");

    store.editDraft({ ...store.getSnapshot().drafts.find(value => value.id === editable.id)!, to: "newer@" });
    await assert.rejects(store.flushDraft(editable.id), /Complete the recipient/);
    gatedDraftRead = editable.id; draftReadGate = new Promise(resolve => { releaseDraftRead = resolve; });
    const lateReload = store.reloadDraft(editable.id);
    await until(() => draftReadHeld, "reload response is held before a newer validation incident");
    await assert.rejects(store.flushDraft(editable.id), /Complete the recipient/);
    const newerIssue = store.getSnapshot().issues.find(issue => issue.key === recipientIssue.key)!;
    releaseDraftRead!(); draftReadGate = undefined; await lateReload;
    assert.strictEqual(store.getSnapshot().issues.find(issue => issue.key === newerIssue.key), newerIssue, "late recovery cannot retire a newer incident");
    await store.flushDraft(editable.id);
    assert.strictEqual(store.getSnapshot().issues.find(issue => issue.key === newerIssue.key), newerIssue, "cached no-op is not authoritative recovery");
    await store.reloadDraft(editable.id);
    assert.equal(store.getSnapshot().issues.some(issue => issue.key === newerIssue.key), false);
    assert.strictEqual(store.getSnapshot().issues.find(issue => issue.key === otherIssue.key), otherIssue);
    await store.reloadDraft(otherDraft.id);

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
    releaseResponse?.(); releaseSnapshot?.(); releaseFinalPage?.(); releaseDelta?.(); releaseProvider?.(); releaseDraftSave?.(); releaseDraftRead?.(); stopReloaded?.(); stop?.(); await providerWork;
    MockInboxProvider.prototype.mutate = originalMutate;
    MockInboxProvider.prototype.send = originalSend;
    feedbackDatabase.close(); await host.close(); await fs.rm(root, { recursive: true, force: true });
    globalThis.fetch = originalFetch; console.info = originalInfo; console.warn = originalWarn;
  }
});
test("SDK-backed startup catches signed changes before first display without repeating fresh metadata", async () => {
  // Keep the irreversible document-owner abort isolated from other SDK cases.
  if (process.env.INBOX_STARTUP_TEST_CHILD !== "1") {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn("bun", ["--no-env-file", "test", import.meta.filename, "--test-name-pattern", "SDK-backed startup", "--timeout", "30000"], {
        env: { ...process.env, INBOX_TEST_LIVE: "false", INBOX_STARTUP_TEST_CHILD: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject); child.once("close", code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    return;
  }
  const [{ createMockHost }, { InboxStore }, fs, { tmpdir }, { join }, { Database }, { bindApplicationScope }] = await Promise.all([
    import("../../mock-api/src/host.ts"), import("../src/inbox.ts"), import("node:fs/promises"), import("node:os"), import("node:path"), import("bun:sqlite"), import("../src/application-scope.ts"),
  ]);
  const root = await fs.mkdtemp(join(tmpdir(), "startup-catchup-"));
  const host = await createMockHost({ dataDir: root, encryptionKey: Buffer.alloc(32, 31).toString("base64"), token: "fictional-startup-catchup-client-token", allowProviderWrites: true });
  const database = new Database(join(root, "mock-inbox.sqlite"));
  const originalFetch = globalThis.fetch, originalInfo = console.info, originalWarn = console.warn;
  const globals = ["location", "window", "document", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check: () => boolean, message: string) => {
    const deadline = Date.now() + 8000;
    while (!check() && Date.now() < deadline) await sleep(10);
    assert.ok(check(), message);
  };
  const gates: Array<{ promise: Promise<void>; release: () => void; seen: boolean }> = [];
  const gate = () => {
    let release!: () => void;
    const value = { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release(), seen: false };
    gates.push(value); return value;
  };
  let beforeSnapshot: ReturnType<typeof gate> | undefined, snapshot: ReturnType<typeof gate> | undefined, firstPage: ReturnType<typeof gate> | undefined;
  let delta: ReturnType<typeof gate> | undefined, redundantMetadata: ReturnType<typeof gate> | undefined;
  let stop: (() => void) | undefined, liveEvents = false, deltaFailures = 0, foreignState: string | undefined;
  let inventories = 0, deltas = 0, scopeResets = 0, streams = 0, hostReads = 0, snapshotPages = 0;
  let smallSnapshot = true, snapshotSignal: AbortSignal | null | undefined;
  let snapshotFailure: "interrupted" | "truncated" | "after-final" | "expired" | "scope" | "forbidden" | undefined, snapshotFailures = 0;
  let preferences = { revision: 1, unifiedMode: "all", includedMailboxIds: [] as string[], pinnedMailboxIds: [] as string[] };
  let splits = { ...normalizeSplits({}), revision: 1 };
  try {
    console.info = () => {}; console.warn = () => {};
    const nativeBox = host.store.mailboxes(host.owner)[0];
    const source = { owner: host.owner, storeId: nativeBox.id, accountId: host.store.link(host.owner, nativeBox.id)!.accountId };
    const native = ["Done", "Deleted", "Unselected"].map(subject => host.store.receive(source, {
      from: "startup@example.test", to: nativeBox.email, subject: `Startup ${subject}`, text: "Fictional startup message.",
    }));
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    const primary = (await host.inbox.mailboxes(host.owner)).find(box => box.sourceId === source.accountId)!;
    const candidate = (await host.inbox.mailboxCandidates(host.owner, primary.connectionId)).find(value => value.sourceId === source.accountId && value.selector.kind === "domain")!;
    const overlap = await host.inbox.createMailbox(host.owner, { sourceId: source.accountId, name: "Startup overlap", selector: candidate.selector });
    const rows = (await host.inbox.mailboxMessages(host.owner, { mailboxIds: [primary.id, overlap.id], limit: 100 })).items;
    const done = rows.find(row => row.subject === "Startup Done")!, deleted = rows.find(row => row.subject === "Startup Deleted")!, unselected = rows.find(row => row.subject === "Startup Unselected")!;
    const storage = new Map<string, string>();
    Object.assign(globalThis, {
      location: new URL("http://localhost:41999"), window: new EventTarget(),
      document: { visibilityState: "visible", createElement: () => ({ innerHTML: "", content: { querySelectorAll: () => [] } }) },
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    });
    const binding = bindApplicationScope("c".repeat(64));
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === "/host/config") {
        if (++hostReads > 1 && redundantMetadata) { redundantMetadata.seen = true; await redundantMetadata.promise; }
        return Response.json({ mode: "mock", allowProviderWrites: true, providers: [], preferenceScope: "fictional-startup" });
      }
      if (url.pathname === "/host/inbox-preferences") return Response.json(preferences);
      if (url.pathname === "/host/split-preferences") return Response.json(splits);
      if (url.pathname === "/host/attention-feedback") return Response.json([]);
      if (url.pathname === "/v1/events" && !liveEvents) return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Request cancelled", "AbortError"));
        if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      if (url.pathname === "/v1/mailbox-snapshot") {
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("Accept"), "application/x-ndjson");
        snapshotSignal = init?.signal;
        if (beforeSnapshot) { beforeSnapshot.seen = true; await beforeSnapshot.promise; }
        // Exercise real multi-page inventory without adding a large fixture.
        // Only this request is changed; later bootstraps retain the app's limit.
        if (smallSnapshot) { smallSnapshot = false; init = { ...init, body: JSON.stringify({ ...JSON.parse(String(init?.body)), limit: 1 }) }; }
      }
      if (url.pathname === "/v1/mailbox-changes" && deltaFailures > 0) {
        deltaFailures--;
        return Response.json({ code: "CONTROLLED_FAILURE", error: "Controlled catch-up failure." }, { status: 503 });
      }
      const headers = new Headers(init?.headers); headers.set("Authorization", "Bearer fictional-startup-catchup-client-token");
      const response = await host.fetch(new Request(url, { ...init, headers }));
      if (url.pathname === "/v1/changes" && foreignState && response.ok) return Response.json({ ...await response.json(), state: foreignState });
      if (url.pathname === "/v1/events" && response.ok) streams++;
      if (url.pathname === "/v1/mailbox-snapshot") {
        inventories++;
        if (response.ok) {
          assert.match(response.headers.get("Content-Type") ?? "", /^application\/x-ndjson\b/);
          const held = snapshot, first = firstPage, failure = snapshotFailures > 0 ? snapshotFailure : undefined;
          if (snapshotFailures > 0) snapshotFailures--;
          const decoder = new TextDecoder(), encoder = new TextEncoder();
          let pending = "", pageCount = 0, lastPage: import("inbox-sdk/types").MailboxSnapshotPage | undefined;
          return new Response(response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            async transform(chunk, controller) {
              pending += decoder.decode(chunk, { stream: true });
              let end: number;
              while ((end = pending.indexOf("\n")) !== -1) {
                const frame = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
                assert.equal(frame.type, "page", "the controlled stream starts with real SDK summary pages");
                lastPage = frame.page; pageCount++; snapshotPages++;
              }
              controller.enqueue(chunk);
              if (pageCount === 1) {
                if (first) { first.seen = true; await first.promise; }
                if (failure === "interrupted") throw new TypeError("Controlled snapshot stream interruption");
                if (failure === "truncated") { controller.terminate(); return; }
                if (failure && failure !== "after-final") {
                  const code = failure === "expired" ? "SNAPSHOT_EXPIRED" : failure === "scope" ? "SNAPSHOT_SCOPE_CHANGED" : "FORBIDDEN";
                  controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", status: failure === "forbidden" ? 403 : 409, code, error: "Controlled terminal snapshot failure", retryable: failure !== "forbidden" })}\n`));
                  controller.terminate();
                }
              }
            },
            async flush(controller) {
              pending += decoder.decode();
              assert.equal(pending, "", "snapshot EOF follows complete NDJSON frames");
              assert.ok(pageCount > 0);
              assert.equal(lastPage!.nextCursor, null, "freeze the complete authoritative inventory, not an earlier page");
              if (failure === "after-final") controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", status: 503, code: "UPSTREAM", error: "Controlled failure after the final page", retryable: true })}\n`));
              // All pages have reached the client, but successful EOF has not.
              // Ignore abort here so the SDK/owner fence must reject late work.
              if (held) { held.seen = true; await held.promise; }
            },
          })), { status: response.status, headers: response.headers });
        }
      }
      if (url.pathname === "/v1/mailbox-changes") {
        deltas++;
        if (response.ok) {
          const page = await response.clone().json();
          if (page.resetReason === "scope") scopeResets++;
          const held = delta;
          if (held && !page.hasMore && !page.resetRequired) { held.seen = true; await held.promise; }
        }
      }
      // Delayed responses deliberately ignore abort here; the actual scoped
      // transport, rather than this test fetch, must fence stopped generations.
      return response;
    }) as typeof fetch;

    redundantMetadata = gate(); firstPage = gate(); snapshot = gate();
    let store = new InboxStore(), publishedBeforeEof = false;
    const unsubscribePages = store.subscribe(() => { publishedBeforeEof ||= store.getSnapshot().loaded || store.getSnapshot().mail.length > 0; });
    stop = store.start();
    await until(() => firstPage!.seen, "first real snapshot page reached the client");
    assert.equal(snapshotPages, 1);
    assert.equal(store.getSnapshot().loaded, false);
    assert.deepEqual(store.getSnapshot().mail, [], "a streamed partial inventory remains private");
    assert.equal(deltas, 0, "catch-up cannot begin before snapshot completion");
    firstPage.release(); firstPage = undefined;
    await until(() => snapshot!.seen, "complete initial SDK snapshot held before EOF");
    assert.ok(snapshotPages > 1, "the real SDK supplied multiple bounded pages");
    assert.equal(inventories, 1, "one snapshot POST carries every page, without cursor fetches");
    assert.equal(store.getSnapshot().loaded, false, "even the final page is not success before EOF");
    assert.deepEqual(store.getSnapshot().mail, []);
    assert.equal(publishedBeforeEof, false, "no subscriber ever saw a partial inventory");
    assert.equal(deltas, 0); unsubscribePages();
    snapshot.release(); snapshot = undefined;
    await until(() => store.getSnapshot().loaded, "first ready does not wait for redundant host metadata");
    assert.equal(hostReads, 1, "fresh host metadata is not unconditionally read again during catch-up");
    assert.equal(inventories, 1, "catch-up does not restart the completed inventory");
    assert.ok(deltas > 0, "successful EOF still requires signed catch-up");
    assert.equal(redundantMetadata.seen, false);
    assert.ok(store.getSnapshot().mail.length > 0);
    redundantMetadata.release(); redundantMetadata = undefined; stop();

    // Change metadata AFTER its reads but BEFORE the inventory samples its
    // state. The earlier signed baseline must retain these otherwise-lost events.
    beforeSnapshot = gate(); snapshot = gate(); delta = gate(); liveEvents = true;
    store = new InboxStore();
    let firstReady: ReturnType<typeof store.getSnapshot> | undefined;
    const unsubscribe = store.subscribe(() => { if (store.getSnapshot().loaded) firstReady ??= store.getSnapshot(); });
    stop = store.start();
    await until(() => beforeSnapshot!.seen, "metadata read before first snapshot request");
    const label = await host.inbox.createLabel(host.owner, source.accountId, "Startup label");
    await host.inbox.setPolicy(host.owner, { remoteImages: false });
    let draft = await host.inbox.createDraft(host.owner, { accountId: source.accountId, mailboxId: primary.id, subject: "Startup draft" });
    await host.inbox.updateMailbox(host.owner, primary.id, { name: "Startup renamed" }, primary.revision);
    beforeSnapshot.release(); beforeSnapshot = undefined;
    await until(() => snapshot!.seen, "old complete mail inventory held before mailbox changes");
    let member = done.memberships.find(state => state.mailboxId === primary.id)!;
    // More than one real delta page must finish before the first display.
    for (let index = 0; index < 501; index++) member = await host.inbox.setMailboxState(host.owner, primary.id, done.id, { done: index % 2 === 0 }, member.revision);
    host.store.mutate(source, native[1].id, { deletePermanently: true });
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    // Exercise the SDK's scoped-absence result, not a fabricated delta payload.
    database.query("DELETE FROM sdk_memberships WHERE owner=? AND message=?").run(host.owner, unselected.id);
    await host.inbox.mutate(host.owner, { messageIds: [unselected.id], changes: { isRead: true }, idempotencyKey: "startup-unselection" });
    const beforeDeltas = deltas;
    snapshot.release(); snapshot = undefined;
    await until(() => delta!.seen, "final signed delta response held after earlier page applied");
    assert.ok(deltas - beforeDeltas >= 2, "all bounded delta pages are consumed");
    assert.equal(store.getSnapshot().loaded, false, "partial catch-up never exposes stale Done/deleted/unselected rows");
    assert.equal(firstReady, undefined);
    delta.release(); delta = undefined;
    await until(() => !!firstReady, "signed catch-up reaches first display");
    assert.equal(firstReady!.mail.find(mail => mail.account === primary.id && mail.messages.some(message => message.id === done.id))!.folder, "Done");
    assert.ok(!firstReady!.mail.some(mail => mail.messages.some(message => [deleted.id, unselected.id].includes(message.id))));
    assert.equal(firstReady!.policy!.remoteImages, false);
    assert.ok(firstReady!.labels[primary.id].includes(label.name));
    assert.ok(firstReady!.drafts.some(value => value.id === draft.id));
    assert.equal(firstReady!.accounts.find(value => value.id === primary.id)!.name, "Startup renamed");
    await until(() => streams > 0, "real SDK event stream connected");
    const metadataReads = hostReads, inventoryReads = inventories;
    await host.inbox.updateLabel(host.owner, label.id, "Live label", label.revision);
    await host.inbox.setPolicy(host.owner, { remoteImages: true });
    draft = await host.inbox.updateDraft(host.owner, draft.id, { subject: "Live draft" }, draft.revision);
    const currentPrimary = await host.inbox.mailbox(host.owner, primary.id);
    await host.inbox.updateMailbox(host.owner, primary.id, { name: "Live renamed" }, currentPrimary.revision);
    await until(() => store.getSnapshot().labels[primary.id].includes("Live label") && store.getSnapshot().policy?.remoteImages === true
      && store.getSnapshot().drafts.some(value => value.id === draft.id && value.subject === "Live draft")
      && store.getSnapshot().accounts.find(value => value.id === primary.id)?.name === "Live renamed", "actual metadata events remain current after startup");
    assert.equal(hostReads, metadataReads, "event-specific metadata does not force unrelated host reads");
    assert.equal(inventories, inventoryReads, "presentation metadata does not reset the mail inventory");
    preferences = { ...preferences, revision: 2, unifiedMode: "selected", includedMailboxIds: [primary.id], pinnedMailboxIds: [primary.id] };
    splits = { ...splits, revision: 2 };
    await store.retry();
    assert.equal(store.getSnapshot().viewPreferences!.revision, 2, "explicit retry still refreshes host-only manual preferences");
    assert.deepEqual(store.unifiedMailboxIds(), [primary.id]);
    assert.equal(store.getSnapshot().splitPreferences!.revision, 2);
    unsubscribe(); stop(); liveEvents = false;

    deltaFailures = 1;
    store = new InboxStore(); stop = store.start();
    await until(() => !!store.getSnapshot().error, "initial catch-up failure is reported");
    assert.equal(store.getSnapshot().loaded, false, "failed catch-up cannot release the initial display fence");
    delta = gate(); const retry = store.retry();
    await until(() => delta!.seen, "retry still waits for signed catch-up");
    assert.equal(store.getSnapshot().loaded, false);
    delta.release(); delta = undefined; await retry;
    assert.equal(store.getSnapshot().loaded, true); stop();

    snapshot = gate(); store = new InboxStore(); stop = store.start();
    await until(() => snapshot!.seen, "initial snapshot held before detachment");
    await host.inbox.updateMailbox(host.owner, overlap.id, { status: "detached" }, overlap.revision);
    const oldSnapshot = snapshot; snapshot = gate(); oldSnapshot.release();
    await until(() => snapshot!.seen, "scope reset reboots from authorized mailbox metadata");
    assert.ok(scopeResets > 0, "the real SDK rejects the old snapshot scope");
    assert.equal(store.getSnapshot().loaded, false, "scope reset remains blank until its replacement catches up");
    snapshot.release(); snapshot = undefined;
    await until(() => store.getSnapshot().loaded, "replacement scope caught up");
    assert.ok(!store.getSnapshot().accounts.some(value => value.id === overlap.id));
    assert.ok(!store.getSnapshot().mail.some(mail => mail.account === overlap.id || mail.messages.some(message => message.memberships?.some(state => state.mailboxId === overlap.id))));
    assert.ok(store.getSnapshot().accounts.some(value => value.id === primary.id)); stop();

    foreignState = (await host.inbox.changes("fictional-other-owner")).state;
    store = new InboxStore(); stop = store.start();
    await until(() => !!store.getSnapshot().error, "SDK rejects a genuinely signed foreign-owner baseline");
    assert.equal(store.getSnapshot().loaded, false, "a foreign signed state never releases first display");
    stop(); foreignState = undefined;

    delta = gate(); store = new InboxStore(); stop = store.start();
    await until(() => delta!.seen, "catch-up response held before stopping the generation");
    stop(); stop = undefined; delta.release(); delta = undefined;
    await sleep(50);
    assert.equal(store.getSnapshot().loaded, false, "a late catch-up response cannot publish after stop");

    for (const failure of ["interrupted", "truncated", "after-final", "forbidden"] as const) {
      snapshotFailure = failure; snapshotFailures = 1; smallSnapshot = true; firstPage = gate();
      const beforeInventories = inventories, beforeDelta = deltas;
      store = new InboxStore(); let exposed = false;
      const unsubscribe = store.subscribe(() => { exposed ||= store.getSnapshot().loaded || store.getSnapshot().mail.length > 0; });
      stop = store.start();
      await until(() => firstPage!.seen, `${failure} receives a real page before failure`);
      assert.equal(store.getSnapshot().loaded, false); assert.deepEqual(store.getSnapshot().mail, []);
      firstPage.release(); firstPage = undefined;
      await until(() => !!store.getSnapshot().error, `${failure} stream is reported as a failed bootstrap`);
      assert.equal(store.getSnapshot().loaded, false);
      assert.deepEqual(store.getSnapshot().mail, []);
      assert.equal(exposed, false, `${failure} never publishes its accumulated summaries`);
      assert.equal(inventories, beforeInventories + 1, "stream retryable flags and transport failures do not broaden the existing automatic retry policy");
      assert.equal(deltas, beforeDelta, "a failed stream never reaches signed catch-up");
      unsubscribe(); snapshotFailure = undefined;
      await store.retry();
      assert.equal(store.getSnapshot().loaded, true, "explicit Retry starts a fresh complete inventory and catch-up");
      assert.equal(inventories, beforeInventories + 2); stop();
    }

    for (const failure of ["expired", "scope"] as const) for (const failures of [1, 2]) {
      snapshotFailure = failure; snapshotFailures = failures; smallSnapshot = true;
      const beforeInventories = inventories, beforeMetadata = hostReads;
      store = new InboxStore(); let partial = false;
      const unsubscribe = store.subscribe(() => { partial ||= !store.getSnapshot().loaded && store.getSnapshot().mail.length > 0; });
      stop = store.start();
      await until(() => store.getSnapshot().loaded || !!store.getSnapshot().error, `${failure} recovery finishes`);
      assert.equal(inventories, beforeInventories + 2, "recognized snapshot failures restart once, never indefinitely");
      assert.equal(hostReads, beforeMetadata + 2, "restart rereads authorized metadata instead of resuming the old selection");
      assert.equal(store.getSnapshot().loaded, failures === 1);
      if (failures === 2) {
        assert.equal(partial, false, "two failed attempts cannot publish either partial inventory");
        assert.deepEqual(store.getSnapshot().mail, []);
      } else assert.ok(store.getSnapshot().mail.length > 0);
      unsubscribe(); stop(); snapshotFailure = undefined;
    }

    firstPage = gate(); smallSnapshot = true; store = new InboxStore(); stop = store.start();
    await until(() => firstPage!.seen, "partial stream held before stopping its generation");
    stop(); stop = undefined;
    const stoppedSnapshot = store.getSnapshot();
    assert.equal(snapshotSignal?.aborted, true, "stop aborts the in-flight snapshot request");
    firstPage.release(); firstPage = undefined; await sleep(50);
    assert.strictEqual(store.getSnapshot(), stoppedSnapshot, "late pages cannot publish after stop");
    assert.equal(store.getSnapshot().loaded, false); assert.deepEqual(store.getSnapshot().mail, []);

    snapshot = gate(); store = new InboxStore(); stop = store.start();
    await until(() => snapshot!.seen, "complete stream held before owner access is revoked");
    const lockedSnapshot = store.getSnapshot(), beforeOwnerDeltas = deltas;
    binding.lock();
    assert.equal(snapshotSignal?.aborted, true, "document-owner revocation aborts the snapshot transport");
    snapshot.release(); snapshot = undefined; await sleep(50);
    assert.strictEqual(store.getSnapshot(), lockedSnapshot, "EOF after owner abort cannot publish or report a new mail state");
    assert.equal(store.getSnapshot().loaded, false); assert.deepEqual(store.getSnapshot().mail, []);
    assert.equal(deltas, beforeOwnerDeltas, "owner-aborted inventory never proceeds to catch-up");
  } finally {
    stop?.(); for (const held of gates) held.release();
    database.close(); await host.close(); await fs.rm(root, { recursive: true, force: true });
    globalThis.fetch = originalFetch; console.info = originalInfo; console.warn = originalWarn;
    for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
test("automatic sorting status never describes blocked or failed processing as healthy", () => {
  const state: AiTriageState = { configured: true, provider: null, problemCode: null,
    settings: { revision: 1, enabled: true, mode: "apply", model: "fixture-model", mailboxIds: null, personalization: true, readingSignals: false, interests: [] },
    queue: { pending: 0, processing: 0, failed: 0 }, jobs: [], cursor: 0,
    usage: { attempts: 0, completed: 0, failed: 0, reused: 0, unknownUsage: 0, unpriced: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningOutputTokens: 0, estimatedMinimumUsd: 0, estimatedMaximumUsd: 0 } };
  assert.deepEqual(aiSortingStatus(state), { tone: "normal", label: "Automatic sorting on" });
  for (const problemCode of ["AI_DRAIN_FAILED", "AI_RECOVERY_LIMIT", "AI_MODEL_UNAVAILABLE", "AI_RESCORE_FAILED"]) {
    const result = aiSortingStatus({ ...state, problemCode });
    assert.equal(result.tone, "warning");
    assert.equal(result.label, "Automatic sorting needs attention");
    assert.ok(result.detail);
  }
  assert.equal(aiSortingStatus({ ...state, queue: { pending: 0, processing: 0, failed: 1 } }).label, "Some mail could not be sorted");
  assert.equal(aiSortingStatus({ ...state, settings: { ...state.settings, mailboxIds: [] } }).tone, "warning");
  assert.equal(aiSortingStatus(state, true).label, "Sorting status unavailable");
  assert.equal(aiSortingStatus(null, true).tone, "warning");
  assert.equal(aiSortingStatus({ ...state, configured: false }).tone, "warning");
  assert.equal(aiSortingStatus({ ...state, settings: { ...state.settings, enabled: false } }).label, "Automatic sorting off");
  assert.equal(aiSortingStatus({ ...state, settings: { ...state.settings, mode: "preview" } }).label, "Preview only");
  assert.equal(aiSortingStatus({ ...state, queue: { pending: 1, processing: 0, failed: 0 } }).label, "Sorting new activity…");
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
  let releaseAction: (() => void) | undefined;
  let aiCapability = false, resultRequests = 0, catchupRequests = 0;
  let catchupGate: Promise<void> | undefined, releaseCatchup: (() => void) | undefined;
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
      if (url.pathname === "/host/config") return Response.json({ mode: "mock", allowProviderWrites: true, providers: [], preferenceScope: "fictional-ai-client", aiTriage: aiCapability });
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
          else resultRequests++;
          return Response.json({ decisions: decision ? [decision] : [], removed: [], cursor: aiState.cursor, hasMore: false, resetRequired: false });
        }
        throw new Error(`Unexpected AI endpoint ${url.pathname}`);
      }
      if (/\/mailboxes\/[^/]+\/messages\/[^/]+$/.test(url.pathname)) bodyReads++;
      if (url.pathname === "/v1/mailbox-snapshot") inventories++;
      const headers = new Headers(init?.headers); headers.set("Authorization", "Bearer fictional-ai-triage-client-token-for-tests");
      const response = await host!.fetch(new Request(url, { ...init, headers }));
      if (url.pathname === "/v1/mailbox-changes" && catchupGate) { catchupRequests++; await catchupGate; }
      return response;
    }) as typeof fetch;
    let store = new InboxStore(); stop = store.start();
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
    const pendingAction = store.act("done", () => new Promise<void>(resolve => { releaseAction = resolve; }), false);
    decision = { ...decision, revision: 2, score: { ...decision.score!, category: "Important", score: 90 } };
    queuedChange = decision; aiState = { ...aiState, cursor: 2 };
    const beforeChanges = changeRequests, unaffected = new Map(store.getSnapshot().mail.filter(mail => mail.sdkThreadId !== selected.sdkThreadId).map(mail => [mail.id, mail]));
    for (let attempt = 0; attempt < 400 && changeRequests === beforeChanges; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(changeRequests > beforeChanges);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(store.getSnapshot().pending, 1);
    assert.equal(store.getSnapshot().mail.find(mail => mail.id === selected.id)?.attentionCategory, "Other", "background AI reconciliation yields to a pending durable mail action");
    releaseAction!(); await pendingAction; releaseAction = undefined;
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

    host.store.receive(source, { from: "ready-ai@example.test", to: nativeBox.email, subject: "Ready AI arrival", text: "Fictional arrival assessed while a mail action is pending.", isRead: false });
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    await store.retry();
    const readyArrival = store.getSnapshot().mail.find(mail => mail.account === primary.id && mail.subject === "Ready AI arrival")!;
    assert.ok(readyArrival.aiHoldUntil && readyArrival.aiHoldUntil > Date.now());
    const pendingArrivalAction = store.act("done", () => new Promise<void>(resolve => { releaseAction = resolve; }), false);
    queuedChange = { ...decision, sourceId: readyArrival.sourceId!, threadId: readyArrival.sdkThreadId!, revision: 3,
      messageIds: readyArrival.messages.map(message => message.id), latestMessageId: readyArrival.messages.at(-1)!.id,
      contextVersions: readyArrival.messages.map(message => ({ messageId: message.id, bodyRevision: message.bodyRevision! })) };
    aiState = { ...aiState, cursor: 3 };
    await store.ai.state();
    for (let attempt = 0; attempt < 100 && store.getSnapshot().mail.find(mail => mail.id === readyArrival.id)?.triage?.revision !== 3; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const ready = store.getSnapshot().mail.find(mail => mail.id === readyArrival.id)!;
    assert.equal(store.getSnapshot().pending, 1);
    assert.equal(ready.triage?.revision, 3, "a ready arrival bypasses historical reconciliation deferral");
    assert.equal(ready.aiHoldUntil, undefined, "resolved arrival holds never wait behind a pending mail action");
    releaseAction!(); await pendingArrivalAction; releaseAction = undefined;

    // Reproduce the reload ordering: saved AI results arrive after the SDK
    // snapshot was projected, but before its unchanged catch-up marks it loaded.
    // This is the current host's ready/task-required shape, bound to the two real
    // canonical SDK messages, not a separate mail or AI-client facade.
    stop(); aiCapability = true;
    decision = { ...decision, revision: 4, settingsRevision: aiState.settings.revision,
      messageIds: replied.messages.map(message => message.id), latestMessageId: replied.messages.at(-1)!.id,
      contextVersions: replied.messages.map(message => ({ messageId: message.id, bodyRevision: message.bodyRevision! })),
      inputPolicyVersion: AI_INPUT_POLICY_VERSION,
      assessment: { ...decision.assessment!, type: "notification", response: "not_needed", task: "required", actions: ["review", "confirm"] } };
    aiState = { ...aiState, cursor: 4 };
    const reloadBodies = bodyReads, reloadInventories = inventories, reloadResults = resultRequests, reloadChanges = changeRequests;
    catchupGate = new Promise(resolve => { releaseCatchup = resolve; });
    store = new InboxStore(); stop = store.start();
    for (let attempt = 0; attempt < 800 && (!catchupRequests || changeRequests === reloadChanges); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(catchupRequests && changeRequests > reloadChanges, "saved results and their delta loaded while SDK catch-up was pending");
    assert.equal(store.getSnapshot().loaded, false);
    assert.equal(resultRequests, reloadResults + 1);
    const reloadedViews = () => store.getSnapshot().mail.filter(mail => mail.sourceId === selected.sourceId && mail.sdkThreadId === selected.sdkThreadId);
    assert.ok(reloadedViews().some(mail => mail.account === UNIFIED_ACCOUNT));
    assert.ok(reloadedViews().every(mail => mail.messages.length === 2));
    const unrelatedReload = new Map(store.getSnapshot().mail.filter(mail => mail.sdkThreadId !== selected.sdkThreadId).map(mail => [mail.id, mail]));
    releaseCatchup!(); catchupGate = undefined;
    for (let attempt = 0; attempt < 200 && (!store.getSnapshot().loaded || reloadedViews().some(mail => mail.triage?.revision !== 4)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.getSnapshot().loaded, true);
    for (const mail of reloadedViews()) {
      assert.equal(mail.triage?.state, "ready", "reload must project the saved assessment after an unchanged SDK catch-up");
      assert.equal(mail.triage?.revision, 4);
      assert.equal(mail.triage?.assessment?.task, "required");
      assert.equal(mail.attentionCategory, "Important");
    }
    for (const [id, mail] of unrelatedReload) assert.strictEqual(store.getSnapshot().mail.find(value => value.id === id), mail);
    assert.equal(bodyReads, reloadBodies, "restoring saved AI results reads no bodies");
    assert.equal(inventories, reloadInventories + 1, "restoring saved AI results needs only the initial SDK snapshot");
    assert.equal(resultRequests, reloadResults + 1, "restoring saved AI results does not retry the result inventory");
    const restoredMail = store.getSnapshot().mail;
    const savedResults = await store.ai.results();
    assert.equal(savedResults.decisions[0].revision, 4);
    assert.strictEqual(store.getSnapshot().mail, restoredMail, "Settings loading the same saved result does not replace an already-restored mail model");

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
    releaseAction?.(); releaseState?.(); releaseCatchup?.(); stop?.(); await host?.close(); await fs.rm(root, { recursive: true, force: true });
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

test("host-service-backed bounded startup pages, lookup and search without browser inventories", async () => {
  if (process.env.INBOX_WINDOW_TEST_CHILD !== "1") {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn("bun", ["--no-env-file", "test", import.meta.filename, "--test-name-pattern", "host-service-backed bounded", "--timeout", "60000"], {
        env: { ...process.env, INBOX_TEST_LIVE: "false", INBOX_WINDOW_TEST_CHILD: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject); child.once("close", code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output); return;
  }
  const [{ createMockHost }, { InboxStore }, { Database }, { createInboxWindowService }, { createInboxViewPreferencesStore },
    { createSplitPreferencesStore }, { createAttentionOverridesStore }, { createAiTriageService }, fs, { tmpdir }, { join }] = await Promise.all([
    import("../../mock-api/src/host.ts"), import("../src/inbox.ts"), import("bun:sqlite"), import("../../local-host/src/inbox-window.ts"),
    import("../../local-host/src/inbox-preferences.ts"), import("../../local-host/src/split-preferences.ts"), import("../../local-host/src/attention-overrides.ts"),
    import("../../local-host/src/ai-triage.ts"), import("node:fs/promises"), import("node:os"), import("node:path"),
  ]);
  const root = await fs.mkdtemp(join(tmpdir(), "host-window-client-"));
  const originalFetch = globalThis.fetch, originalInfo = console.info, originalWarn = console.warn;
  const globals = ["location", "window", "document", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  console.info = () => {}; console.warn = () => {};
  const token = "fictional-window-client-token-only";
  const host = await createMockHost({ dataDir: root, encryptionKey: Buffer.alloc(32, 48).toString("base64"), token, allowProviderWrites: false });
  const database = new Database(join(root, "host-window.sqlite"));
  const preferences = createInboxViewPreferencesStore(database, host.inbox, host.owner);
  const splits = createSplitPreferencesStore(database, host.owner);
  const categories = createAttentionOverridesStore(database, host.inbox, host.owner);
  const ai = createAiTriageService({ database, inbox: host.inbox, configuration: null, sessionKey: token });
  const service = createInboxWindowService({ database, inbox: host.inbox, owner: host.owner, sessionKey: token, allowProviderWrites: false,
    inboxPreferences: preferences, splitPreferences: splits, attentionOverrides: categories, ai });
  let stop: (() => void) | undefined;
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check: () => boolean, message: string) => {
    const deadline = Date.now() + 20000; while (!check() && Date.now() < deadline) await sleep(20); assert.ok(check(), message);
  };
  try {
    const nativeBox = host.store.mailboxes(host.owner)[0];
    const source = { owner: host.owner, storeId: nativeBox.id, accountId: host.store.link(host.owner, nativeBox.id)!.accountId };
    let firstNative: ReturnType<typeof host.store.receive> | undefined;
    for (let index = 0; index < 1200; index++) {
      const received = host.store.receive(source, { from: "window-fixture@example.test", to: nativeBox.email,
        subject: `Window fixture ${String(index).padStart(4, "0")}`, text: "Fictional bounded inbox context." });
      if (!index) firstNative = received;
    }
    let more = true;
    while (more) more = (await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 })).hasMore;
    const box = (await host.inbox.mailboxes(host.owner)).find(box => box.sourceId === source.accountId)!;
    const storage = new Map<string, string>();
    Object.assign(globalThis, { location: new URL(`http://localhost:41999/#/account=${box.id}&folder=All%20Mail&split=Important`), window: new EventTarget(),
      document: { visibilityState: "visible", createElement: () => ({ innerHTML: "", content: { querySelectorAll: () => [] } }) },
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    });
    let inventories = 0, pages = 0, bodyReads = 0;
    let holdQuery = false, heldQuery = false, releaseQuery: (() => void) | undefined;
    const published: number[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === "/host/config") return Response.json({ mode: "mock", allowProviderWrites: false, providers: [], inboxWindow: true });
      if (url.pathname === "/host/inbox-preferences") return Response.json(await preferences.read());
      if (url.pathname.startsWith("/host/inbox/")) {
        assert.equal(init?.method, "POST"); assert.equal(init?.credentials, "include");
        if (url.pathname === "/host/inbox/page") pages++;
        try {
          const body = JSON.parse(String(init?.body));
          const result = await service.dispatch(url.pathname, body);
          if (holdQuery && url.pathname === "/host/inbox/query" && body.folder === "Trash") {
            heldQuery = true;
            await new Promise<void>(resolve => { releaseQuery = resolve; init?.signal?.addEventListener("abort", () => setTimeout(resolve, 100), { once: true }); });
          }
          return Response.json(result);
        }
        catch (cause) { const error = cause as { status?: number; code?: string; message?: string }; return Response.json({ code: error.code, error: error.message }, { status: error.status ?? 500 }); }
      }
      if (url.pathname.includes("mailbox-snapshot") || url.pathname === "/v1/mailbox-messages") inventories++;
      if (/\/messages\//.test(url.pathname)) bodyReads++;
      if (url.pathname === "/v1/events") return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Stopped", "AbortError")); if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${token}`);
      return host.fetch(new Request(url, { ...init, headers }));
    }) as typeof fetch;
    // Finish the host's local index, independently of browser loading. This is not a browser inventory.
    const query = { account: box.id, folder: "All Mail", split: "Important", search: false, query: "", filter: null };
    let warm = await service.dispatch("/host/inbox/query", query) as import("../../shared/inbox-window").InboxWindowPage;
    for (let attempts = 0; warm.state.indexing && attempts < 400; attempts++) {
      await sleep(25); warm = await service.dispatch("/host/inbox/page", { queryId: warm.state.queryId, seek: "start", limit: 100 }) as typeof warm;
    }
    assert.equal(warm.state.indexing, false, "fictional host index is ready");
    const store = new InboxStore(); store.subscribe(() => { if (store.getSnapshot().loaded) published.push(store.getSnapshot().window?.keys.length ?? 0); }); stop = store.start();
    await until(() => store.getSnapshot().window?.keys.length === 300, "first 300 conversations prefetched");
    assert.equal(published[0], 100, "first 100 are usable before prefetch");
    const prefetched = pages; await sleep(150); assert.equal(pages, prefetched, "automatic paging stops at 300");
    assert.equal(inventories, 0, "new host never uses the legacy browser inventory"); assert.equal(bodyReads, 0, "initial rows are body-free");
    const first = store.getSnapshot().mail[0]; store.pinWindow("reader", [first.id]);
    for (let count = 0; count < 8; count++) await store.loadMoreWindow();
    assert.ok(store.getSnapshot().mail.length <= 1000); assert.ok(store.getSnapshot().window!.residentBytes <= 32 * 1024 * 1024);
    assert.strictEqual(store.getSnapshot().mail.find(mail => mail.id === first.id), first, "pinned unchanged row identity survives paging");
    assert.ok(!store.getSnapshot().window!.keys.includes(first.id), "a pinned evicted reader does not inflate the active window");
    await store.loadThread(first.id);
    const cached = store.getSnapshot().mail.find(mail => mail.id === first.id), reads = bodyReads;
    await store.loadThread(first.id);
    assert.equal(bodyReads, reads, "cached open performs no additional body read");
    assert.strictEqual(store.getSnapshot().mail.find(mail => mail.id === first.id), cached, "cached open preserves row identity");
    await store.setWindowQuery({ ...query, search: true, query: "subject:\"Window fixture 0000\"" });
    await until(() => store.getSnapshot().mail.some(mail => mail.subject === "Window fixture 0000"), "host search reaches outside the old browser window");
    const before = [...store.getSnapshot().window!.keys]; await store.lookupWindow([first.id]);
    assert.deepEqual(store.getSnapshot().window!.keys, before, "off-view lookup never inflates active rows or totals");
    // Reader/flag work may have advanced the SDK since the last query page.
    // A 503 is an explicit refusal to capture, not a partially frozen selection.
    let selected: Awaited<ReturnType<typeof store.createWindowSelection>> | undefined;
    for (let attempt = 0; !selected && attempt < 400; attempt++) {
      try { selected = await store.createWindowSelection(); }
      catch (error) { assert.equal((error as { status?: number }).status, 503, "only index-not-current capture rejection is retryable here"); await sleep(25); }
    }
    assert.ok(selected, "capture is accepted only after the host index is current");
    let selectionPage = await store.windowTransport.selectionPage({ selectionId: selected.id });
    for (let attempt = 0; !selectionPage.selection.captureComplete && attempt < 100; attempt++) { await sleep(20); selectionPage = await store.windowTransport.selectionPage({ selectionId: selected.id }); }
    assert.ok(selectionPage.selection.captureComplete, "selection capture completes server-side");
    const captured = await store.resolveWindowSelection(selected); assert.ok(captured.every(mail => mail.window?.targetsComplete));
    assert.equal(captured.length, 1);
    const later = host.store.receive(source, { from: "window-fixture@example.test", to: nativeBox.email, subject: "Window fixture 0000", text: "Fictional later reply.", threadId: firstNative!.threadId });
    await host.inbox.sync(host.owner, source.accountId, { folder: "all", lane: "latest", limit: 100 });
    const reverse = await store.action(captured, "done");
    assert.ok(reverse.receipts?.some(receipt => receipt.kind === "mailbox-state"), "accepted Done exposes typed receipt references for cleanup");
    const original = await host.inbox.mailboxMessageSummary(host.owner, box.id, captured[0].messages[0].id);
    assert.equal(original.memberships[0].done, true);
    const threadPage = await host.inbox.mailboxMessages(host.owner, { mailboxIds: [box.id], search: 'subject:"Window fixture 0000"', limit: 100 });
    const newer = threadPage.items.find(message => message.id !== original.id && message.threadId === original.threadId)!;
    assert.ok(newer, `later fictional reply ${later.id} is indexed`); assert.equal(newer.memberships[0].done, false, "captured Done never inherits a later reply");
    store.pinWindow("reader", []); await store.setWindowQuery({ ...query, folder: "Sent" });
    assert.ok(!store.getSnapshot().mail.some(mail => mail.id === captured[0].id), "captured action row is evicted outside its view");
    await reverse();
    assert.equal((await host.inbox.mailboxMessageSummary(host.owner, box.id, original.id)).memberships[0].done, false, "Undo restores its receipt after eviction");
    holdQuery = true;
    const stale = store.setWindowQuery({ ...query, folder: "Trash" }).catch(error => error);
    await until(() => heldQuery, "old host response is held");
    await store.setWindowQuery(query); releaseQuery?.();
    assert.equal((await stale)?.name, "AbortError");
    assert.equal(store.getSnapshot().window?.query.folder, "All Mail", "late prior-view response cannot replace the active window");
    stop(); stop = undefined;
  } finally {
    stop?.(); await service.close(); await ai.close(); await host.close(); database.close();
    globalThis.fetch = originalFetch; console.info = originalInfo; console.warn = originalWarn;
    for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("guided zero recovery protocol preserves partial credit, exact retries, Undo and legacy traversal", async () => {
  if (!process.versions.bun) {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn("bun", ["--no-env-file", "test", import.meta.filename, "--test-name-pattern", "guided zero recovery protocol", "--timeout", "10000"], {
        env: { ...process.env, INBOX_TEST_LIVE: "false" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject); child.once("close", code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output); return;
  }
  const { ZeroActionRecovery, restoreZeroRecovery, legacyZeroPage, confirmZeroReservation, boundedZeroBatch, assertZeroMembershipBudget, revalidateZeroBatch } = await import("../src/GuidedZero.tsx");
  const { InboxClassificationError } = await import("../src/inbox.ts");
  type Session = import("../../shared/inbox-window").InboxZeroSession;
  type Input = import("../../shared/inbox-window").InboxZeroProgressInput;
  type Result = import("../../shared/inbox-window").InboxZeroProgressResult;
  type UndoInput = import("../../shared/inbox-window").InboxZeroUndoInput;
  type Journal = import("../src/GuidedZero.tsx").ZeroRecoveryJournal;
  type Reverse = import("../src/inbox.ts").InboxUndo;
  const initialSession = (): Session => ({ version: 2, id: "zero-session", account: "box", scopeKey: "captured-scope", revision: 1,
    startedAt: 1, phase: "batches", paused: false, currentId: "a", status: "ready",
    progress: { initialCount: 3, remainingCount: 3, decidedCount: 0, ineligibleCount: 0, unknownCount: 0, captureComplete: true } });
  const journal = (): Journal => ({ version: 1, session: initialSession(), selection: ["a", "b", "c"].map(id => ({ id, decision: "other", reviewVersion: `captured:${id}` })),
    completedIds: [], undoneIds: [], receipts: [], inverseReceipts: [], attempts: [], mailPending: true, undoRequested: false, problem: "" });
  const reverse = (...ids: string[]): Reverse => Object.assign(async () => { throw new Error("The original classifier-wide Undo must not retire pending groups."); }, {
    receipts: ids.map(id => ({ kind: "category" as const, id })),
  });
  // This is a pure protocol fixture, not an SDK or host-service replacement.
  function protocol() {
    let session = initialSession(), saved: Journal | null = null, statuses: Record<string, "accepted" | "pending" | "rejected"> = {};
    let loseProgress = false, loseUndo = false;
    const requests: Input[] = [], inverseRequests: UndoInput[] = [], mailUndos: string[][] = [];
    const persisted = new Map<string, Input>(), inverseBodies = new Map<string, UndoInput>(), credited = new Set<string>();
    const progressResults = new Map<string, Result>();
    const update = () => { session = { ...session, revision: session.revision + 1, progress: { ...session.progress, decidedCount: credited.size, remainingCount: 3 - credited.size } }; return structuredClone(session); };
    const io = {
      save: (value: Journal) => { saved = structuredClone(value); return true; },
      session: (_value: Session) => {},
      undoMail: async (references: import("../../shared/inbox-window").InboxActionReceiptReference[]) => { mailUndos.push(references.map(reference => "id" in reference ? reference.id : reference.target.messageId)); return structuredClone(references); },
      transport: {
        zeroResume: async () => ({ status: "found" as const, session: structuredClone(session) }),
        zeroProgress: async (input: Input): Promise<Result> => {
          assert.deepEqual(saved!.attempts.find(attempt => attempt.input.id === input.id)?.input, input, "the exact progress body is durable before POST");
          if (persisted.has(input.id)) assert.deepEqual(input, persisted.get(input.id), "idempotency identity never receives a rebased/subset body");
          else persisted.set(input.id, structuredClone(input));
          requests.push(structuredClone(input));
          const previous = progressResults.get(input.id);
          const results = input.decisions.map(decision => {
            const before = previous?.results.find(result => result.id === decision.id)?.status;
            return { id: decision.id, status: before && before !== "pending" ? before : statuses[decision.id] ?? "accepted" as const };
          });
          for (const result of results) if (result.status === "accepted") credited.add(result.id);
          const result: Result = { session: update(), results, undo: results.some(result => result.status === "accepted") ? { sessionId: session.id, progressId: input.id } : null };
          progressResults.set(input.id, structuredClone(result));
          if (loseProgress) { loseProgress = false; throw new TypeError("Lost accepted progress response"); }
          return result;
        },
        zeroUndo: async (input: UndoInput) => {
          assert.deepEqual(saved!.attempts.find(attempt => attempt.input.id === input.reference.progressId)?.undoInput, input, "inverse progress identity is saved before POST");
          if (inverseBodies.has(input.id)) assert.deepEqual(input, inverseBodies.get(input.id)); else inverseBodies.set(input.id, structuredClone(input));
          inverseRequests.push(structuredClone(input));
          for (const result of progressResults.get(input.reference.progressId)?.results ?? []) if (result.status === "accepted") credited.delete(result.id);
          const result = { status: "accepted" as const, session: update() };
          if (loseUndo) { loseUndo = false; throw new TypeError("Lost accepted Undo response"); }
          return result;
        },
      },
    };
    return { io, requests, inverseRequests, mailUndos, get saved() { return saved!; }, get session() { return session; },
      statuses: (value: typeof statuses) => { statuses = value; }, loseProgress: () => { loseProgress = true; }, loseUndo: () => { loseUndo = true; } };
  }
  {
    const api = protocol(); let newCommands = 0, exactRetries = 0;
    const record = new ZeroActionRecovery(journal(), api.io);
    const originalRetry = async () => { exactRetries++; return reverse("category-a", "category-bc"); };
    await record.begin(async () => { newCommands++; throw new InboxClassificationError("HOST_CATEGORY_ACK_PENDING", 1, 2, originalRetry, reverse("category-a")); });
    assert.equal(api.session.progress.decidedCount, 1); assert.equal(record.complete, false); assert.equal(record.blocked, true); assert.equal(record.canUndo, true);
    assert.deepEqual(api.requests[0].decisions.map(item => item.id), ["a"], "partial command counts only acknowledged conversations");
    record.journal.session.paused = true; record.checkpoint(); // UI pause does not replace the runtime command closure.
    await record.undo();
    assert.equal(api.session.progress.decidedCount, 0); assert.equal(exactRetries, 0);
    assert.deepEqual(api.mailUndos, [["category-a"]], "Undo targets only acknowledged receipts while later groups remain recoverable");
    assert.equal(record.blocked, true); assert.deepEqual(record.journal.undoneIds, ["a"]);
    await record.retry();
    assert.equal(newCommands, 1); assert.equal(exactRetries, 1, "recovery invokes error.retry, not a new classify call");
    assert.deepEqual(api.requests.at(-1)!.decisions.map(item => item.id), ["b", "c"], "retracted/previously credited prefixes are never credited again");
    assert.equal(api.session.progress.decidedCount, 2); assert.equal(record.complete, true);
  }
  {
    const api = protocol(); let originalRetries = 0;
    const record = new ZeroActionRecovery(journal(), api.io);
    await record.begin(async () => { throw new InboxClassificationError("HOST_CATEGORY_ACK_PENDING", 1, 2,
      async () => { originalRetries++; return reverse("category-a", "category-bc"); }, reverse("category-a")); });
    const reloaded = new ZeroActionRecovery(restoreZeroRecovery(api.saved, initialSession())!, api.io);
    await assert.rejects(reloaded.retry(), /replay is unavailable after reload/);
    assert.equal(originalRetries, 0); assert.equal(api.session.progress.decidedCount, 1);
    assert.equal(reloaded.canUndo, true); assert.deepEqual(reloaded.journal.selection.map(item => item.id), ["a", "b", "c"]);
    await reloaded.undo();
    assert.equal(api.session.progress.decidedCount, 0); assert.equal(reloaded.blocked, true, "unconfirmed original commands remain retained, never silently recreated");
  }
  {
    const api = protocol(); let writes = 0;
    api.loseProgress();
    const record = new ZeroActionRecovery(journal(), api.io);
    await assert.rejects(record.begin(async () => { writes++; return reverse("category-all"); }), /Lost accepted progress/);
    const exact = structuredClone(api.requests[0]);
    const restored = restoreZeroRecovery(JSON.parse(JSON.stringify(api.saved)), initialSession());
    assert.ok(restored); assert.equal(record.blocked, true);
    const reloaded = new ZeroActionRecovery(restored!, api.io);
    await reloaded.retry();
    assert.equal(writes, 1); assert.deepEqual(api.requests[1], exact, "reload resumes the original approved progress ID and body");
    assert.equal(api.session.progress.decidedCount, 3); assert.equal(reloaded.complete, true);
    api.loseUndo();
    await assert.rejects(reloaded.undo(), /Lost accepted Undo/);
    const inverse = structuredClone(api.inverseRequests[0]);
    const resumedUndo = new ZeroActionRecovery(restoreZeroRecovery(api.saved, initialSession())!, api.io);
    await resumedUndo.retry();
    assert.equal(api.mailUndos.length, 1, "reload of an acknowledged mail Undo does not issue it again");
    assert.deepEqual(api.inverseRequests[1], inverse); assert.equal(api.session.progress.decidedCount, 0);
  }
  {
    const api = protocol(); let writes = 0;
    api.statuses({ b: "pending", c: "rejected" });
    const record = new ZeroActionRecovery(journal(), api.io);
    await record.begin(async () => { writes++; return reverse("category-all"); });
    const original = structuredClone(api.requests[0]);
    assert.equal(record.complete, false); assert.equal(api.session.progress.decidedCount, 1);
    api.statuses({ c: "rejected" }); await record.retry();
    assert.equal(record.complete, false); assert.equal(api.session.progress.decidedCount, 2);
    api.statuses({}); await record.retry();
    assert.equal(record.complete, false, "a definitive rejected progress result never becomes a synthetic success"); assert.equal(writes, 1);
    assert.equal(api.session.progress.decidedCount, 2);
    assert.ok(api.requests.every(request => JSON.stringify(request) === JSON.stringify(original)), "accepted/pending/rejected results preserve one original body");
    const foreign = { ...initialSession(), scopeKey: "different-scope" };
    assert.equal(restoreZeroRecovery(api.saved, foreign), null, "captured recovery never widens to another scope");
  }
  {
    const api = protocol();
    const record = new ZeroActionRecovery(journal(), { ...api.io, save: () => false });
    let writes = 0;
    await assert.rejects(record.begin(async () => { writes++; return reverse("category-all"); }), /could not be saved/);
    assert.equal(writes, 0, "storage failure before dispatch cannot create an unrecoverable new command");
  }
  {
    type Item = import("../../shared/inbox-window").InboxZeroItem;
    const items: Item[] = Array.from({ length: 50 }, (_, i) => ({ id: `batch-${i}`, eligibility: "eligible", batchEligibility: "eligible", reviewVersion: `opaque-${i}`,
      batchCandidate: { id: `batch-${i}`, basis: "no-outstanding-work", membershipCount: 11, reviewVersion: `opaque-${i}` } }));
    let remaining = [...items], server = { ...initialSession(), progress: { ...initialSession().progress, initialCount: 50, remainingCount: 50 } };
    const mail = (item: Item): Mail => ({ ...inbox, id: item.id, messages: Array.from({ length: 11 }, (_, i) => ({ ...inbox.messages[0], id: `${item.id}-message-${i}`, pending: false,
      memberships: [{ mailboxId: "box", messageId: `${item.id}-message-${i}`, revision: 1, done: false, snoozedUntil: null }] })) });
    const posts: Input[] = [], readRequests: unknown[] = [], classifications: string[][] = [];
    const read = async (input: Parameters<import("../../shared/inbox-window").InboxWindowTransport["zeroPage"]>[0]) => {
      readRequests.push(input); return { session: server, items: remaining, nextCursor: null, exhausted: true };
    };
    assert.equal(boundedZeroBatch(items).length, 45, "50 safe conversations with 11 memberships offer a 495-membership prefix, not 550");
    assert.throws(() => assertZeroMembershipBudget(items.map(mail)), /at most 500/, "runtime-expanded checked mail is rejected before classification");
    await assert.rejects(revalidateZeroBatch({ sessionId: server.id, cursor: "original-captured-page" }, items, read), /membership budget/);
    assert.equal(readRequests.length, 0, "an oversized edited list cannot even reach batch dispatch preparation");
    while (remaining.length) {
      const offered = boundedZeroBatch(remaining);
      assertZeroMembershipBudget(offered.map(mail));
      await revalidateZeroBatch({ sessionId: server.id, cursor: "original-captured-page" }, offered, read);
      const captured: Journal = { ...journal(), session: server, selection: offered.map(item => ({ id: item.id, decision: "other", reviewVersion: item.reviewVersion! })) };
      const record = new ZeroActionRecovery(captured, { save: () => true, session: next => { server = next; }, undoMail: async refs => refs,
        transport: { zeroResume: async () => ({ status: "found", session: server }), zeroUndo: async () => ({ status: "accepted", session: server }),
          zeroProgress: async input => {
            assert.ok(input.decisions.reduce((sum, decision) => sum + items.find(item => item.id === decision.id)!.batchCandidate!.membershipCount, 0) <= 500, "every progress body stays within the unchanged host limit");
            posts.push(structuredClone(input)); remaining = remaining.filter(item => !input.decisions.some(decision => decision.id === item.id));
            server = { ...server, revision: server.revision + 1, progress: { ...server.progress, remainingCount: remaining.length, decidedCount: 50 - remaining.length } };
            return { session: server, results: input.decisions.map(item => ({ id: item.id, status: "accepted" })), undo: { sessionId: server.id, progressId: input.id } };
          } } });
      await record.begin(async () => { classifications.push(offered.map(item => item.id)); return reverse(`bounded-command-${posts.length}`); });
      assert.equal(record.complete, true);
    }
    assert.deepEqual(classifications.map(ids => ids.length), [45, 5]);
    assert.deepEqual(posts.flatMap(post => post.decisions.map(item => item.id)), items.map(item => item.id), "the suffix remains available for the next confirmed batch, with no selected decisions discarded");
    assert.equal(server.progress.decidedCount, 50);
    assert.ok(readRequests.every(input => (input as { cursor: string }).cursor === "original-captured-page"), "fresh validation never recaptures or widens the queue");
    const reserved = { ...items[0], batchEligibility: "ineligible" as const, batchCandidate: null };
    assert.equal(boundedZeroBatch([reserved, ...items.slice(1)]).some(item => item.id === reserved.id), false, "persisted unchecked reservations never re-enter a later batch");
  }
  {
    const scope = zeroScope("box", [], [{ id: "box", sourceId: "source", sourceGeneration: 1, name: "Box", email: "me@example.test", canSend: false }]);
    const ai = { configured: true, settings: { enabled: true, revision: 2, model: "fixture-model", mode: "apply" } } as AiTriageState;
    const decision: AiDecision = { sourceId: "source", threadId: "thread", revision: 1, settingsRevision: 2, state: "ready", mailboxIds: ["box"], messageIds: ["message"],
      contextVersions: [{ messageId: "message", bodyRevision: "body-1" }], latestMessageId: "message", inputHash: "fixture-hash", model: "fixture-model", schemaVersion: AI_TRIAGE_VERSION, updatedAt: deadline, holdUntil: null,
      assessment: { type: "newsletter", response: "not_needed", task: "none", actions: [], urgency: "none", deadline: null, topics: [], risk: "none_observed", certainty: "clear", reason: "Fictional quiet campaign", evidence: [{ messageRef: "m1", field: "type", quote: "Newsletter" }] },
      score: { category: "Important", score: 55, reasons: [], contributions: [], version: "preference-2" }, override: null, problemCode: null };
    const mail: Mail = { ...inbox, id: "box:thread", account: "box", mailboxId: "box", sourceId: "source", sdkThreadId: "thread", locations: ["Inbox"], attentionCategory: "Important", triage: decision,
      messages: [{ ...inbox.messages[0], id: "message", bodyRevision: "body-1", revision: 1, nativeFolder: "inbox", outgoing: false,
        memberships: [{ mailboxId: "box", messageId: "message", revision: 1, done: false, snoozedUntil: null }] }] };
    const candidate = zeroBatchCandidate(mail, scope, ai, Date.parse(deadline))!; assert.ok(candidate);
    const selected: import("../../shared/inbox-window").InboxZeroItem = { id: mail.id, eligibility: "eligible", batchEligibility: "eligible", reviewVersion: "opaque-same-content", batchCandidate: { ...candidate, reviewVersion: "opaque-same-content" } };
    const changed = { ...mail, triage: { ...decision, revision: 2, assessment: { ...decision.assessment!, task: "required" as const } } };
    assert.equal(zeroReviewVersion(changed, scope), zeroReviewVersion(mail, scope), "a new AI task receipt changes safety without changing the mail body/review identity");
    assert.equal(zeroBatchCandidate(changed, scope, ai, Date.parse(deadline)), null);
    let writes = 0, reads = 0;
    for (const state of ["ineligible", "unknown"] as const) {
      await assert.rejects((async () => {
        await revalidateZeroBatch({ sessionId: initialSession().id, cursor: "frozen-page" }, [selected], async input => {
          reads++; assert.equal(input.cursor, "frozen-page");
          return { session: initialSession(), items: [{ ...selected, batchEligibility: state, batchCandidate: null }], nextCursor: null, exhausted: true };
        });
        writes++;
      })(), /Review it individually/);
    }
    assert.equal(reads, 2); assert.equal(writes, 0, "task/stale/manual/unavailable fresh proof cannot reach automatic batch classification");
    assert.equal(zeroEligible(changed, scope, Date.parse(deadline)), true, "the conversation remains available for an individual manual decision");
  }
  {
    const api = protocol(); let writes = 0, saves = 0;
    const raw = journal(); raw.selection[0].reviewVersion = JSON.stringify(["Private subject", "person@example.test", "snippet"]);
    const record = new ZeroActionRecovery(raw, { ...api.io, save: () => { saves++; return true; } });
    await assert.rejects(record.begin(async () => { writes++; return reverse("category-all"); }), /opaque cleanup review tokens/);
    assert.equal(writes, 0); assert.equal(saves, 0, "legacy content-bearing host review versions never enter browser recovery storage");
    assert.equal(restoreZeroRecovery(raw, initialSession()), null);
  }
  {
    const api = protocol(); let writes = 0, replays = 0;
    const command: import("../src/inbox.ts").InboxCommandRecovery = { version: 1, owner: null, sources: [{ sourceId: "source", generation: 1, mailboxIds: ["box"] }], kind: "mailbox-state",
      input: { id: "frozen-done-command", done: true, targets: ["a", "b", "c"].map(messageId => ({ mailboxId: "box", messageId, revision: 1 })) }, status: "uncertain", before: [], accepted: [] };
    const record = new ZeroActionRecovery(journal(), api.io);
    await assert.rejects(record.begin(async sink => { sink(command); writes++; throw new TypeError("Lost original command acknowledgement"); }), /Lost original/);
    const restored = restoreZeroRecovery(JSON.parse(JSON.stringify(api.saved)), initialSession()); assert.ok(restored);
    const reloaded = new ZeroActionRecovery(restored!, { ...api.io, replayMail: async (captured, sink) => {
      replays++; assert.deepEqual(captured, command, "reload hands the exact frozen command to the store, never fresh mail");
      sink({ ...captured, status: "accepted" } as typeof command);
      return Object.assign(async () => {}, { receipts: [{ kind: "mailbox-state" as const, id: command.input.id }] });
    } });
    assert.equal(replays, 0, "rehydration never dispatches a mail mutation");
    await reloaded.retry(); assert.equal(replays, 1); assert.equal(writes, 1); assert.equal(reloaded.complete, true);
    assert.equal(api.saved.command?.kind, "mailbox-state");
  }
  {
    const input: Input = { sessionId: initialSession().id, id: "original-reservation", ifRevision: 1, decisions: [], reviewOnlyIds: ["a"] };
    let saved: Input | null = null, sends = 0, acknowledged = false;
    const requests: Input[] = [];
    const persist = (value: Input | null) => { saved = structuredClone(value); return true; };
    const send = async (value: Input): Promise<Result> => {
      assert.deepEqual(saved, input, "checkbox exclusion is durable before the host call");
      requests.push(structuredClone(value));
      if (++sends === 1) throw new TypeError("Lost reservation acknowledgement");
      acknowledged = true; return { session: { ...initialSession(), revision: 2 }, results: [], undo: null };
    };
    await assert.rejects(confirmZeroReservation(input, persist, send), /Lost reservation/);
    assert.deepEqual(saved, input); assert.equal(acknowledged, false);
    await confirmZeroReservation(JSON.parse(JSON.stringify(saved)), persist, send);
    assert.equal(saved, null); assert.equal(acknowledged, true); assert.deepEqual(requests[0], requests[1], "reload replays the same reservation ID/body instead of silently losing unchecked IDs");
    await assert.rejects(confirmZeroReservation(input, () => false, send), /could not be saved/);
    assert.equal(sends, 2, "a reservation storage failure blocks dispatch and dependent decisions");
  }
  {
    const ids = Array.from({ length: ZERO_QUEUE_LIMIT }, (_, index) => `legacy-${index}`);
    const original = [...ids], requests: string[][] = [];
    const first = await legacyZeroPage(ids, 0, 1, async wanted => { requests.push(wanted); return []; });
    const second = await legacyZeroPage(ids, first.next, 1, async wanted => { requests.push(wanted); throw new Error("Captured eligibility unknown"); });
    assert.ok(second.error); assert.equal(second.next, 200);
    const found = { ...inbox, id: ids[230] };
    const third = await legacyZeroPage(ids, second.next, 1, async wanted => { requests.push(wanted); return [found]; });
    assert.deepEqual(third.rows, [found]); assert.ok(requests.every(request => request.length === 100));
    const last = await legacyZeroPage(ids, ids.length - 10, 1, async wanted => { requests.push(wanted); return []; });
    assert.equal(last.exhausted, true); assert.equal(last.rows.length, 0);
    assert.deepEqual(ids, original, "unavailable pages and captured-ID exhaustion never truncate the legacy queue or credit decisions");
    const previous = await legacyZeroPage(ids, 230, -1, async wanted => { requests.push(wanted); return []; });
    assert.equal(previous.next, 130); assert.equal(previous.requested[0], ids[230]);
  }
});

test("bounded host windows expose only the active server view and retain unknown totals", () => {
  const base = inbox;
  const pinned = { ...base, id: "pinned", folder: "Done", split: "Other" };
  const active = { ...base, id: "active", split: "Other", unread: false };
  const window = { keys: [active.id], totals: { conversations: null, messages: null, inbox: null, splits: { Important: null, Other: null }, folders: {}, holding: null } };
  const view = selectMailView([pinned, active], base.account, "Inbox", "Important", { ...defaultPreferences, hideEmptySplits: true }, false, "", "Unread", undefined, false, window);
  assert.deepEqual(view.visibleMail, [active], "host predicate wins over partial local flags and inactive/pinned rows never enter the view");
  assert.equal(view.inboxCount, null);
  assert.equal(view.splitCounts.Important, null);
  assert.ok(view.shownSplits.includes("Other"), "an unknown split is not an empty split");
});

test("sender host extraction normalizes IDNs without accepting URLs, extra addresses or IP literals", () => {
  assert.equal(senderHostname("mail@em1.Cloudflare.com"), "em1.cloudflare.com");
  assert.equal(senderHostname("mail@bücher.de"), "xn--bcher-kva.de");
  assert.equal(senderHostname("mail@em1.cloudflare.com."), "em1.cloudflare.com");
  for (const address of ["a@b@cloudflare.com", "Cloudflare <mail@cloudflare.com>", "a@cloudflare.com/path", "a@cloudflare.com?x=1", "a@cloudflare.com:443", "a@127.0.0.1", "a@[::1]", "a@localhost"]) {
    assert.equal(senderHostname(address), null, address);
  }
});
