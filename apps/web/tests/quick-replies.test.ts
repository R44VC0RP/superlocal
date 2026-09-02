import test from "node:test";
import assert from "node:assert/strict";
import {
  canUseQuickReplies,
  getQuickReplies,
  quickReplyBody,
} from "../src/quick-replies.ts";

test("quick responses fill only empty replies, never existing writing or forwards", () => {
  const response = { label: "Thanks", body: "Thanks for the update!" };
  for (const body of ["", "<p><br></p>", "<div><b><br></b></div>", "&nbsp;"]) {
    assert.equal(
      quickReplyBody({ mode: "replyAll", body }, response),
      "<p>Thanks for the update!</p>",
    );
  }
  for (const body of [
    "My own reply",
    "<p>Keep this text</p>",
    '<img src="photo.png">',
    "<blockquote><br></blockquote>",
    '<a href="https://example.com"> </a>',
  ]) {
    assert.equal(quickReplyBody({ mode: "reply", body }, response), null);
  }
  assert.equal(canUseQuickReplies({ mode: "forward", body: "" }), false);
  assert.equal(canUseQuickReplies({ mode: "new", body: "" }), false);
});

test("inserting a canned response escapes markup and preserves line breaks", () => {
  const draft = { mode: "reply" as const, body: "" };
  const html = quickReplyBody(draft, {
    label: "Example",
    body: "Thanks <Ryan> & team\nI'll take a look.",
  });
  assert.equal(
    html,
    "<p>Thanks &lt;Ryan&gt; &amp; team<br>I&#39;ll take a look.</p>",
  );
  assert.equal(draft.body, "");
});

test("app-specific canned copy is not offered for unrelated messages", () => {
  const apps = getQuickReplies({
    from: "Basecamp",
    subject: "Be sure to get the apps",
  });
  assert.equal(apps[0].label, "Thanks for the reminder!");
  const other = getQuickReplies({
    from: "The Browser",
    subject: "Five things worth reading",
  });
  assert.equal(
    other.some((reply) => reply.body.includes("Basecamp")),
    false,
  );
});
