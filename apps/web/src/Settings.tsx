import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon, IconButton, Key, Toggle } from "./components";
import { shortcutGroups } from "./shortcuts";
import type { Preferences } from "./data";
import type { InboxStore } from "./inbox";
import type { HostConfiguration } from "./host";
import ProviderConnections from "./ProviderConnections";
import MailboxSettings from "./MailboxSettings";
import AiTriageSettings from "./AiTriageSettings";
import type { AiTriageActions } from "../../shared/ai-triage";
import "./settings.css";
import { attentionSplit, splitTemplates } from "../../shared/splits";
import { splitRuleError } from "./mail-search";

export type SettingsProps = {
  preferences: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
  onClose: () => void;
  onSectionChange?: (section: string) => void;
  initialPage?: string;
  jumpRequest?: number;
  onExitGuardChange?: (guard: (() => boolean) | null) => void;
  account?: string;
  accounts: string[];
  host: HostConfiguration | null;
  store: InboxStore;
  /** Set when the page reloaded after an OAuth redirect; Add Accounts resumes onboarding for this connection. */
  onboardingReturn?: { providerId: string; connectionId: string | null } | null;
  /** Clears the completed onboarding return without leaving the settings page. */
  onOnboardingDone?: () => void;
  onStartZero?: () => void;
  zeroReady?: boolean;
  zeroResumable?: boolean;
  aiActions?: AiTriageActions;
  aiMailboxes?: Array<{ id: string; name: string; email?: string }>;
};

