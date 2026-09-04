import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveMailShortcut,
  type MailShortcutContext,
  type MailShortcutEvent,
} from "../src/mail-shortcuts.ts";

function resolve(
  key: string,
  context: Partial<MailShortcutContext> = {},
  event: Omit<MailShortcutEvent, "key"> = {},
) {
  return resolveMailShortcut(
    { key, ...event },
    { mode: "list", hasHighlightedMail: true, ...context },
  );
}

test("W records a negative-feedback action distinct from E, respecting editing and modal boundaries", () => {
  assert.deepEqual(resolve("e"), { type: "triage", action: "done" });
  assert.deepEqual(resolve("w"), { type: "triage", action: "not-important" });
  assert.deepEqual(resolve("w", { mode: "reader" }), { type: "triage", action: "not-important" });
  for (const context of [{ editing: true }, { modal: true }, { settings: true }, { mode: "composer" }, { mode: "auxiliary" }, { navigation: true }] as const) assert.equal(resolve("w", context), null);
  assert.equal(resolve("w", {}, { metaKey: true }), null);
  assert.deepEqual(resolve("i", { sequence: true }), { type: "goFolder", folder: "Inbox", split: "Important", clearSequence: true });
  assert.deepEqual(resolve("o", { sequence: true }), { type: "goFolder", folder: "Inbox", split: "Other", clearSequence: true });
});

test("selection shortcuts distinguish the list, drafts, readers, and text editing", () => {
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
    assert.deepEqual(resolve("a", {}, modifier), {
      type: "selectAll",
      fromHere: true,
    });
    assert.deepEqual(resolve("A", {}, { ...modifier, shiftKey: true }), {
      type: "selectAll",
      fromHere: false,
    });
    for (const context of [
      { editing: true },
      { isDrafts: true },
      { mode: "reader" },
      { mode: "auxiliary" },
      { mode: "composer" },
    ] as const)
      assert.equal(resolve("a", context, modifier), null);
  }
});

test("Enter opens a row or replies in the reader, never hijacking editors or controls", () => {
  assert.deepEqual(resolve("Enter"), {
    type: "openConversation",
    drafts: false,
  });
  assert.deepEqual(resolve("Enter", { isDrafts: true }), {
    type: "openConversation",
    drafts: true,
  });
  assert.deepEqual(resolve("Enter", { hasHighlightedMail: false }), {
    type: "openConversation",
    drafts: false,
  });
  assert.deepEqual(resolve("Enter", { mode: "reader" }), {
    type: "reply",
    mode: "replyAll",
    popOut: false,
  });
  assert.deepEqual(resolve("Enter", { mode: "reader" }, { shiftKey: true }), {
    type: "reply",
    mode: "replyAll",
    popOut: true,
  });
  for (const mode of ["list", "reader"] as const) {
    assert.equal(resolve("Enter", { mode, editing: true }), null);
    assert.equal(resolve("Enter", { mode, interactive: true }), null);
    assert.equal(resolve("Enter", { mode }, { metaKey: true }), null);
    assert.equal(resolve("Enter", { mode }, { altKey: true }), null);
  }
  assert.equal(resolve("Enter", { mode: "composer" }), null);
  for (const key of ["Enter", " ", "Tab"])
    assert.equal(resolve(key, { interactive: true, sequence: true }), null);
});

test("Shift R filters a list but pops out a reader reply", () => {
  assert.deepEqual(resolve("R", {}, { shiftKey: true }), {
    type: "filter",
    name: "No reply",
  });
  assert.deepEqual(resolve("R", { mode: "reader" }, { shiftKey: true }), {
    type: "reply",
    mode: "reply",
    popOut: true,
  });
  assert.deepEqual(resolve("r", { mode: "reader" }), {
    type: "reply",
    mode: "reply",
    popOut: false,
  });
  assert.equal(resolve("r"), null);
  assert.deepEqual(resolve("f", { mode: "reader" }), {
    type: "reply",
    mode: "forward",
    popOut: false,
  });
  assert.deepEqual(resolve("F", { mode: "reader" }, { shiftKey: true }), {
    type: "reply",
    mode: "forward",
    popOut: true,
  });
});

