import type { MailboxMembership } from "inbox-sdk/types";
import type { AttentionDecision } from "../../shared/mail-attention";

export { readSaved as loadSaved } from "./storage.ts";

export type Attachment = {
  name: string;
  size: number;
  type: string;
  data?: string;
  blobId?: string;
  sourceId?: string;
};
export type Message = {
  id: string;
  from: string;
  email: string;
  to: string;
  cc?: string;
  bcc?: string;
  date: string;
  receivedAt?: string;
  body: string;
  bodyText?: string;
  bodyFormat?: "html" | "text";
  bodyDocument?: { html: string; styles: string };
  attachments?: Attachment[];
  scheduledAt?: string;
  cancelled?: boolean;
  revision?: number;
  loaded?: boolean;
  outgoing?: boolean;
  hasAttachments?: boolean;
  operationId?: string;
  sendStatus?: "pending" | "processing" | "succeeded" | "partial" | "failed" | "cancelled" | "uncertain";
  pending?: boolean;
  nativeFolder?: string;
  isRead?: boolean;
  isStarred?: boolean;
  memberships?: MailboxMembership[];
  attention?: AttentionDecision;
};
export type Mail = {
  id: string;
  account: string;
  from: string;
  email: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  group: string;
  split: string;
  folder: string;
  unread: boolean;
  starred: boolean;
  labels: string[];
  messages: Message[];
  opened?: string;
  muted?: boolean;
  reminder?: string;
  scheduled?: string;
  reminderAt?: number;
  receivedAt?: number;
  sourceId?: string;
  mailboxId?: string;
  sdkThreadId?: string;
  accountEmail?: string;
  locations?: string[];
  operationId?: string;
  mailboxIds?: string[];
  mailboxNames?: string[];
};
export type Draft = {
  id: string;
  account: string;
  mode: "new" | "reply" | "replyAll" | "forward";
  threadId?: string;
  popOut?: boolean;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments: Attachment[];
  updated: number;
  sourceId?: string;
  sourceMessageId?: string;
  revision?: number;
  saving?: boolean;
  dirty?: boolean;
  saveError?: string;
  from?: string;
};
export type MailboxOption = {
  id: string;
  sourceId: string;
  name: string;
  email: string;
  canSend: boolean;
  selectorKind?: "all" | "domain" | "address";
};
export type SendOptions = { instant?: boolean; markDone?: boolean };
export type Preferences = {
  theme: string;
  density: string;
  font: string;
  fontSize: string;
  defaultReply: string;
  sendDelay: string;
  readReceipts: boolean;
  desktopNotifications: boolean;
  notificationSound: boolean;
  showSnippets: boolean;
  recentOpens: boolean;
  signature: string;
  signatureEnabled: boolean;
  autoAdvance: boolean;
  markRead: boolean;
  spellcheck: boolean;
  splits: string[];
  startWeek: string;
  timeFormat: string;
  timezone: string;
  [key: string]: unknown;
};