const sections = [
  "AI triage", "Mailboxes", "Add Accounts", "Edit Profile",
  "Theme", "Font", "Density", "Images",
  "Split Inbox", "Split Inbox Library", "Hide Empty Split Inboxes", "Get Me To Zero", "Bulk Actions",
  "Reminders", "Auto Advance", "Mark as Read", "Recent Opens", "Read Statuses",
  "Signatures", "Default Reply", "Send Delay", "Auto Bcc", "Emoji", "Spellcheck", "Instant Intro",
  "Blocked Senders", "Downloads", "Out of Office Reply",
  "Calendar Settings", "Meeting Links", "Timezones", "Scheduling", "Notifications", "Notification Options",
  "Backtick as Escape", "Send + Mark Done", "RSVP + Mark Done", "Hide Comment Bar", "Show Sender Full Names",
  "Shortcuts",
];
const sectionAliases: Record<string, string> = {
  "Calendar Accounts": "Calendar Settings",
  Availability: "Scheduling",
  "Show Snippets": "Density",
};
const sectionId = (name: string) => `settings-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const sectionTitle = (name: string) => name === "AI triage" ? name
  : name === "Auto Bcc" ? "Auto Bcc"
  : name === "RSVP + Mark Done" ? "RSVP + mark done"
  : name[0] + name.slice(1).toLowerCase();
const findSection = (value = "") => {
  const match = [...sections, ...Object.keys(sectionAliases)].find(name =>
    name.toLowerCase().replace(/[^a-z]/g, "") === value.toLowerCase().replace(/[^a-z]/g, ""));
  return match ? sectionAliases[match] || match : "";
};
const defaultSplitRules: Record<string, string> = Object.assign(Object.create(null), {
  Important: "Correspondence, actionable mail, and uncertain messages",
  Other: "Promotions and newsletters with subscription evidence",
});

const inlineToggles: Record<string, [string, boolean]> = {
  "Recent Opens": ["recentOpens", true],
  "Show Snippets": ["showSnippets", true],
  Spellcheck: ["spellcheck", true],
  "Read Statuses": ["readReceipts", true],
  "Backtick as Escape": ["backtickAsEscape", false],
  "Send + Mark Done": ["sendAndMarkDone", false],
  "RSVP + Mark Done": ["rsvpAndMarkDone", true],
  "Hide Comment Bar": ["hideCommentBar", false],
  "Show Sender Full Names": ["showSenderFullNames", false],
};

export function Settings({
  preferences,
  onChange,
  onClose,
  onSectionChange,
  initialPage,
  jumpRequest = 0,
  onExitGuardChange,
  account = "",
  accounts,
  host,
  store,
  onboardingReturn = null,
  onOnboardingDone,
  aiActions,
  onStartZero,
  zeroReady = false,
  zeroResumable = false,
  aiMailboxes = [],
}: SettingsProps) {
  const [entry, setEntry] = useState("");
  const [error, setError] = useState("");
  const [listEntries, setListEntries] = useState<Record<string, string>>({});
  const [listErrors, setListErrors] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [splitEditor, setSplitEditor] = useState<string | null>(null);
  const [splitRule, setSplitRule] = useState("");
  const [mailboxEditState, setMailboxEditState] = useState({ dirty: false, saving: false });
  const [aiEditState, setAiEditState] = useState({ dirty: false, saving: false });
  const [exitNotice, setExitNotice] = useState("");
  const [onboarding, setOnboarding] = useState<{ title: string; back: (() => void) | null; busy: boolean }>({ title: "Add account", back: null, busy: false });
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const exitState = useRef({ dirty: false, busy: false });
  const authorizing = useRef(false);
  exitState.current = {
    dirty: mailboxEditState.dirty || aiEditState.dirty || Object.values(listEntries).some(value => value.trim()) ||
      splitEditor !== null && (entry !== splitEditor || splitRule !== ((preferences.splitRules as Record<string, string> | undefined)?.[splitEditor] || "")),
    busy: mailboxEditState.saving || aiEditState.saving || onboarding.busy,
  };
  const canExit = useCallback(() => {
    if (exitState.current.busy) {
      setExitNotice("Wait for the current save or account connection to finish before leaving settings.");
      heading.current?.focus({ preventScroll: true });
      return false;
    }
    return !exitState.current.dirty || window.confirm("Discard unsaved settings changes?");
  }, []);
  useLayoutEffect(() => {
    onExitGuardChange?.(canExit);
    return () => onExitGuardChange?.(null);
  }, [canExit, onExitGuardChange]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (authorizing.current || !exitState.current.dirty && !exitState.current.busy) return;
      event.preventDefault();
      event.returnValue = "";
    };
    addEventListener("beforeunload", beforeUnload);
    return () => removeEventListener("beforeunload", beforeUnload);
  }, []);
  useEffect(() => {
    if (!exitState.current.busy) setExitNotice("");
    if (!onboarding.busy) authorizing.current = false;
  }, [mailboxEditState.saving, aiEditState.saving, onboarding.busy]);
  const authorizeRedirect = () => {
    if (exitState.current.dirty && !window.confirm("Signing in will leave this page. Discard unsaved settings changes?")) return false;
    authorizing.current = true;
    return true;
  };
  const jumpTo = useCallback((name: string) => {
    const section = findSection(name);
    if (!section) root.current?.querySelector<HTMLElement>(".settings-scroll")?.scrollTo({ top: 0 });
    const target = section ? root.current?.querySelector<HTMLElement>(`#${sectionId(section)}`) : heading.current;
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    // Run after a command dialog restores focus during its cleanup.
    jumpTo(initialPage || "");
  }, [initialPage, jumpRequest, jumpTo]);

  const text = (key: string, fallback = "") =>
    typeof preferences[key] === "string"
      ? (preferences[key] as string)
      : fallback;
  const enabled = (key: string, fallback = false) =>
    typeof preferences[key] === "boolean"
      ? (preferences[key] as boolean)
      : fallback;
  const list = (key: string, fallback: string[] = []) =>
    Array.isArray(preferences[key])
      ? (preferences[key] as unknown[]).filter(
          (item): item is string => typeof item === "string",
        )
      : fallback;
  const inactiveSplits = list("inactiveSplits").filter(
    (split) => !preferences.splits.includes(split),
  );
  const splitRules: Record<string, string> = Object.assign(Object.create(null),
    (preferences.splitRules &&
    typeof preferences.splitRules === "object" &&
    !Array.isArray(preferences.splitRules)
      ? (preferences.splitRules as Record<string, string>)
      : {}),
  );
  const signatureAccounts = [
    ...new Set([account, ...accounts]),
  ];
  const signatureAccount = text("signatureAccount", account);
  const signaturesByAccount =
    preferences.signaturesByAccount &&
    typeof preferences.signaturesByAccount === "object"
      ? (preferences.signaturesByAccount as Record<string, string>)
      : {};
  const checkbox = (
    key: string,
    label: string,
    fallback = false,
    note?: string,
  ) => (
    <label className="settings-checkbox-row" key={key}>
      <span>
        {label}
        {note && <span className="settings-checkbox-note">{note}</span>}
      </span>
      <input
        type="checkbox"
        checked={enabled(key, fallback)}
        onChange={(event) => onChange({ [key]: event.target.checked })}
      />
    </label>
  );
  const inlineSelect = (
    label: string,
    value: string,
    options: [string, string][],
    change: (value: string) => void,
  ) => (
    <span className="settings-inline-select">
      <span aria-hidden="true">
        {options.find((option) => option[0] === value)?.[1] || value}
      </span>
      <Icon name="ChevronDown" size={14} />
      <select
        aria-label={label}
        value={value}
        onChange={(event) => change(event.target.value)}
      >
        {options.map(([value, label]) => (
          <option value={value} key={value}>
            {label}
          </option>
        ))}
      </select>
    </span>
  );
  const toggle = (
    key: string,
    label: string,
    fallback = false,
    note?: string,
  ) => (
    <div className="settings-control-row" key={key}>
      <div>
        <span>{label}</span>
        {note && <p className="settings-note">{note}</p>}
      </div>
      <Toggle
        checked={enabled(key, fallback)}
        label={label}
        onChange={(value) => onChange({ [key]: value })}
      />
    </div>
  );
  const select = (
    key: string,
    label: string,
    options: string[],
    fallback = options[0],
  ) => (
    <label className="settings-control-row" key={key}>
      <span>{label}</span>
      <select
        value={text(key, fallback)}
        onChange={(event) => onChange({ [key]: event.target.value })}
      >
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
  const field = (
    key: string,
    label: string,
    fallback = "",
    type = "text",
    placeholder?: string,
  ) => (
    <label className="settings-field" key={key}>
      <span>{label}</span>
      <input
        type={type}
        value={text(key, fallback)}
        placeholder={placeholder}
        onChange={(event) => onChange({ [key]: event.target.value })}
      />
    </label>
  );
  const textarea = (
    key: string,
    label: string,
    fallback = "",
    placeholder?: string,
  ) => (
    <label className="settings-field" key={key}>
      <span>{label}</span>
      <textarea
        rows={5}
        value={text(key, fallback)}
        placeholder={placeholder}
        onChange={(event) => onChange({ [key]: event.target.value })}
      />
    </label>
  );
  const choices = (
    key: string,
    options: [string, string][],
    fallback: string,
  ) => (
    <div className="settings-radio-list">
      {options.map(([value, label]) => (
        <label className="settings-radio-row" key={value}>
          <input
            type="radio"
            name={`settings-${key}`}
            value={value}
            checked={text(key, fallback) === value}
            onChange={() => onChange({ [key]: value })}
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
  const editList = (
    key: string,
    label: string,
    placeholder: string,
    fallback: string[] = [],
    email = false,
  ) => {
    const values = list(key, fallback);
    const entry = listEntries[key] || "";
    const error = listErrors[key] || "";
    const setEntry = (value: string) => setListEntries(previous => ({ ...previous, [key]: value }));
    const setError = (value: string) => setListErrors(previous => ({ ...previous, [key]: value }));
    return (
      <div className="settings-list-editor">
        {values.length > 0 ? (
          <ul className="settings-editable-list">
            {values.map((value) => (
              <li key={value}>
                <span>{value}</span>
                <IconButton
                  name="Close"
                  title={`Remove ${value}`}
                  size={14}
                  onClick={() =>
                    onChange({ [key]: values.filter((item) => item !== value) })
                  }
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-note">
            {key === "blockedSenders" ? "No blocked senders." : "None added."}
          </p>
        )}
        <form
          className="settings-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            const value = entry.trim();
            if (!value) return;
            if (
              values.some((item) => item.toLowerCase() === value.toLowerCase())
            ) {
              setError("Already added.");
              return;
            }
            onChange({ [key]: [...values, value] });
            setEntry("");
            setError("");
          }}
        >
          <input
            type={email ? "email" : "text"}
            aria-label={label}
            aria-describedby={error ? `settings-${key}-error` : undefined}
            value={entry}
            placeholder={placeholder}
            required
            onChange={(event) => {
              setEntry(event.target.value);
              setError("");
            }}
          />
          <button
            className="settings-button"
            type="submit"
            disabled={!entry.trim()}
          >
            Add
          </button>
        </form>
        {error && (
          <p className="settings-error" id={`settings-${key}-error`} role="alert">
            {error}
          </p>
        )}
      </div>
    );
  };

  const sectionHref = (name: string) => {
    const params = new URLSearchParams(location.hash.replace(/^#\/?/, ""));
    params.set("settings", name);
    return `#/${params}`;
  };
  const renderSection = (page: string) => {
  let content: ReactNode;
  switch (page) {
    case "Shortcuts":
      content = <div className="settings-shortcuts">{shortcutGroups.map(([name, rows]) => (
        <section key={name} aria-label={name}>
          <h3>{name}</h3>
          <dl>{rows.map(([label, key]) => <div key={label}><dt>{label}</dt><dd><Key>{key}</Key></dd></div>)}</dl>
        </section>
      ))}</div>;
      break;
    case "AI triage":
      content = <AiTriageSettings actions={aiActions} mailboxes={aiMailboxes} onEditStateChange={setAiEditState} />;
      break;
    case "Theme":
      content = (
        <div className="settings-theme-picker">
          <fieldset className="settings-theme-column">
            <legend>Appearance</legend>
            {(
              [
                ["System", "Match System", "system"],
                ["Light", "Light", "light"],
                ["Carbon", "Dark", "dark"],
              ] as const
            ).map(([value, label, icon]) => (
              <label className="settings-theme-choice" key={value}>
                <input
                  type="radio"
                  name="settings-appearance"
                  checked={preferences.theme === value}
                  onChange={() => onChange({ theme: value })}
                />
                <svg
                  className="settings-appearance-icon"
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.15"
                  aria-hidden="true"
                >
                  {icon === "system" ? (
                    <>
                      <path d="M12 13H2V4h15v5M1 16h9M5 13l-1 3M14 13h4m-2-2v4" />
                      <path d="m13 10 1 1m4-1-1 1m-4 5 1-1m4 1-1-1" />
                    </>
                  ) : icon === "light" ? (
                    <>
                      <circle cx="10" cy="10" r="4.5" />
                      <path d="M10 1v2m0 14v2M1 10h2m14 0h2M3.6 3.6 5 5m10 10 1.4 1.4M3.6 16.4 5 15M15 5l1.4-1.4" />
                    </>
                  ) : (
                    <path d="M8 2a8 8 0 1 0 10 10A8 8 0 0 1 8 2Z" />
                  )}
                </svg>
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="settings-theme-column">
            <legend>Style</legend>
            {["Superlocal", "Classic"].map((style) => (
              <label
                className={`settings-theme-choice ${style === "Classic" ? "settings-theme-classic" : ""}`}
                key={style}
              >
                <input
                  type="radio"
                  name="settings-style"
                  checked={
                    (text("themeStyle") === "Classic"
                      ? "Classic"
                      : "Superlocal") === style
                  }
                  onChange={() => onChange({ themeStyle: style })}
                />
                <span
                  className={`settings-style-icon settings-style-${style.toLowerCase()}`}
                >
                  <Icon name="Envelope" size={16} />
                </span>
                <span>{style}</span>
              </label>
            ))}
          </fieldset>
        </div>
      );
      break;
    case "Signatures":
      content = (
        <div className="settings-signatures">
          <div className="settings-signature-account">
            Signature for:{" "}
            {inlineSelect(
              "Signature account",
              signatureAccount,
              signatureAccounts.map((value) => [value, value]),
              (value) => onChange({ signatureAccount: value }),
            )}
          </div>
          <div className="settings-signature-preview">
            <textarea
              aria-label="Signature"
              spellCheck={preferences.spellcheck}
              value={
                signaturesByAccount[signatureAccount] ?? preferences.signature
              }
              onChange={(event) =>
                onChange({
                  signature: event.target.value,
                  signaturesByAccount: {
                    ...Object.fromEntries(
                      signatureAccounts.map((value) => [
                        value,
                        signaturesByAccount[value] ?? preferences.signature,
                      ]),
                    ),
                    [signatureAccount]: event.target.value,
                  },
                })
              }
            />
            <label className="settings-signature-enable">
              <span>Use signature</span>
              <input
                type="checkbox"
                checked={preferences.signatureEnabled}
                onChange={(event) =>
                  onChange({ signatureEnabled: event.target.checked })
                }
              />
            </label>
          </div>
          <div className="settings-signature-options">
            {checkbox(
              "signatureReplies",
              "Include signature on replies and forwards",
              true,
            )}
          </div>
        </div>
      );
      break;
    case "Notifications":
      content = (
        <div className="settings-notifications">
          {checkbox(
            "desktopNotifications",
            "Email notifications",
            true,
            "If Important · Other is on, notify for Important only",
          )}
          <section className="settings-calendar-notifications">
            <h3>Calendar notifications</h3>
            <label className="settings-calendar-notification-account">
              <span>{account}</span>
              <span className="settings-calendar-color" aria-hidden="true" />
              <input
                type="checkbox"
                aria-label={`Calendar notifications for ${account}`}
                checked={enabled("calendarNotifications", true)}
                onChange={(event) =>
                  onChange({ calendarNotifications: event.target.checked })
                }
              />
            </label>
          </section>
          <div className="settings-notify-me">
            Notify me:{" "}
            {inlineSelect(
              "Notify me before events",
              text("calendarNotificationTime", "2 minutes"),
              [
                ["At time of event", "at time of event"],
                ["1 minute", "1 min before events"],
                ["2 minutes", "2 mins before events"],
                ["5 minutes", "5 mins before events"],
                ["10 minutes", "10 mins before events"],
                ["15 minutes", "15 mins before events"],
              ],
              (value) => onChange({ calendarNotificationTime: value }),
            )}
          </div>
        </div>
      );
      break;
    case "Notification Options":
      content = (
        <>
          {select("notifyFor", "Notify me about", [
            "All messages",
            "Important messages",
            "Mentions only",
          ])}
          {toggle("notificationSound", "Play a sound")}
          {toggle("notificationPreview", "Show message preview", true)}
        </>
      );
      break;
    case "Split Inbox":
      content = (
        <div className="settings-split-inbox">
          {splitEditor !== null && (
            <form
              className="settings-split-editor"
              onSubmit={(event) => {
                event.preventDefault();
                const name = entry.trim();
                if (!name) return;
                if (
                  [...preferences.splits, ...inactiveSplits].some(
                    (split) =>
                      split !== splitEditor &&
                      split.toLowerCase() === name.toLowerCase(),
                  )
                ) {
                  setError("A split with this name already exists.");
                  return;
                }
                const rules = { ...splitRules };
                const category = splitEditor ? attentionSplit({ splitRules, splitAliases: (preferences.splitAliases as Record<string, string>) || {} }, splitEditor) : undefined;
                const invalid = category ? null : splitRuleError(splitRule);
                if (invalid) { setError(invalid); return; }
                if (splitEditor) delete rules[splitEditor];
                if (!category) rules[name] = splitRule.trim();
                const aliases = {
                  ...((preferences.splitAliases as Record<string, string>) ||
                    {}),
                };
                if (splitEditor && splitEditor !== name) {
                  aliases[name] = aliases[splitEditor] || splitEditor;
                  delete aliases[splitEditor];
                }
                onChange({
                  splits: splitEditor
                    ? preferences.splits.map((split) =>
                        split === splitEditor ? name : split,
                      )
                    : [...preferences.splits, name],
                  inactiveSplits: inactiveSplits.map((split) =>
                    split === splitEditor ? name : split,
                  ),
                  splitRules: rules,
                  splitAliases: aliases,
                });
                setSplitEditor(null);
                setEntry("");
                setError("");
              }}
            >
              <label className="settings-field">
                <span>Name</span>
                <input
                  aria-label="Split name"
                  value={entry}
                  required
                  maxLength={40}
                  onChange={(event) => {
                    setEntry(event.target.value);
                    setError("");
                  }}
                />
              </label>
              <label className="settings-field">
                <span>Search rule</span>
                <input
                  aria-label="Split rule"
                  value={splitRule}
                  disabled={!!splitEditor && !!attentionSplit({ splitRules, splitAliases: (preferences.splitAliases as Record<string, string>) || {} }, splitEditor)}
                  placeholder={splitEditor && attentionSplit({ splitRules, splitAliases: (preferences.splitAliases as Record<string, string>) || {} }, splitEditor) ? "Built-in attention category" : "from:john@doe.com"}
                  maxLength={4096}
                  onChange={(event) => setSplitRule(event.target.value)}
                />
              </label>
              {!splitEditor || !attentionSplit({ splitRules, splitAliases: (preferences.splitAliases as Record<string, string>) || {} }, splitEditor) ? <p className="settings-note">Match senders, subjects, or other message details. Combine filters with OR and parentheses. Filters use cached message details, not bodies loaded when opening mail.</p> : null}
              {error && (
                <p className="settings-error" role="alert">
                  {error}
                </p>
              )}
              <div className="settings-split-editor-actions">
                <button
                  type="button"
                  className="settings-text-button"
                  onClick={() => setSplitEditor(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="settings-button"
                  disabled={!entry.trim()}
                >
                  {splitEditor ? "Save Split Inbox" : "Create Split Inbox"}
                </button>
              </div>
            </form>
          )}
              <div className="settings-split-intro">
                <p>
                  Important and Other divide your inbox. Custom filters can overlap either view.
                </p>
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => {
                    setEntry("");
                    setSplitRule("");
                    setError("");
                    setSplitEditor("");
                  }}
                >
                  Add Split Inbox
                </button>
              </div>
              {(["Active", "Inactive"] as const).map(splitTab => (
              <section key={splitTab} className="settings-split-group" aria-label={`${splitTab} split inboxes`}>
                <h3>{splitTab}</h3>
                <ol className="settings-splits">
                  {(splitTab === "Active"
                    ? preferences.splits
                    : inactiveSplits
                  ).map((split, index) => (
                    <li key={split}>
                      <button
                        type="button"
                        className="settings-split-description"
                        onClick={() => {
                          setSplitEditor(split);
                          setEntry(split);
                          setSplitRule(splitRules[split] || "");
                          setError("");
                        }}
                      >
                        <span>{split}</span>
                        <span
                          title={splitRules[split] || defaultSplitRules[((preferences.splitAliases as Record<string, string>) || {})[split] || split]}
                        >
                          {splitRules[split] ||
                            defaultSplitRules[((preferences.splitAliases as Record<string, string>) || {})[split] || split] ||
                            "Add a search rule"}
                        </span>
                      </button>
                      {pendingDelete === split ? (
                        <div className="settings-split-confirm">
                          <button
                            type="button"
                            className="settings-text-button"
                            onClick={() => {
                              const rules = { ...splitRules };
                              delete rules[split];
                              const aliases = {
                                ...((preferences.splitAliases as Record<
                                  string,
                                  string
                                >) || {}),
                              };
                              delete aliases[split];
                              onChange({
                                splits: preferences.splits.filter(
                                  (item) => item !== split,
                                ),
                                inactiveSplits: inactiveSplits.filter(
                                  (item) => item !== split,
                                ),
                                splitRules: rules,
                                splitAliases: aliases,
                              });
                              setPendingDelete(null);
                            }}
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            className="settings-text-button"
                            onClick={() => setPendingDelete(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="settings-split-actions">
                          {splitTab === "Active" ? (
                            <>
                              <IconButton
                                name="ChevronUp"
                                title={`Move ${split} up`}
                                size={14}
                                disabled={index === 0}
                                onClick={() => {
                                  const splits = [...preferences.splits];
                                  [splits[index - 1], splits[index]] = [
                                    splits[index],
                                    splits[index - 1],
                                  ];
                                  onChange({ splits });
                                }}
                              />
                              <IconButton
                                name="ChevronDown"
                                title={`Move ${split} down`}
                                size={14}
                                disabled={
                                  index === preferences.splits.length - 1
                                }
                                onClick={() => {
                                  const splits = [...preferences.splits];
                                  [splits[index + 1], splits[index]] = [
                                    splits[index],
                                    splits[index + 1],
                                  ];
                                  onChange({ splits });
                                }}
                              />
                              <IconButton
                                name="Minus"
                                title={`Deactivate ${split}`}
                                size={14}
                                disabled={!!attentionSplit({ splitRules, splitAliases: (preferences.splitAliases as Record<string, string>) || {} }, split)}
                                onClick={() =>
                                  onChange({
                                    splits: preferences.splits.filter(
                                      (item) => item !== split,
                                    ),
                                    inactiveSplits: [...inactiveSplits, split],
                                  })
                                }
                              />
                            </>
                          ) : (
                            <IconButton
                              name="Plus"
                              title={`Activate ${split}`}
                              size={14}
                              onClick={() =>
                                onChange({
                                  splits: [...preferences.splits, split],
                                  inactiveSplits: inactiveSplits.filter(
                                    (item) => item !== split,
                                  ),
                                })
                              }
                            />
                          )}
                          <IconButton
                            name="Trash"
                            title={`Delete ${split}`}
                            size={14}
                            disabled={
                              !!attentionSplit({ splitRules, splitAliases: (preferences.splitAliases as Record<string, string>) || {} }, split)
                            }
                            onClick={() => setPendingDelete(split)}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
                {splitTab === "Inactive" && !inactiveSplits.length && (
                  <p className="settings-split-empty">
                    No inactive Split Inboxes.
                  </p>
                )}
              </section>
              ))}
              <p className="settings-note">
                Select a split to edit its name and search rule. Move splits with the arrow controls,
                or deactivate a split to keep it in the inactive list. Your messages stay in All Mail.
              </p>
        </div>
      );
      break;
    case "Split Inbox Library":
      content = (
        <div className="settings-library">
          {Object.keys(splitTemplates).map((split) => (
            <div className="settings-control-row" key={split}>
              <span>{split}</span>
              <button
                type="button"
                className="settings-text-button"
                disabled={preferences.splits.includes(split)}
                onClick={() =>
                  onChange({
                    splits: [...preferences.splits, split],
                    splitRules: { ...splitRules, [split]: Object.hasOwn(splitRules, split) ? splitRules[split] : splitTemplates[split] },
                    inactiveSplits: inactiveSplits.filter(
                      (item) => item !== split,
                    ),
                  })
                }
              >
                {preferences.splits.includes(split) ? "Added" : "Add Split"}
              </button>
            </div>
          ))}
        </div>
      );
      break;
    case "Auto Advance":
      content = (
        <div className="settings-auto-advance">
          <p>
            Choose where you go after triaging a conversation (e.g. Mark Done,
            Remind Me, Trash).
          </p>
          <div>
            After triaging a conversation:{" "}
            {inlineSelect(
              "After triaging a conversation",
              preferences.autoAdvance
                ? text("advanceDirection", "Next conversation")
                : "Back to inbox",
              [
                [
                  "Next conversation",
                  "go down and show the older conversation",
                ],
                [
                  "Previous conversation",
                  "go up and show the newer conversation",
                ],
                ["Back to inbox", "go back to the inbox"],
              ],
              (value) =>
                onChange(
                  value === "Back to inbox"
                    ? { autoAdvance: false }
                    : { autoAdvance: true, advanceDirection: value },
                ),
            )}
          </div>
        </div>
      );
      break;
    case "Default Reply":
      content = choices(
        "defaultReply",
        [
          ["Reply all", "Reply All"],
          ["Reply", "Reply"],
        ],
        "Reply all",
      );
      break;
    case "Send Delay":
      content = (
        <>
          {select(
            "sendDelay",
            "Undo send window",
            [...new Set(["No delay", "5 seconds", "10 seconds", "20 seconds", "30 seconds", preferences.sendDelay])],
            "10 seconds",
          )}
          <p className="settings-note">
            Give yourself a moment to undo after sending a message.
          </p>
        </>
      );
      break;
    case "Density":
      content = (
        <>
          {choices(
            "density",
            [
              ["Comfortable", "Comfortable"],
              ["Compact", "Compact"],
            ],
            "Comfortable",
          )}
          {toggle("showSnippets", "Show message snippets", true)}
        </>
      );
      break;
    case "Font":
      content = (
        <>
          {select("font", "Font", [
            "Super Sans",
            "Arial",
            "Helvetica",
            "Georgia",
            "Times New Roman",
            "Monospace",
          ])}
          {select(
            "fontSize",
            "Size",
            ["Small", "Normal", "Large", "Huge"],
            "Normal",
          )}
          <div
            className="settings-font-preview"
            style={{
              fontFamily:
                preferences.font === "Super Sans"
                  ? "var(--font, SuperMailSans, sans-serif)"
                  : preferences.font,
              fontSize:
                (
                  { Small: 12, Normal: 14, Large: 18, Huge: 24 } as Record<
                    string,
                    number
                  >
                )[preferences.fontSize] || 14,
            }}
          >
            The quick brown fox jumps over the lazy dog.
          </div>
        </>
      );
      break;
    case "Mark as Read":
      content = (
        <>
          {toggle("markRead", "Mark conversations as read when opened", true)}
          {select("markReadDelay", "Mark as read", [
            "Immediately",
            "After 2 seconds",
            "After 5 seconds",
          ])}
        </>
      );
      break;
    case "Auto Bcc":
      content = (
        <>
          {toggle("autoBccEnabled", "Automatically Bcc outgoing emails")}
          {editList("autoBcc", "Bcc email address", "Email address", [], true)}
        </>
      );
      break;
    case "Blocked Senders":
      content = editList(
        "blockedSenders",
        "Sender to block",
        "Email address or domain",
      );
      break;
    case "Images":
      content = (
        <>
          {toggle("showImages", "Automatically show remote images", false, "Loads eligible remote images through the Inbox SDK’s authenticated media service.")}
          <div className="settings-control-row"><span>Known tracking pixels</span><span>Blocked</span></div>
          {toggle("showAvatars", "Show sender domain logos", true, "Uses Google favicons for the root domain only, never the email address. Remote images must also be enabled.")}
        </>
      );
      break;
    case "Out of Office Reply":
      content = (
        <>
          {toggle("outOfOfficeEnabled", "Out of Office Reply")}
          <div className="settings-field-pair">
            {field("outOfOfficeStart", "First day", "", "date")}
            {field("outOfOfficeEnd", "Last day", "", "date")}
          </div>
          {field("outOfOfficeSubject", "Subject", "Out of office")}
          {textarea(
            "outOfOfficeMessage",
            "Message",
            "Thanks for your email. I am out of the office and will reply when I return.",
          )}
          {toggle("outOfOfficeContactsOnly", "Only reply to my contacts")}
        </>
      );
      break;
    case "Reminders":
      content = (
        <div className="settings-reminders">
          <h3>Default Reminder</h3>
          <p>When no date or time is specified, remind me:</p>
          <div className="settings-reminder-sentence">
            <label>
              in{" "}
              <input
                type="number"
                aria-label="Reminder days"
                min={1}
                max={365}
                value={
                  typeof preferences.reminderDays === "number"
                    ? preferences.reminderDays
                    : 2
                }
                onChange={(event) => {
                  const days = event.target.valueAsNumber;
                  if (Number.isInteger(days) && days >= 1 && days <= 365)
                    onChange({ reminderDays: days });
                }}
              />{" "}
              days
            </label>
            <label>
              at{" "}
              <input
                type="time"
                aria-label="Reminder time"
                value={text("reminderMorning", "08:00")}
                onChange={(event) => {
                  if (event.target.value)
                    onChange({ reminderMorning: event.target.value });
                }}
              />
            </label>
            {inlineSelect(
              "Reminder condition",
              text("reminderDefault", "If no reply"),
              [
                ["If no reply", "if no reply"],
                ["Regardless", "regardless"],
                ...(text("reminderDefault") === "If unread"
                  ? [["If unread", "if unread"] as [string, string]]
                  : []),
              ],
              (value) => onChange({ reminderDefault: value }),
            )}
          </div>
          <div className="settings-weekdays-only">
            {checkbox(
              "reminderWeekend",
              "Weekdays Only",
              true,
              "When reminders are set as a number of days, count weekdays only. With this option enabled, a reminder set for 2 days on Friday will return on Tuesday.",
            )}
          </div>
        </div>
      );
      break;
    case "Hide Empty Split Inboxes":
      content = (
        <>
          {checkbox(
            "hideEmptySplits",
            "Hide Empty Split Inboxes",
            false,
            "Hide Split Inboxes when they have no conversations.",
          )}
        </>
      );
      break;
    case "Get Me To Zero":
      content = (
        <>
          <p className="settings-note">Work through all unhandled Important conversations, including already-read mail. Review routine groups first, then handle, snooze or move the rest. No AI scan is required.</p>
          <button type="button" className="settings-button zero-settings-entry" disabled={!zeroReady || !onStartZero} onClick={onStartZero}>
            {zeroResumable ? "Resume cleanup" : "Get me to zero"}
          </button>
        </>
      );
      break;
    case "Bulk Actions":
      content = (
        <>
          {checkbox(
            "confirmBulkActions",
            "Confirm before applying bulk actions",
            true,
          )}
          {select("bulkSelectionScope", "Select conversations in", [
            "Current split",
            "All splits",
          ])}
        </>
      );
      break;
    case "Emoji":
      content = (
        <>
          {checkbox("emojiShortcodes", "Convert emoji shortcodes", true)}
          {select("emojiSkinTone", "Default skin tone", [
            "Default",
            "Light",
            "Medium-light",
            "Medium",
            "Medium-dark",
            "Dark",
          ])}
        </>
      );
      break;
    case "Downloads":
      content = (
        <>
          {checkbox("askDownloadLocation", "Ask where to save each attachment")}
          {field("downloadFolder", "Download folder", "Downloads")}
        </>
      );
      break;
    case "Instant Intro":
      content = (
        <>
          {checkbox(
            "instantIntro",
            "Move the introducer to Bcc when replying to an introduction",
            true,
          )}
        </>
      );
      break;
    case "Timezones":
      content = (
        <>
          {field("timezone", "Primary timezone", "America/New_York")}
          {field(
            "secondaryTimezone",
            "Secondary timezone",
            "",
            "text",
            "Europe/London",
          )}
          {select("timeFormat", "Time format", ["12 hour", "24 hour"])}
        </>
      );
      break;
    case "Edit Profile":
      content = (
        <>
          {field("profileName", "Name", "")}
          {field("profileEmail", "Email address", accounts[0], "email")}
          {field("profileJobTitle", "Job title")}
          {field("profileCompany", "Company")}
          {field("profileLocation", "Location")}
        </>
      );
      break;
    case "Mailboxes":
      content = <MailboxSettings host={host} store={store} onEditStateChange={setMailboxEditState} />;
      break;
    case "Add Accounts":
      content = <ProviderConnections host={host} store={store} resume={onboardingReturn} onStepChange={setOnboarding} onDone={onOnboardingDone} onBeforeRedirect={authorizeRedirect} />;
      break;
    case "Calendar Settings":
    case "Calendar Accounts":
      content = (
        <>
          {select("startWeek", "Start week on", [
            "Sunday",
            "Monday",
            "Saturday",
          ])}
          {toggle("showWeekends", "Show weekends", true)}
          {toggle("declinedEvents", "Show declined events")}
        </>
      );
      break;
    case "Meeting Links":
      content = (
        <>
          {select("meetingProvider", "Default meeting provider", [
            "Google Meet",
            "Zoom",
            "Microsoft Teams",
            "Custom link",
          ])}
          {field("meetingLink", "Personal meeting link", "", "url", "https://")}
          {toggle("addMeetingLink", "Add a meeting link to new events", true)}
        </>
      );
      break;
    case "Availability":
    case "Scheduling":
      content = (
        <>
          <div className="settings-field-pair">
            {field("workingHoursStart", "Start time", "09:00", "time")}
            {field("workingHoursEnd", "End time", "17:00", "time")}
          </div>
          {select(
            "meetingDuration",
            "Meeting duration",
            ["15 minutes", "30 minutes", "45 minutes", "60 minutes"],
            "30 minutes",
          )}
          {select("meetingBuffer", "Between meetings", [
            "No buffer",
            "5 minutes",
            "10 minutes",
            "15 minutes",
          ])}
          {toggle("workingDaysOnly", "Weekdays only", true)}
        </>
      );
      break;
    default: {
      const setting = inlineToggles[page];
      content = setting ? toggle(setting[0], page, setting[1]) : null;
    }
  }

  return content;
  };

  return (
    <main className="settings-main" ref={root} aria-labelledby="settings-title"
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") return;
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        // Settings owns its controls; shortcuts must not act on the preserved mail view.
        event.stopPropagation();
      }}>
      <header className="settings-heading">
        <IconButton name="Back" title="Back from settings" onClick={onClose} />
        <h1 id="settings-title" ref={heading} tabIndex={-1}>Settings</h1>
        {exitNotice && <p className="settings-exit-notice" role="alert">{exitNotice}</p>}
      </header>
      <div className="settings-scroll">
        <div className="settings-content">
          <nav className="settings-jumps" aria-label="Jump to settings">
            {[["AI triage", "AI triage"], ["Mailboxes", "Mailboxes"], ["Accounts", "Add Accounts"], ["Appearance", "Theme"], ["Inbox", "Split Inbox"], ["Writing", "Signatures"], ["Workflow", "Blocked Senders"], ["Calendar", "Calendar Settings"], ["Advanced", "Backtick as Escape"], ["Shortcuts", "Shortcuts"]].map(([label, name]) => (
              <a key={name} href={sectionHref(name)} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); if (onSectionChange) onSectionChange(name); else jumpTo(name); }}>{label}</a>
            ))}
          </nav>
          {sections.map(name => (
            <section key={name} className={`settings-section ${sectionId(name)}-section`} aria-labelledby={sectionId(name)}>
              <h2 id={sectionId(name)} tabIndex={-1}>{sectionTitle(name)}</h2>
              {name === "Add Accounts" && onboarding.back && <div className="settings-provider-heading">
                <button type="button" className="settings-text-button" disabled={onboarding.busy} onClick={onboarding.back}>Back to providers</button>
                <span>{onboarding.title}</span>
              </div>}
              <div className="settings-section-body">{renderSection(name)}</div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}

export default Settings;