test("Control account numbers work in inputs and the account dialog, but not other modals", () => {
  for (let index = 0; index < 9; index++) {
    const key = String(index + 1);
    assert.deepEqual(resolve(key, { editing: true }, { ctrlKey: true }), {
      type: "account",
      index,
    });
    assert.deepEqual(
      resolve(
        key,
        { mode: "composer", modal: true, accountDialog: true, editing: true },
        { ctrlKey: true },
      ),
      { type: "account", index },
    );
    assert.equal(
      resolve(key, { modal: true, editing: true }, { ctrlKey: true }),
      null,
    );
    assert.equal(resolve(key, {}, { ctrlKey: true, altKey: true }), null);
    assert.equal(resolve(key, {}, { ctrlKey: true, metaKey: true }), null);
    assert.equal(resolve(key, {}, { metaKey: true }), null);
  }
  assert.deepEqual(resolve("0", {}, { ctrlKey: true }), { type: "unified" });
  assert.deepEqual(resolve("0", { editing: true, modal: true, accountDialog: true }, { ctrlKey: true }), { type: "unified" });
  assert.equal(resolve("0", { modal: true }, { ctrlKey: true }), null);
  assert.equal(resolve("0", {}, { metaKey: true }), null);
  assert.deepEqual(resolve("2", { settings: true }, { ctrlKey: true }), {
    type: "account",
    index: 1,
  });
  assert.deepEqual(resolve("1", {}, { ctrlKey: true, shiftKey: true }), {
    type: "account",
    index: 0,
  });
});

test("command and floating draft focus shortcuts precede editing guards", () => {
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
    assert.deepEqual(resolve("k", { editing: true }, modifier), {
      type: "command",
    });
    assert.deepEqual(
      resolve("K", { mode: "composer", editing: true }, modifier),
      { type: "command" },
    );
    assert.equal(
      resolve("k", { settings: true }, { ...modifier, altKey: true }),
      null,
    );
    assert.equal(
      resolve("k", { editing: true, richText: true }, modifier),
      null,
    );
    assert.equal(resolve("k", { modal: true }, modifier), null);
    assert.equal(resolve("K", {}, { ...modifier, shiftKey: true }), null);
    assert.deepEqual(
      resolve(
        "d",
        {
          mode: "composer",
          editing: true,
          richText: true,
          floatingDraft: true,
        },
        modifier,
      ),
      { type: "toggleFocus" },
    );
    assert.equal(
      resolve(
        "d",
        { floatingDraft: true, settings: true },
        { ...modifier, altKey: true },
      ),
      null,
    );
    assert.equal(
      resolve("d", { floatingDraft: true, modal: true }, modifier),
      null,
    );
    assert.equal(
      resolve("d", { floatingDraft: true }, { ...modifier, shiftKey: true }),
      null,
    );
    assert.equal(resolve("d", {}, modifier), null);
  }
});

test("Escape is global except for modal, composing, and already-handled events", () => {
  for (const context of [
    {},
    { editing: true },
    { settings: true },
    { navigation: true },
    { mode: "composer" },
  ] as const)
    assert.deepEqual(resolve("Escape", context), { type: "escape" });
  assert.equal(resolve("Escape", { modal: true }), null);
  for (const key of ["Escape", "e", "g", "k", "1"])
    for (const event of [{ isComposing: true }, { defaultPrevented: true }])
      assert.equal(resolve(key, {}, { ...event, ctrlKey: true }), null);
});

