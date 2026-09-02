import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
  type RefObject,
} from "react";
import MailRow from "./MailRow";
import { mailWindow, type MailListEntry } from "./mail-view";

type MailRowsProps = {
  entries: MailListEntry[];
  totalHeight: number;
  rowHeight: number;
  virtualized: boolean;
  highlight: number;
  scrollToHighlight: boolean;
  selected: string[];
  sent: boolean;
  showSnippets: boolean;
  container: RefObject<HTMLDivElement | null>;
  scrollPosition: RefObject<number>;
  onWindowCommit: () => void;
};

export default function MailRows({
  entries,
  totalHeight,
  rowHeight,
  virtualized,
  highlight,
  scrollToHighlight,
  selected,
  sent,
  showSnippets,
  container,
  scrollPosition,
  onWindowCommit,
}: MailRowsProps) {
  const [viewport, setViewport] = useState(() => ({
    top: scrollPosition.current,
    height: innerHeight,
  }));
  const range = virtualized
    ? mailWindow(entries, viewport.top, viewport.height, rowHeight)
    : { start: 0, end: entries.length };
  const visible = entries.slice(range.start, range.end);
  const leading = visible[0]?.top || 0;
  const last = visible.at(-1);
  const trailing = Math.max(
    0,
    totalHeight - (last ? last.top + last.height : 0),
  );
  const measure = useEffectEvent(() => {
    const root = container.current;
    if (!root || !virtualized) return;
    const next = { top: root.scrollTop, height: root.clientHeight };
    setViewport((previous) => {
      const before = mailWindow(
        entries,
        previous.top,
        previous.height,
        rowHeight,
      );
      const after = mailWindow(entries, next.top, next.height, rowHeight);
      return before.start === after.start && before.end === after.end
        ? previous
        : next;
    });
  });
  const refreshHighlight = useEffectEvent(onWindowCommit);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const update = () => measure();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    root.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", update);
    };
  }, [container]);
  useLayoutEffect(() => {
    measure();
  }, [entries, virtualized, rowHeight]);
  const revealHighlight = useEffectEvent(() => {
    const root = container.current;
    if (!root || !virtualized || !scrollToHighlight) return;
    const item = entries.find(
      (entry) => !entry.group && entry.index === highlight,
    );
    if (!item) return;
    if (item.top < root.scrollTop) root.scrollTop = item.top;
    else if (item.top + item.height > root.scrollTop + root.clientHeight)
      root.scrollTop = item.top + item.height - root.clientHeight;
    scrollPosition.current = root.scrollTop;
    measure();
  });
  useLayoutEffect(() => {
    revealHighlight();
  }, [highlight, virtualized, rowHeight]);
  useLayoutEffect(() => {
    refreshHighlight();
  }, [range.start, range.end]);
  return (
    <>
      {virtualized && leading > 0 && (
        <div aria-hidden="true" style={{ height: leading }} />
      )}
      {visible.map((entry) =>
        entry.group ? (
          <h2 className="mail-group-heading" key={entry.key}>
            {entry.group}
          </h2>
        ) : (
          <MailRow
            key={entry.mail.id}
            mail={entry.mail}
            index={entry.index}
            highlighted={highlight === entry.index}
            selected={selected.includes(entry.mail.id)}
            sent={sent}
            showSnippets={showSnippets}
          />
        ),
      )}
      {virtualized && trailing > 0 && (
        <div aria-hidden="true" style={{ height: trailing }} />
      )}
    </>
  );
}