export const accounts = ["mira@example.test", "noah@example.test"];
export const folders = [
  ["Inbox", "i", "Inbox"],
  ["Starred", "s", "Star"],
  ["Drafts", "d", "PencilSquircle"],
  ["Sent", "t", "Send"],
  ["Done", "e", "Check"],
  ["Auto Archived", "", "Check"],
  ["Scheduled", "", "Send"],
  ["Reminders", "h", "Clock"],
  ["Muted", "m", "Envelope"],
  ["Snippets", ";", "Snippet"],
  ["Spam", "!", "Shield"],
  ["Trash", "#", "Trash"],
  ["All Mail", "a", "Envelope"],
];
export const defaultPreferences: Preferences = {
  theme: "Carbon",
  density: "Comfortable",
  font: "Super Sans",
  fontSize: "Normal",
  defaultReply: "Reply all",
  sendDelay: "10 seconds",
  readReceipts: true,
  desktopNotifications: true,
  notificationSound: false,
  showSnippets: true,
  recentOpens: true,
  signature: "",
  signatureEnabled: false,
  autoAdvance: true,
  markRead: true,
  spellcheck: true,
  splits: ["Important", "Other"],
  startWeek: "Sunday",
  timeFormat: "12 hour",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
};
export const contacts = [
  { name: "Alex Morgan", email: "alex@example.com" },
  { name: "Jamie Chen", email: "jamie@example.com" },
  { name: "Sam Rivera", email: "sam@example.com" },
  { name: "Taylor Brooks", email: "taylor@example.com" },
  { name: "Mira", email: accounts[0] },
  { name: "Jordan Lee", email: "jordan@example.com" },
  { name: "Basecamp", email: "hello@basecamp.example" },
  { name: "Mail Me Later", email: "hello@mailmelater.example" },
];
export const recentSeeds = [
  ["Alex Morgan", "3 hrs ago", "Prototype feedback", ""],
  ["Jamie Chen", "Thu 5:44 PM", "Preview environment", "Last 7 days"],
  ["Sam Rivera", "Thu 8:53 AM", "Weekly planning", ""],
  ["Taylor Brooks", "Sat Aug 22", "Reading list", "August"],
  ["Jordan Lee", "Thu Aug 20", "Team introductions", ""],
  ["Northstar Studio", "Tue Aug 18", "September project plan", ""],
  ["Studio Customer Care", "Sat Aug 15", "Sample order update", ""],
  ["Alex Morgan", "Fri Aug 14", "Sketch review", ""],
  ["Jamie Chen", "Mon Aug 10", "Project inquiry", ""],
  ["Mira", "Mon Aug 10", "Project notes", ""],
  ["Sam Rivera", "Fri Aug 7", "Notification prototype", ""],
  ["Taylor Brooks", "Wed Aug 5", "New teammate", ""],
  ["Jordan Lee", "Wed Aug 5", "Support inbox update", ""],
  ["Alex Morgan", "Mon Aug 3", "Signup feedback", ""],
  ["Jamie Chen", "Mon Aug 3", "Product feedback", ""],
  ["Sam Rivera", "Sat Aug 1", "Support ideas", ""],
  ["Taylor Brooks", "Sat Aug 1", "Delivery check", ""],
  ["Mira", "Thu Jul 30", "Sample itinerary", "July"],
  ["Jordan Lee", "Thu Jul 30", "Review notes", ""],
  ["Sam Rivera", "Tue Jul 28", "Alert settings", ""],
  ["Alex Morgan", "Tue Jul 21", "Mail client preview", ""],
  ["Jamie Chen", "Mon Jul 13", "Studio proposal", ""],
  ["Taylor Brooks", "Mon Jul 13", "A quick follow-up", ""],
  ["Jordan Lee", "Wed Jul 8", "Your preview is ready", ""],
];