test("browser and operating system modifier combinations are left native", () => {
  for (const key of [
    "f",
    "p",
    "t",
    "r",
    "w",
    "c",
    "v",
    "x",
    "z",
    "[",
    "]",
    "{",
    "}",
  ])
    for (const shiftKey of [false, true])
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }])
        assert.equal(
          resolve(key, {}, { ...modifier, shiftKey }),
          null,
          `${key}, shift=${shiftKey}`,
        );
  assert.equal(resolve("/", {}, { metaKey: true }), null);
  assert.deepEqual(resolve("/", {}, { ctrlKey: true }), { type: "copyLink" });
  assert.equal(resolve("/", { editing: true }, { ctrlKey: true }), null);
  for (const key of ["e", "g", "j", "Enter", "ArrowLeft", "0"])
    assert.equal(resolve(key, {}, { altKey: true }), null);
});

test("G sequences choose explicit Inbox splits, labels, and shared folder destinations", () => {
  assert.deepEqual(resolve("g"), { type: "sequence", phase: "start" });
  assert.equal(resolve("G", {}, { shiftKey: true }), null);
  assert.deepEqual(resolve("g", { sequence: true }), {
    type: "sequence",
    phase: "start",
  });
  assert.deepEqual(resolve("i", { sequence: true }), {
    type: "goFolder",
    folder: "Inbox",
    split: "Important",
    clearSequence: true,
  });
  assert.deepEqual(resolve("O", { sequence: true }, { shiftKey: true }), {
    type: "goFolder",
    folder: "Inbox",
    split: "Other",
    clearSequence: true,
  });
  assert.deepEqual(resolve("l", { sequence: true }), {
    type: "labelMode",
    mode: "navigate",
    clearSequence: true,
  });
  for (const [key, folder] of [
    ["s", "Starred"],
    ["d", "Drafts"],
    ["t", "Sent"],
    ["e", "Done"],
    ["h", "Reminders"],
    ["m", "Muted"],
    [";", "Snippets"],
    ["!", "Spam"],
    ["#", "Trash"],
    ["a", "All Mail"],
  ])
    assert.deepEqual(resolve(key, { sequence: true }), {
      type: "goFolder",
      folder,
      clearSequence: true,
    });
  assert.deepEqual(resolve("q", { sequence: true }), {
    type: "sequence",
    phase: "clear",
  });
  assert.deepEqual(resolve("c", { sequence: true }), {
    type: "compose",
    popOut: false,
    clearSequence: true,
  });
  assert.deepEqual(resolve("R", { sequence: true }, { shiftKey: true }), {
    type: "filter",
    name: "No reply",
    clearSequence: true,
  });
  assert.equal(resolve("i", { sequence: false }), null);
  assert.equal(resolve("i", { sequence: true, editing: true }), null);
  assert.deepEqual(resolve("k", { sequence: true }, { metaKey: true }), {
    type: "command",
  });
});

test("auxiliary views permit calendar and G navigation, not hidden mailbox actions", () => {
  for (const mode of ["list", "reader", "auxiliary"] as const) {
    assert.deepEqual(resolve("0", { mode }), { type: "calendar", view: "day" });
    assert.deepEqual(resolve("2", { mode }), {
      type: "calendar",
      view: "week",
    });
  }
  assert.deepEqual(resolve("g", { mode: "auxiliary" }), {
    type: "sequence",
    phase: "start",
  });
  assert.deepEqual(resolve("i", { mode: "auxiliary", sequence: true }), {
    type: "goFolder",
    folder: "Inbox",
    split: "Important",
    clearSequence: true,
  });
  assert.deepEqual(resolve("l", { mode: "auxiliary", sequence: true }), {
    type: "labelMode",
    mode: "navigate",
    clearSequence: true,
  });
  assert.deepEqual(resolve("x", { mode: "auxiliary", sequence: true }), {
    type: "sequence",
    phase: "clear",
  });
  for (const key of [
    "e",
    "#",
    "!",
    "x",
    "u",
    "s",
    "c",
    "/",
    ",",
    "j",
    "ArrowLeft",
    "Enter",
    "Tab",
    " ",
    "z",
    "v",
    "y",
    "U",
  ])
    assert.equal(resolve(key, { mode: "auxiliary" }), null, key);
  assert.equal(resolve("0", {}, { shiftKey: true }), null);
});

