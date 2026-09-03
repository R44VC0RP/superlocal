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
  return (
    <div
      key={m.id}
      data-motion-id={m.id}
      data-mail-id={m.id}
      className={`mail-row ${highlighted ? "highlighted" : ""} ${selected ? "selected" : ""} ${m.unread ? "unread" : ""} ${m.mailboxNames?.length ? "has-mailbox" : ""}`}
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
      {!!m.mailboxNames?.length && <span className="row-mailbox" role="cell" title={m.mailboxNames.join(", ")}>{m.mailboxNames[0]}{m.mailboxNames.length > 1 ? ` +${m.mailboxNames.length - 1}` : ""}</span>}
      <span className="row-metadata">
        {m.labels.slice(0, 1).map((l) => (
          <span className="row-label" key={l}>
            {l}
          </span>
        ))}
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
