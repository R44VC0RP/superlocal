import { folders } from "./data.ts";

export type MailShortcutEvent = {
  key: string;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
};

export type MailShortcutContext = {
  mode: "list" | "reader" | "composer" | "auxiliary";
  editing?: boolean;
  richText?: boolean;
  interactive?: boolean;
  modal?: boolean;
  navigation?: boolean;
  settings?: boolean;
  floatingDraft?: boolean;
  isDrafts?: boolean;
  accountDialog?: boolean;
  sequence?: boolean;
  search?: boolean;
  hasHighlightedMail?: boolean;
};

export type MailShortcut = (
  | { type: "account"; index: number }
  | { type: "unified" }
  | { type: "command" }
  | { type: "escape" }
  | { type: "toggleFocus" }
  | { type: "calendar"; view: "day" | "week" }
  | { type: "copyLink" }
  | { type: "selectAll"; fromHere: boolean }
  | { type: "jump"; edge: "top" | "bottom" }
  | { type: "drawerNavigate"; delta: -1 | 1 }
  | { type: "drawerActivate" }
  | { type: "goFolder"; folder: string; split?: "Important" | "Other" }
  | { type: "labelMode"; mode: "toggle" | "move" | "navigate" }
  | { type: "sequence"; phase: "start" | "clear" }
  | { type: "compose"; popOut: boolean }
  | { type: "search" }
  | { type: "settings" }
  | { type: "split"; delta: -1 | 1 }
  | { type: "openDrawer" }
  | { type: "openConversation"; drafts: boolean }
  | { type: "page"; delta: -1 | 1 }
  | { type: "filter"; name: "Unread" | "Starred" | "Important" | "No reply" }
  | { type: "navigateConversation"; delta: -1 | 1 }
  | { type: "reply"; mode: "reply" | "replyAll" | "forward"; popOut: boolean }
  | { type: "toggleSelection" }
  | { type: "removeLabels"; all: boolean; delta: -1 | 0 | 1 }
  | {
      type: "triage";
      action:
        | "inbox"
        | "mute"
        | "done"
        | "not-important"
        | "remind"
        | "star"
        | "unread"
        | "trash"
        | "spam";
    }
  | { type: "undo" }
) & { clearSequence?: true };