test("drawer navigation overrides mail keys but follows global modifier and calendar shortcuts", () => {
  assert.deepEqual(resolve("ArrowDown", { navigation: true }), {
    type: "drawerNavigate",
    delta: 1,
  });
  assert.deepEqual(resolve("ArrowUp", { navigation: true }), {
    type: "drawerNavigate",
    delta: -1,
  });
  assert.deepEqual(
    resolve("ArrowRight", { navigation: true, interactive: true }),
    { type: "drawerActivate" },
  );
  assert.deepEqual(
    resolve("ArrowUp", { navigation: true }, { metaKey: true }),
    { type: "jump", edge: "top" },
  );
  assert.deepEqual(resolve("a", { navigation: true }, { metaKey: true }), {
    type: "selectAll",
    fromHere: true,
  });
  assert.deepEqual(resolve("2", { navigation: true }), {
    type: "calendar",
    view: "week",
  });
  for (const key of ["Enter", "Tab", " ", "j", "e", "g", "i", "ArrowLeft"])
    assert.equal(resolve(key, { navigation: true, sequence: true }), null, key);
});

test("list movement, paging, splits, and opening retain their distinct contexts", () => {
  assert.deepEqual(resolve("ArrowLeft"), {
    type: "openDrawer",
  });
  assert.deepEqual(resolve("ArrowRight"), {
    type: "openConversation",
    drafts: false,
  });
  assert.deepEqual(resolve("ArrowRight", { isDrafts: true }), {
    type: "openConversation",
    drafts: false,
  });
  assert.equal(resolve("ArrowRight", { hasHighlightedMail: false }), null);
  for (const key of ["j", "ArrowDown"])
    assert.deepEqual(resolve(key), { type: "navigateConversation", delta: 1 });
  for (const key of ["k", "ArrowUp"])
    assert.deepEqual(resolve(key), {
      type: "navigateConversation",
      delta: -1,
    });
  assert.equal(resolve("J", {}, { shiftKey: true }), null);
  assert.equal(resolve("K", {}, { shiftKey: true }), null);
  assert.deepEqual(
    resolve("ArrowDown", { isDrafts: true }, { ctrlKey: true }),
    { type: "jump", edge: "bottom" },
  );
  assert.equal(
    resolve("ArrowDown", { mode: "reader" }, { ctrlKey: true }),
    null,
  );
  assert.deepEqual(resolve(" "), { type: "page", delta: 1 });
  assert.deepEqual(resolve(" ", {}, { shiftKey: true }), {
    type: "page",
    delta: -1,
  });
  assert.equal(resolve(" ", { mode: "reader" }), null);
  assert.deepEqual(resolve("Tab"), { type: "split", delta: 1 });
  assert.deepEqual(resolve("Tab", {}, { shiftKey: true }), {
    type: "split",
    delta: -1,
  });
  assert.equal(resolve("Tab", { search: true }), null);
  assert.equal(resolve("Tab", { mode: "reader" }), null);
});

test("reader horizontal arrows switch conversations while vertical arrows stay within the reader", () => {
  for (const [key, delta] of [["ArrowLeft", -1], ["ArrowRight", 1], ["k", -1], ["j", 1]] as const)
    assert.deepEqual(resolve(key, { mode: "reader" }), { type: "navigateConversation", delta });
  // ThreadView owns message reveal/focus, including keys forwarded from its HTML iframe.
  for (const key of ["ArrowUp", "ArrowDown", "n", "p"])
    assert.equal(resolve(key, { mode: "reader" }), null, key);
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
    for (const context of [{ editing: true }, { settings: true }, { modal: true }, { mode: "composer" }, { mode: "auxiliary" }] as const)
      assert.equal(resolve(key, { mode: "reader", ...context }), null, key);
    for (const event of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { isComposing: true }, { defaultPrevented: true }])
      assert.equal(resolve(key, { mode: "reader" }, event), null, key);
  }
  assert.deepEqual(resolve("ArrowUp", { mode: "reader", navigation: true }), { type: "drawerNavigate", delta: -1 });
  assert.deepEqual(resolve("ArrowDown", { mode: "reader", navigation: true }), { type: "drawerNavigate", delta: 1 });
  assert.deepEqual(resolve("ArrowRight", { mode: "reader", navigation: true }), { type: "drawerActivate" });
});

