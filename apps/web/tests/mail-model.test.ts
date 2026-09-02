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