export function resolveMailShortcut(
  event: MailShortcutEvent,
  context: MailShortcutContext,
): MailShortcut | null {
  if (event.isComposing || event.defaultPrevented) return null;
  const key = event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;
  const shift = !!event.shiftKey;
  const list = context.mode === "list";
  const reader = context.mode === "reader";

  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    /^[0-9]$/.test(event.key) &&
    !context.settings &&
    (!context.modal || context.accountDialog)
  )
    return event.key === "0" ? { type: "unified" } : { type: "account", index: Number(event.key) - 1 };

  if (
    mod &&
    key === "k" &&
    !event.altKey &&
    !shift &&
    !context.richText &&
    !context.modal
  )
    return { type: "command" };
  if (context.modal) return null;
  if (event.key === "Escape") return { type: "escape" };
  if (context.settings) return null;
  if (mod && key === "d" && !event.altKey && !shift && context.floatingDraft)
    return { type: "toggleFocus" };
  if (
    context.editing ||
    event.altKey ||
    context.mode === "composer"
  )
    return null;

  if (!mod && !shift && (event.key === "0" || event.key === "2"))
    return { type: "calendar", view: event.key === "0" ? "day" : "week" };
  if (mod) {
    if (event.ctrlKey && !event.metaKey && event.key === "/")
      return { type: "copyLink" };
    if (list && key === "a" && !context.isDrafts)
      return { type: "selectAll", fromHere: !shift };
    if (list && (event.key === "ArrowUp" || event.key === "ArrowDown"))
      return { type: "jump", edge: event.key === "ArrowUp" ? "top" : "bottom" };
    return null;
  }
  if (context.navigation) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown")
      return {
        type: "drawerNavigate",
        delta: event.key === "ArrowDown" ? 1 : -1,
      };
    if (event.key === "ArrowRight") return { type: "drawerActivate" };
    return null;
  }
  if (context.interactive && ["Enter", " ", "Tab"].includes(event.key))
    return null;

  let intent: MailShortcut | null = null;
  if (context.sequence) {
    // Inbox's explicit split must win over the shared folder mapping.
    if (key === "o" || key === "i")
      intent = {
        type: "goFolder",
        folder: "Inbox",
        split: key === "o" ? "Other" : "Important",
      };
    else if (key === "l") intent = { type: "labelMode", mode: "navigate" };
    else {
      const match = folders.find(
        ([, shortcut]) => shortcut.toLowerCase() === key,
      );
      if (match) intent = { type: "goFolder", folder: match[0] };
    }
  }
  if (intent) return { ...intent, clearSequence: true };
  if (event.key === "g") return { type: "sequence", phase: "start" };

  if (context.mode !== "auxiliary") {
    if (key === "c") intent = { type: "compose", popOut: shift };
    else if (event.key === "/") intent = { type: "search" };
    else if (event.key === ",") intent = { type: "settings" };
    else if (event.key === "Tab" && list && !context.search)
      intent = { type: "split", delta: shift ? -1 : 1 };
    else if (reader && !shift && (event.key === "ArrowLeft" || event.key === "ArrowRight"))
      intent = { type: "navigateConversation", delta: event.key === "ArrowRight" ? 1 : -1 };
    else if (event.key === "ArrowLeft" && list) intent = { type: "openDrawer" };
    else if (event.key === "ArrowRight" && list && context.hasHighlightedMail)
      intent = { type: "openConversation", drafts: false };
    else if (event.key === " " && list)
      intent = { type: "page", delta: shift ? -1 : 1 };
    else if (
      shift &&
      list &&
      (key === "u" || key === "s" || key === "i" || key === "r")
    )
      intent = {
        type: "filter",
        name: (
          { u: "Unread", s: "Starred", i: "Important", r: "No reply" } as const
        )[key],
      };
    else if (["j", "k"].includes(event.key) || list && ["ArrowDown", "ArrowUp"].includes(event.key))
      intent = {
        type: "navigateConversation",
        delta: event.key === "j" || event.key === "ArrowDown" ? 1 : -1,
      };
    else if (event.key === "Enter" && reader)
      intent = { type: "reply", mode: "replyAll", popOut: shift };
    else if (event.key === "Enter" && list)
      intent = { type: "openConversation", drafts: !!context.isDrafts };
    else if (event.key === "x" && context.hasHighlightedMail)
      intent = { type: "toggleSelection" };
    else if (key === "v") intent = { type: "labelMode", mode: "move" };
    else if (key === "y" || event.key === "[" || event.key === "]")
      intent = {
        type: "removeLabels",
        all: shift,
        delta: event.key === "[" ? 1 : event.key === "]" ? -1 : 0,
      };
    else if (shift && key === "e") intent = { type: "triage", action: "inbox" };
    else if (shift && key === "m") intent = { type: "triage", action: "mute" };
    else if (event.key === "l") intent = { type: "labelMode", mode: "toggle" };
    else if (
      event.key === "e" ||
      event.key === "w" ||
      event.key === "h" ||
      event.key === "s" ||
      event.key === "u" ||
      event.key === "#" ||
      event.key === "!"
    )
      intent = {
        type: "triage",
        action: (
          {
            e: "done",
            w: "not-important",
            h: "remind",
            s: "star",
            u: "unread",
            "#": "trash",
            "!": "spam",
          } as const
        )[event.key],
      };
    else if (reader && (key === "r" || key === "f"))
      intent = {
        type: "reply",
        mode: key === "f" ? "forward" : "reply",
        popOut: shift,
      };
    else if (event.key === "z") intent = { type: "undo" };
  }

  // Even an unknown second key consumes G, without suppressing its native behavior.
  if (context.sequence)
    return intent
      ? { ...intent, clearSequence: true }
      : { type: "sequence", phase: "clear" };
  return intent;
}
