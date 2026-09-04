import { useEffect, useRef, type RefObject } from "react";
import type { AiReadingInput } from "../../shared/ai-triage";

type ReadingOptions = {
  enabled: boolean;
  sourceId?: string;
  threadId?: string;
  readerRef: RefObject<HTMLElement | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  activeMessageRef: RefObject<string>;
  /** Canonical IDs of loaded, expanded, incoming, nonpending messages only. */
  messageIds: string[];
  paused?: boolean;
  onReading?: (input: AiReadingInput) => Promise<void>;
};
type Counter = { id: string; activeMs: number; sentMs: number; pending: boolean };
type Visit = { key: string; id: string; sequence: number; leaseUntil: number; counters: Map<string, Counter> };
type Runtime = { refresh: (messageIds: string[]) => void; activity: (target: EventTarget | null) => void };

/** Opt-in, approximate active time. Never reads message text or observes iframe activity. */
export function useReadingEngagement({ enabled, sourceId, threadId, readerRef, scrollerRef, activeMessageRef, messageIds, paused = false, onReading }: ReadingOptions) {
  const visitRef = useRef<Visit | null>(null);
  const runtime = useRef<Runtime | null>(null);
  const current = useRef({ enabled, paused });
  current.current = { enabled, paused };
  const eligibility = JSON.stringify(messageIds);
  const eligibleRef = useRef(messageIds);
  eligibleRef.current = messageIds;

  useEffect(() => {
    const reader = readerRef.current, scroller = scrollerRef.current;
    if (!enabled || !sourceId || !threadId || !onReading || !reader || !scroller || typeof IntersectionObserver === "undefined") return;
    const key = JSON.stringify([sourceId, threadId]);
    if (visitRef.current?.key !== key) visitRef.current = { key, id: crypto.randomUUID(), sequence: 0, leaseUntil: performance.now() + 30_000, counters: new Map() };
    const visit = visitRef.current;
    const visible = new Map<string, number>();
    let eligible = new Set(eligibleRef.current);
    let lastTick = performance.now(), lastPost = lastTick, previousMessage: string | null = null;
    let disposed = false;
    const editable = (target: Element | null) => !!target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .compose-view');
    function isPaused() {
      return !current.current.enabled || current.current.paused || document.visibilityState !== "visible" || !document.hasFocus() || !reader!.isConnected || !reader!.getClientRects().length ||
        !!reader!.closest(".settings-open, .navigation-open") || editable(document.activeElement) ||
        Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).some(element => element.getClientRects().length > 0);
    }
    function activity(target: EventTarget | null) {
      if (!(target instanceof Element) || !reader!.contains(target) || editable(target) || isPaused()) return;
      visit.leaseUntil = performance.now() + 30_000;
    }
    const pointer = (event: Event) => { if (event.isTrusted) activity(event.target); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.isTrusted && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "n", "p", "o"].includes(event.key)) activity(event.target);
    };
    const suspend = () => { visit.leaseUntil = 0; previousMessage = null; lastTick = performance.now(); };
    const visibility = () => { if (document.visibilityState !== "visible") suspend(); };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.threadMessage;
        if (!id) continue;
        if (entry.isIntersecting && entry.intersectionRect.height > 0 && entry.intersectionRect.width > 0) visible.set(id, entry.intersectionRect.height * entry.intersectionRect.width);
        else visible.delete(id);
      }
    }, { root: scroller, threshold: [0, 0.01, 0.25, 0.5, 0.75, 1] });
    function refresh(ids: string[]) {
      observer.disconnect(); visible.clear(); eligible = new Set(ids); previousMessage = null;
      for (const element of scroller!.querySelectorAll<HTMLElement>("[data-thread-message]")) {
        if (eligible.has(element.dataset.threadMessage || "")) observer.observe(element);
      }
    }
    function send(messageId: string, counter: Counter) {
      if (counter.pending || counter.activeMs <= counter.sentMs) return;
      const activeMs = Math.min(120_000, Math.floor(counter.activeMs));
      const input: AiReadingInput = { sourceId: sourceId!, threadId: threadId!, messageId, visitId: counter.id, sequence: ++visit.sequence, activeMs };
      counter.pending = true;
      // Use this scope's captured callback, never a newly selected owner's callback.
      void Promise.resolve().then(() => onReading!(input)).then(() => { counter.sentMs = Math.max(counter.sentMs, activeMs); }).catch(() => {
        // Reading estimates never interrupt mail. A later cumulative update can fill a gap.
      }).finally(() => { counter.pending = false; });
    }
    function flush(maximum: number) {
      let remaining = maximum;
      for (const [messageId, counter] of visit.counters) {
        if (remaining <= 0) break;
        if (counter.pending || counter.activeMs <= counter.sentMs) continue;
        send(messageId, counter); remaining--;
      }
    }
    const timer = window.setInterval(() => {
      if (disposed) return;
      const now = performance.now(), elapsed = now - lastTick;
      lastTick = now;
      if (isPaused()) { previousMessage = null; visit.leaseUntil = 0; return; }
      const preferred = activeMessageRef.current;
      const candidate = eligible.has(preferred) && visible.has(preferred) ? preferred : [...visible.entries()].filter(([id]) => eligible.has(id)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      if (candidate && previousMessage === candidate && now <= visit.leaseUntil && elapsed > 0 && elapsed <= 1500) {
        const counter = visit.counters.get(candidate) ?? { id: crypto.randomUUID(), activeMs: 0, sentMs: 0, pending: false };
        counter.activeMs = Math.min(120_000, counter.activeMs + elapsed);
        visit.counters.set(candidate, counter);
      }
      previousMessage = now <= visit.leaseUntil ? candidate : null;
      if (now - lastPost >= 5000) { lastPost = now; flush(5); }
    }, 1000);
    for (const event of ["pointerdown", "pointermove", "wheel", "touchstart", "touchmove"]) reader.addEventListener(event, pointer, { passive: true });
    reader.addEventListener("keydown", keyboard, true);
    window.addEventListener("blur", suspend);
    document.addEventListener("visibilitychange", visibility);
    const instance = { refresh, activity };
    runtime.current = instance;
    refresh(eligibleRef.current);
    return () => {
      disposed = true;
      window.clearInterval(timer); observer.disconnect();
      for (const event of ["pointerdown", "pointermove", "wheel", "touchstart", "touchmove"]) reader.removeEventListener(event, pointer);
      reader.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("blur", suspend);
      document.removeEventListener("visibilitychange", visibility);
      if (runtime.current === instance) runtime.current = null;
      // No queued timers or beacons: at most five already-earned cumulative updates.
      if (current.current.enabled) flush(5);
    };
  }, [enabled, sourceId, threadId, onReading, readerRef, scrollerRef, activeMessageRef]);

  useEffect(() => { runtime.current?.refresh(eligibleRef.current); }, [eligibility]);

  // Existing reader navigation may consume a key before it reaches the reader root.
  // This accepts only its event target, never key contents, and verifies reader scope.
  return (target: EventTarget | null) => runtime.current?.activity(target);
}

export default useReadingEngagement;
