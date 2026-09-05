import { memo } from "react";
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

function MailRow({
  mail: m,
  index: i,
  highlighted,
  selected,
  sent,
  showSnippets,
}: MailRowProps) {
  const recipients = m.toAddresses?.join(", ") ?? m.to;
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
        {sent && m.messages.length === 1 ? "Me" : m.from}
        {m.messages.length > 1 && (
          <span className="message-count">{m.messages.length}</span>
        )}
      </span>
      <span className="row-content" role="cell">
        <span className="row-subject">{m.subject}</span>
        {showSnippets && <span className="row-snippet">{m.snippet}</span>}
      </span>
      {m.labels.length > 0 && (
        <span className="row-label" role="cell" title={m.labels.join(", ")}>
          {m.labels[0]}
        </span>
      )}
      <span className="row-recipients" role="cell" title={recipients ? `To: ${m.to || recipients}` : "No To recipients"}>
        {recipients ? `To: ${recipients}` : "No To recipients"}
      </span>
      <span className="row-metadata">
        {m.starred && <Icon name="Star" size={13} className="starred-icon" />}
        {m.messages.some((msg) => msg.hasAttachments || msg.attachments?.length) && (
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