test("mail actions retain exact shifted key semantics", () => {
  assert.deepEqual(resolve("c"), { type: "compose", popOut: false });
  assert.deepEqual(resolve("C", {}, { shiftKey: true }), {
    type: "compose",
    popOut: true,
  });
  assert.deepEqual(resolve("/"), { type: "search" });
  assert.deepEqual(resolve(","), { type: "settings" });
  assert.deepEqual(resolve("x"), { type: "toggleSelection" });
  assert.equal(resolve("x", { hasHighlightedMail: false }), null);
  assert.equal(resolve("X", {}, { shiftKey: true }), null);
  for (const [key, name] of [
    ["U", "Unread"],
    ["S", "Starred"],
    ["I", "Important"],
    ["R", "No reply"],
  ])
    assert.deepEqual(resolve(key, {}, { shiftKey: true }), {
      type: "filter",
      name,
    });
  for (const [key, action] of [
    ["e", "done"],
    ["h", "remind"],
    ["s", "star"],
    ["u", "unread"],
    ["#", "trash"],
    ["!", "spam"],
  ])
    assert.deepEqual(resolve(key), { type: "triage", action });
  assert.deepEqual(resolve("E", {}, { shiftKey: true }), {
    type: "triage",
    action: "inbox",
  });
  assert.deepEqual(resolve("M", {}, { shiftKey: true }), {
    type: "triage",
    action: "mute",
  });
  assert.deepEqual(resolve("l"), { type: "labelMode", mode: "toggle" });
  assert.deepEqual(resolve("V", {}, { shiftKey: true }), {
    type: "labelMode",
    mode: "move",
  });
  assert.deepEqual(resolve("y"), {
    type: "removeLabels",
    all: false,
    delta: 0,
  });
  assert.deepEqual(resolve("Y", {}, { shiftKey: true }), {
    type: "removeLabels",
    all: true,
    delta: 0,
  });
  assert.deepEqual(resolve("["), {
    type: "removeLabels",
    all: false,
    delta: 1,
  });
  assert.deepEqual(resolve("]"), {
    type: "removeLabels",
    all: false,
    delta: -1,
  });
  for (const key of ["{", "}", "U", "S", "L", "H"])
    assert.equal(
      resolve(key, { mode: "reader" }, { shiftKey: true }),
      null,
      key,
    );
  assert.deepEqual(resolve("z"), { type: "undo" });
  assert.equal(resolve("Z", {}, { shiftKey: true }), null);
  assert.equal(resolve("?", {}, { shiftKey: true }), null);
});

test("ordinary typing and mail shortcuts do not leak from editors, settings, or composer", () => {
  for (const key of [
    "e",
    "h",
    "s",
    "u",
    "l",
    "g",
    "c",
    "x",
    "r",
    "v",
    "y",
    "j",
    "z",
    " ",
    "Enter",
    "Tab",
    "0",
    "2",
    "/",
    ",",
    "ArrowLeft",
    "ArrowDown",
  ])
    for (const context of [
      { editing: true },
      { settings: true },
      { modal: true },
      { mode: "composer" },
    ] as const)
      assert.equal(resolve(key, context), null, key);
  for (const key of [
    "a",
    "b",
    "d",
    "f",
    "i",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "t",
    "1",
    "9",
    "?",
  ])
    assert.equal(resolve(key), null, key);
});
