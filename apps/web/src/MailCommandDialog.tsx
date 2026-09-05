import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon, IconButton, Key, Modal } from "./components";
import type { Mail, MailboxOption } from "./data";
import { UNIFIED_ACCOUNT } from "./mail-model";

export type CommandItem = {
  label: string;
  detail: string;
  key: string;
  icon: string;
  run: () => void;
};

type MailCommandDialogProps = {
  mode: "command" | "remind" | "label" | "accounts";
  open?: boolean;
  initialQuery?: string;
  onClose: () => void;
  commands: CommandItem[];
  labels: string[];
  labelMode: "toggle" | "move" | "navigate";
  targets: Mail[];
  onLabel: (label: string) => void;
  onCreateLabel: (label: string) => void;
  onRemind: (when: string) => void;
  accounts: MailboxOption[];
  pinnedMailboxIds?: string[];
  unifiedMailboxCount?: number;
  canCreateLabel?: boolean;
  currentAccount: string;
  onAccount: (account: string) => void;
  onSettings: (page?: string) => void;
};

export default function MailCommandDialog({
  mode,
  open = true,
  initialQuery = "",
  onClose,
  commands,
  labels,
  labelMode,
  targets,
  onLabel,
  onCreateLabel,
  onRemind,
  accounts,
  pinnedMailboxIds = [],
  unifiedMailboxCount = accounts.length,
  canCreateLabel = true,
  currentAccount,
  onAccount,
  onSettings,
}: MailCommandDialogProps) {
  const [query, setQuery] = useState(initialQuery);
  const [menuIndex, setMenuIndex] = useState(0);
  const [customDate, setCustomDate] = useState("");
  const [reminderCondition, setReminderCondition] = useState("If no reply");
  const commandInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const commandListId = useId();
  const opener = useRef<HTMLElement | null>(null);
  const restoreOnDismiss = useRef(false);

  useLayoutEffect(() => {
    if (open) {
      const active = document.activeElement;
      // Capture before focusing the input; Modal's later effect sees the input instead.
      if (active instanceof HTMLElement && !commandInput.current?.closest('[role="dialog"]')?.contains(active)) {
        opener.current = active;
      }
      restoreOnDismiss.current = false;
      return;
    }
    const target = opener.current;
    opener.current = null;
    if (!restoreOnDismiss.current) return;
    restoreOnDismiss.current = false;
    // Commands own destination focus. Even a dismissal must not override a new focus target.
    if (document.activeElement && document.activeElement !== document.body) return;
    if (target?.isConnected && !target.matches(":disabled") && !target.closest('[inert], [aria-disabled="true"]')) {
      target.focus({ preventScroll: true });
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    commandInput.current?.focus();
  }, [mode, initialQuery, open]);

  useEffect(() => {
    setMenuIndex(0);
  }, [query, mode, open]);

  const commandItems = commands.filter((item) =>
    `${item.label} ${item.detail}`.toLowerCase().includes(query.toLowerCase()),
  );
  const labelOptions = [
    ...(labelMode === "move" ? ["Inbox", "Done", "Trash", "Spam"] : []),
    ...labels,
  ].filter((label) => label.toLowerCase().includes(query.toLowerCase()));
  const reminderOptions = [
    "tomorrow",
    "next week",
    "this weekend",
    "someday",
    "never",
  ].filter((time) => time.includes(query.toLowerCase()));
  const accountChoices = [
    { id: UNIFIED_ACCOUNT, name: "Unified inbox", detail: `${unifiedMailboxCount} ${unifiedMailboxCount === 1 ? "mailbox" : "mailboxes"}`, shortcut: 0 },
    ...[...accounts].sort((a, b) => (pinnedMailboxIds.includes(a.id) ? pinnedMailboxIds.indexOf(a.id) : 1000)
      - (pinnedMailboxIds.includes(b.id) ? pinnedMailboxIds.indexOf(b.id) : 1000) || a.name.localeCompare(b.name)).map(account => ({
        id: account.id, name: account.name || account.email, detail: account.email !== account.name ? account.email : "",
        shortcut: pinnedMailboxIds.includes(account.id) ? pinnedMailboxIds.indexOf(account.id) + 1 : undefined,
      })),
  ];
  const filteredAccounts = accountChoices.filter(account => `${account.name} ${account.detail}`.toLowerCase().includes(query.toLowerCase()));
  const optionCount = (mode === "command" ? commandItems : mode === "label" ? labelOptions : mode === "remind" ? reminderOptions : filteredAccounts).length;
  const activeIndex = optionCount ? Math.min(Math.max(menuIndex, 0), optionCount - 1) : -1;

  useEffect(() => {
    results.current
      ?.querySelector<HTMLElement>(`[data-command-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, query, mode, open]);

  function dismiss() {
    restoreOnDismiss.current = true;
    onClose();
  }

  function createLabel() {
    if (!canCreateLabel) return;
    onCreateLabel(query);
    setQuery("");
  }

  if (!open) return null;

  return (
    <Modal
      label={
        mode === "command"
          ? "Superlocal Command"
          : mode === "remind"
            ? "Remind Me"
            : mode === "label"
              ? "Labels"
               : "Mailboxes"
      }
      onClose={dismiss}
      className={`app-modal command-modal ${mode === "accounts" ? `accounts-modal ${query ? "has-query" : ""}` : ""}`}
    >
      <div className="command-header">
        <Icon
          name={
            mode === "command"
              ? "Command"
              : mode === "remind"
                ? "Clock"
                : mode === "label"
                  ? "Label"
                  : "User"
          }
        />
        <span>
          {mode === "command"
            ? "Superlocal Command"
            : mode === "remind"
              ? "Remind me"
              : mode === "label"
                ? labelMode === "move"
                  ? "Move to"
                  : labelMode === "navigate"
                    ? "Go to label"
                    : "Add or remove label"
                 : "Mailboxes"}
        </span>
        <IconButton name="Close" title="Close" onClick={dismiss} />
      </div>
      <div className="command-input">
        <input
          ref={commandInput}
          role={mode === "command" ? "combobox" : undefined}
          aria-autocomplete={mode === "command" ? "list" : undefined}
          aria-expanded={mode === "command" ? true : undefined}
          aria-controls={mode === "command" ? commandListId : undefined}
          aria-activedescendant={mode === "command" && activeIndex >= 0 ? `${commandListId}-${activeIndex}` : undefined}
          aria-label={
            mode === "command"
              ? "Search commands"
              : mode === "remind"
                ? "When?"
                : mode === "label"
                  ? labelMode === "move"
                    ? "Move to folder or label"
                    : labelMode === "navigate"
                      ? "Find a label"
                      : canCreateLabel ? "Find or create a label" : "Find a label"
                  : "Find a mailbox"
          }
          value={query}
          placeholder={mode === "remind" ? "Try: 8 am, 3 days, aug 7" : mode === "accounts" ? "Search mailboxes…" : ""}
          onChange={(e) => {
            setQuery(e.target.value);
            setMenuIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setMenuIndex(Math.min(optionCount - 1, activeIndex + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setMenuIndex(Math.max(0, activeIndex - 1));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              if (mode === "command") commandItems[activeIndex]?.run();
              else if (mode === "remind")
                onRemind(query || reminderOptions[activeIndex] || "tomorrow");
              else if (mode === "accounts" && filteredAccounts[activeIndex])
                  onAccount(filteredAccounts[activeIndex].id);
              else if (mode === "label" && labelOptions[activeIndex]) {
                onLabel(labelOptions[activeIndex]);
                onClose();
              } else if (
                mode === "label" &&
                labelMode !== "navigate" && canCreateLabel &&
                query &&
                !labels.includes(query)
              ) {
                createLabel();
              }
            }
          }}
        />
        {mode === "remind" && (
          <select
            className="reminder-condition"
            aria-label="Reminder condition"
            value={reminderCondition}
            onChange={(e) => setReminderCondition(e.target.value)}
          >
            <option value="If no reply">if no reply</option>
            <option value="Regardless">regardless</option>
          </select>
        )}
      </div>
      <div className="command-results" ref={results}>
        {mode === "command" && (
          <div id={commandListId} role="listbox" aria-label="Commands">
            {commandItems.map((item, i) => (
              <div
                key={item.label}
                id={`${commandListId}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                data-command-index={i}
                className={`command-option ${i === activeIndex ? "active" : ""}`}
                style={{ cursor: "pointer" }}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setMenuIndex(i)}
                onClick={item.run}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {item.key && <Key>{item.key}</Key>}
              </div>
            ))}
          </div>
        )}
        {mode === "command" && !commandItems.length && (
          <p className="no-options">No commands found.</p>
        )}
        {mode === "remind" && (
          <>
            {reminderOptions.map((time, i) => (
              <button
                className={`command-option reminder-option ${i === activeIndex ? "active" : ""}`}
                key={time}
                data-command-index={i}
                onClick={() => onRemind(`${time}${i < 3 ? ", 8:00 AM" : ""}`)}
              >
                <span>{time}</span>
                <small>
                  {["Wed, 8:00 AM", "Mon, 8:00 AM", "Sat, 8:00 AM", "", ""][i]}
                </small>
              </button>
            ))}
            <div className="custom-reminder">
              <input
                type="datetime-local"
                aria-label="Custom reminder date"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
              />
              <button
                className="primary-button"
                disabled={!customDate}
                onClick={() => onRemind(new Date(customDate).toISOString())}
              >
                Set reminder
              </button>
            </div>
          </>
        )}
        {mode === "label" && (
          <>
            {labelOptions.map((label, i) => (
              <button
                className={`command-option label-option ${i === activeIndex ? "active" : ""}`}
                data-command-index={i}
                key={label}
                onClick={() => onLabel(label)}
              >
                <Icon name="Label" />
                <span>{label}</span>
                {labelMode === "toggle" &&
                  targets.length > 0 &&
                  targets.every((mail) => mail.labels.includes(label)) && (
                    <Icon name="Check" />
                  )}
              </button>
            ))}
            {canCreateLabel && labelMode !== "navigate" && query && !labels.includes(query) && (
              <button className="command-option" onClick={createLabel}>
                <Icon name="Plus" />
                <span>Create label "{query}"</span>
              </button>
            )}
            <div className="label-done">
              {!canCreateLabel && <p className="settings-note">Choose an individual mailbox to create or rename labels.</p>}
              <button className="primary-button" onClick={dismiss}>
                Done
              </button>
            </div>
          </>
        )}
        {mode === "accounts" &&
          filteredAccounts.map((account, i) => (
            <button
              className={`command-option account-option ${i === activeIndex ? "active" : ""}`}
              key={account.id}
              data-command-index={i}
              onMouseMove={() => setMenuIndex(i)}
              onClick={() => onAccount(account.id)}
            >
              <span className="account-avatar">{account.id === UNIFIED_ACCOUNT ? <Icon name="Inbox" size={16} /> : account.name.slice(0, 1)}</span>
              <span className="account-option-name" title={[account.name, account.detail].filter(Boolean).join(" · ")}>{account.name}{account.detail && <small>{account.detail}</small>}</span>
              {account.id === currentAccount && <Icon name="Check" />}
              {account.shortcut !== undefined && <span className="account-shortcut"><Key>Ctrl</Key><Key>{account.shortcut}</Key></span>}
            </button>
          ))}
        {mode === "accounts" && !filteredAccounts.length && <p className="no-options">No matching mailboxes.</p>}
      </div>
      {mode === "accounts" && (
        <div className="account-add">
          <button onClick={() => onSettings("Mailboxes")}><Icon name="Gear" />Manage mailboxes</button>
          <button onClick={() => onSettings("Add Accounts")}>
            <Icon name="Plus" />
            Connect provider
          </button>
        </div>
      )}
      <div className="command-footer">
        <span>
          <Key>{"\u2191"}</Key>
          <Key>{"\u2193"}</Key> to navigate
        </span>
        <span>
          <Key>{"\u21b5"}</Key> to select
        </span>
        <span>
          <Key>esc</Key> to close
        </span>
      </div>
    </Modal>
  );
}