const message = (
  id: string,
  from: string,
  email: string,
  subject: string,
  body: string,
  date = "8:45 AM",
): Message => ({ id, from, email, to: accounts[0], date, body });
function mail(
  id: string,
  from: string,
  subject: string,
  snippet: string,
  split: string,
  date: string,
  unread = false,
  body?: string,
): Mail {
  const email = `${from.toLowerCase().replace(/[^a-z]/g, "")}@example.com`;
  return {
    id,
    account: accounts[0],
    from,
    email,
    to: accounts[0],
    subject,
    snippet,
    split,
    date,
    group: "Today",
    folder: "Inbox",
    unread,
    starred: false,
    labels: [],
    messages: [
      message(
        `${id}-1`,
        from,
        email,
        subject,
        body ||
          `<p>Hey Mira,</p><p>${snippet}</p><p>Let me know what you think.</p><p>Thanks,<br>${from}</p>`,
        date,
      ),
    ],
  };
}
export function seedMail(): Mail[] {
  const result: Mail[] = [
    mail(
      "basecamp-apps",
      "Basecamp",
      "Your workspace is ready",
      "Welcome to your example workspace. Review the sample project and choose how you would like to organize it.",
      "Important",
      "8:45 AM",
      true,
      '<h2>Your workspace is ready</h2><p>Hello Mira,</p><p>This fictional workspace contains a sample project and a few notes.</p><p><a href="https://example.com">Review the sample project</a> when you are ready.</p><p>Thanks,<br>The example team</p>',
    ),
    mail(
      "bookmarks",
      "Mail Me Later",
      "Two ideas for your reading list",
      "Hello Mira, here are two fictional notes from your sample reading list: a project update and a design discussion.",
      "Important",
      "8:01 AM",
      false,
      "<p>Hello Mira,</p><p>Your sample reading list has <strong>two new notes</strong>.</p><blockquote><strong>Alex Morgan</strong><p>The example project is ready for review.</p></blockquote><blockquote><strong>Jamie Chen</strong><p>We can discuss the next design iteration tomorrow.</p></blockquote><p>Thanks,<br>Mail Me Later</p>",
    ),
    mail(
      "randy-chat",
      "Alex Morgan",
      "A new project discussion",
      "Alex started a sample discussion about the next iteration. The team can review the notes during the next meeting.",
      "Important",
      "7:36 AM",
      true,
    ),
    mail(
      "basecamp-digest",
      "Basecamp",
      "Sample workspace activity",
      "The example team added project notes and discussed the next milestone. This is a fictional activity summary.",
      "Important",
      "7:08 AM",
      true,
    ),
    mail(
      "inbound-beta",
      "Alex Morgan",
      "Interest in the prototype",
      "Hey Mira, I would like to try the sample prototype and share some feedback.",
      "Inbound",
      "Yesterday",
      true,
    ),
    mail(
      "calendar-invite",
      "Jamie Chen",
      "Invitation: Design catch-up @ Wed Sep 2, 2026 2pm",
      "You have been invited to Design catch-up. Wednesday, September 2, 2:00 PM - 2:30 PM (Eastern Time)",
      "Calendar",
      "Yesterday",
      true,
      '<div class="meeting-invite"><h2>Design catch-up</h2><p>Wednesday, September 2, 2026<br>2:00 PM - 2:30 PM (Eastern Time)</p><p>Jamie Chen has invited you to a meeting.</p><p>We\'ll walk through the latest designs and next steps.</p></div>',
    ),
  ];
  const githubSubjects = [
    "[opencode] Improve keyboard navigation (#2841)",
    "[opencode] Fix streaming response cleanup (#2839)",
    "[hark] Add webhook delivery receipts (#182)",
    "[browser-control] Support persistent sessions (#92)",
    "[opencode] Conversation layout refinements (#2836)",
    "[superlocal] New pull request review (#12)",
    "[opencode] Update the release workflow (#2829)",
  ];
  for (let i = 0; i < 22; i++)
    result.push(
      mail(
        `github-${i}`,
        ["GitHub", "Sam Rivera", "Jamie Chen", "Taylor Brooks"][i % 4],
        githubSubjects[i % githubSubjects.length],
        [
          "A new commit was pushed to this pull request. Review the changes and join the conversation.",
          "Approved these changes. This looks good to me, thanks for taking care of it!",
          "The workflow run has completed successfully. All checks have passed.",
        ][i % 3],
        "Github",
        i < 6 ? `${10 - i}:24 AM` : "Yesterday",
        i < 15,
      ),
    );
  const otherSenders = [
    "Linear",
    "Figma",
    "Vercel",
    "Notion",
    "The Browser",
    "Stripe",
    "Framer",
    "Read.cv",
    "Substack",
    "Basecamp",
    "Cloudflare",
    "GitHub",
    "Dropbox",
    "Airbnb",
    "Are.na",
    "Apple",
  ];
  const otherSubjects = [
    "Your weekly digest",
    "A little inspiration for your next project",
    "Your deployment is ready",
    "What's new this month",
    "Five things worth reading",
    "Your receipt is ready",
    "Made for the way you work",
    "A new update from the team",
    "The details that matter",
    "Here's the latest activity",
    "Your project is looking good",
    "An update on your subscription",
    "Files shared with you",
    "Your next adventure starts here",
    "A few things we saved this week",
    "The latest from the App Store",
  ];
  for (let i = 0; i < 480; i++) {
    const m = mail(
      `other-${i}`,
      otherSenders[i % 16],
      otherSubjects[i % 16],
      [
        "Take a look at what happened this week. A collection of ideas, updates, and things we thought you would enjoy.",
        "Hello Ryan, here are the latest updates for your workspace. There is something new to explore.",
        "Thanks for being part of the community. Here is everything you need to know.",
      ][i % 3],
      "Other",
      i < 9
        ? `${9 - Math.floor(i / 2)}:${i % 2 ? "18" : "42"} AM`
        : i < 24
          ? "Yesterday"
          : `Aug ${Math.max(1, 31 - Math.floor(i / 16))}`,
      i % 3 !== 0,
    );
    m.group = i < 9 ? "Today" : i < 24 ? "Yesterday" : "Last 7 days";
    result.push(m);
  }
  recentSeeds.forEach(([from, opened, subject, group], i) => {
    const m = mail(
      `sent-${i}`,
      from,
      subject,
      "Thanks for the update! I took a look and everything looks good. Happy to chat more about this whenever you have a chance.",
      "Important",
      opened,
      false,
      `<p>Hey ${from.split(" ")[0]},</p><p>Thanks for the update! I took a look and everything looks good.</p><p>Happy to chat more about this whenever you have a chance. Let me know what works for you.</p><p>Best,<br>Mira</p>`,
    );
    m.folder = "Sent";
    m.opened = opened;
    m.group = group;
    m.to = m.email;
    m.messages[0].from = "Mira";
    m.messages[0].email = accounts[0];
    m.messages[0].to = m.email;
    m.starred = i < 3;
    if (i === 0)
      m.messages.unshift(
        message(
          "beta-original",
          from,
          m.email,
          subject,
          "<p>Hi Mira,</p><p>I would like to review the example prototype.</p><p>Could you share the sample timeline?</p><p>Thanks!</p>",
          "Yesterday",
        ),
      );
    result.push(m);
  });
  for (const [i, folder] of [
    "Done",
    "Done",
    "Done",
    "Reminders",
    "Reminders",
    "Spam",
    "Spam",
    "Trash",
    "Trash",
  ].entries()) {
    const m = mail(
      `${folder}-${i}`,
      ["Alex Morgan", "Jamie Chen", "Linear"][i % 3],
      [
        "A quick follow-up",
        "Project notes and next steps",
        "Your weekly workspace update",
      ][i % 3],
      "Here are the notes from our conversation. Thanks again for making the time.",
      "Important",
      "Aug 28",
      false,
    );
    m.folder = folder;
    m.starred = i === 0;
    if (folder === "Reminders")
      m.reminder = i === 3 ? "Tomorrow, 9:00 AM" : "Monday, 9:00 AM";
    result.push(m);
  }
  for (let i = 0; i < 12; i++) {
    const m = mail(
      `work-${i}`,
      ["Jamie Chen", "Alex Morgan", "GitHub", "Linear"][i % 4],
      [
        "Studio review",
        "Re: Launch plans",
        "Pull request ready for review",
        "Your team activity",
      ][i % 4],
      "A quick update on what we are working on this week. Let me know if you have any questions.",
      i < 4 ? "Important" : i < 7 ? "Github" : "Other",
      "Yesterday",
      i < 4,
    );
    m.account = accounts[1];
    m.to = accounts[1];
    result.push(m);
  }
  return result;
}
export const seedDrafts: Draft[] = [
  {
    id: "draft-one",
    account: accounts[0],
    mode: "new",
    to: "alex@example.com",
    cc: "",
    bcc: "",
    subject: "A few thoughts on the next iteration",
    body: "<p>Hey Alex,</p><p>I spent some time with the latest build. A few small things stood out:</p>",
    attachments: [],
    updated: 1788258000000,
  },
  {
    id: "draft-two",
    account: accounts[0],
    mode: "new",
    to: "jamie@example.com",
    cc: "",
    bcc: "",
    subject: "Friday catch-up",
    body: "<p>Are you free for a quick catch-up on Friday?</p>",
    attachments: [],
    updated: 1788248000000,
  },
  {
    id: "draft-three",
    account: accounts[0],
    mode: "new",
    to: "",
    cc: "",
    bcc: "",
    subject: "September project notes",
    body: "<p>A few things to keep in mind for September.</p>",
    attachments: [],
    updated: 1788148000000,
  },
  {
    id: "draft-four",
    account: accounts[0],
    mode: "new",
    to: "sam@example.com",
    cc: "",
    bcc: "",
    subject: "Re: Preview is ready",
    body: "<p>Thanks Sam! This is looking really good.</p>",
    attachments: [],
    updated: 1788048000000,
  },
];
export function displayDate(value: string) {
  if (!/^\d{4}-\d\d-\d\dT/.test(value)) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : value;
}

export function reminderTime(value: string) {
  const raw = value.toLowerCase();
  if (raw === "never" || raw === "someday") return undefined;
  if (/^\d{4}-\d\d-\d\dT/.test(value)) return Date.parse(value);
  const date = new Date();
  const amount = raw.match(/(\d+)\s*(minutes?|hours?|days?|weeks?)/);
  if (amount)
    return (
      Date.now() +
      Number(amount[1]) *
        (amount[2].startsWith("minute")
          ? 60000
          : amount[2].startsWith("hour")
            ? 3600000
            : amount[2].startsWith("week")
              ? 604800000
              : 86400000)
    );
  if (raw.includes("tomorrow")) date.setDate(date.getDate() + 1);
  else if (raw.includes("weekend"))
    date.setDate(date.getDate() + ((6 - date.getDay() + 7) % 7 || 7));
  else if (raw.includes("week") || raw.includes("monday"))
    date.setDate(date.getDate() + ((1 - date.getDay() + 7) % 7 || 7));
  const time = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  date.setHours(
    time ? (Number(time[1]) % 12) + (time[3] === "pm" ? 12 : 0) : 8,
    time ? Number(time[2] || 0) : 0,
    0,
    0,
  );
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
  return date.getTime();
}
