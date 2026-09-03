import test from "node:test";
import assert from "node:assert/strict";
import { accounts, seedMail, type Draft, type Mail } from "../src/data.ts";
import { matchesSearch } from "../src/mail-search.ts";
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
