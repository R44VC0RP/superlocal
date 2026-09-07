import { memo, type CSSProperties } from "react";
import { Icon, IconButton } from "./components";
import { displayDate, type Mail } from "./data";

type MailRowProps = {
  mail: Mail;
  index: number;
  highlighted: boolean;
  selected: boolean;
  sent: boolean;
  showSnippets: boolean;
};

const labelHues: Record<string, number> = { social: 250, marketing: 25, pitch: 300, news: 85, updates: 200, forums: 150, promotions: 55, finance: 130 };

/** Stable hue per label so the same label reads the same color everywhere. */
export function labelHue(label: string) {
  const key = label.trim().toLowerCase();
  if (key in labelHues) return labelHues[key];
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % 360;
}

function MailRow({
  mail: m,
  index: i,
  highlighted,
  selected,
  sent,
  showSnippets,
}: MailRowProps) {
  const recipients = m.toAddresses?.join(", ") ?? m.to;
  const messageCount = m.window ? m.window.counts.messages : m.messages.length;
  return (
    <div
      key={m.id}
      data-motion-id={m.id}
      data-mail-id={m.id}
      className={`mail-row has-recipients ${highlighted ? "highlighted" : ""} ${selected ? "selected" : ""} ${m.unread ? "unread" : ""}`}
      role="row"
      aria-rowindex={i + 1}
      aria-selected={selected}
      data-highlighted={highlighted}
    >
      <button
        className="row-select"
        title="Select conversation (X)"
        aria-label={`Select ${m.subject}`}
        data-mail-action="select"
      >
        <span className={`select-square ${selected ? "checked" : ""}`}>
          {selected && <Icon name="Check" size={11} />}
        </span>
      </button>
      <span className="unread-dot" aria-label={m.unread ? "Unread" : "Read"} />
      <span className="row-from" role="cell">
        {sent && messageCount === 1 ? "Me" : m.from}
        {(messageCount === null || messageCount > 1) && (
          <span className="message-count">{messageCount ?? "…"}</span>
        )}
      </span>
      <span className="row-content" role="cell">
        <span className="row-subject">{m.subject}</span>
        {showSnippets && <span className="row-snippet">{m.snippet}</span>}
      </span>
      {m.labels.length > 0 && (
        <span
          className="row-label"
          role="cell"
          title={m.labels.join(", ")}
          style={{ "--label-hue": labelHue(m.labels[0]) } as CSSProperties}
        >
          {m.labels[0]}
        </span>
      )}
      <span className="row-recipients" role="cell" title={recipients ? `To: ${m.to || recipients}` : "No To recipients"}>
        {recipients ? `To: ${recipients}` : "No To recipients"}
      </span>
      <span className="row-metadata">
        {m.starred && <Icon name="Star" size={13} className="starred-icon" />}
        {(m.window ? m.hasAttachments : m.messages.some((msg) => msg.hasAttachments || msg.attachments?.length)) && (
          <Icon name="Paperclip" size={14} />
        )}
        <time className={m.reminder || m.scheduled ? "reminder-date" : ""}>
          {displayDate(m.scheduled || m.reminder || m.date)}
        </time>
      </span>
      <span className="row-actions">
        <IconButton
          name="Check"
          title="Mark Done (E)"
          data-mail-action="done"
        />
        <IconButton
          name="Clock"
          title="Remind Me (H)"
          data-mail-action="remind"
        />
        <IconButton
          name="Bolt"
          title="Superlocal Command (⌘K)"
          data-mail-action="command"
        />
      </span>
    </div>
  );
}

export default memo(MailRow);
