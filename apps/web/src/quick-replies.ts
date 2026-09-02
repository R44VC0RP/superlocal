import type { Draft, Mail } from "./data.ts";
import { escapeHTML } from "./mail-text.ts";

export type QuickReply = { label: string; body: string };

const appReplies: QuickReply[] = [
  {
    label: "Thanks for the reminder!",
    body: "Thanks for the reminder! I'll make sure to download the Basecamp apps for better notifications and organization. Appreciate the links!",
  },
  {
    label: "I'll check them out",
    body: "Thanks for sharing! I'll check out the Basecamp apps.",
  },
  {
    label: "Not interested, thanks",
    body: "Thanks for reaching out. I'm happy using Basecamp in the browser for now.",
  },
];

const defaultReplies: QuickReply[] = [
  {
    label: "Thanks for the update!",
    body: "Thanks for the update! I appreciate you keeping me in the loop.",
  },
  {
    label: "I'll take a look",
    body: "Thanks for sharing. I'll take a look and get back to you.",
  },
  { label: "Thanks, received", body: "Received, thank you!" },
];

export function getQuickReplies(
  mail: Pick<Mail, "from" | "subject">,
): QuickReply[] {
  return mail.from === "Basecamp" && /apps/i.test(mail.subject)
    ? appReplies
    : defaultReplies;
}

export function canUseQuickReplies(
  draft: Pick<Draft, "mode" | "body">,
): boolean {
  if (draft.mode !== "reply" && draft.mode !== "replyAll") return false;
  // Only empty editor formatting is disposable; preserve images, links, and quotes.
  return !draft.body
    .replace(
      /<\/?(?:p|div|span|br|b|strong|i|em|u|s|strike|font)\b[^>]*>/gi,
      "",
    )
    .replace(/&nbsp;|&#160;|\u00a0|\u200b|\ufeff/g, " ")
    .trim();
}

export function quickReplyBody(
  draft: Pick<Draft, "mode" | "body">,
  reply: QuickReply,
): string | null {
  return canUseQuickReplies(draft)
    ? `<p>${escapeHTML(reply.body).replaceAll("\n", "<br>")}</p>`
    : null;
}
