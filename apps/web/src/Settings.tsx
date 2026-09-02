import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, IconButton, Toggle, Modal } from "./components";
import type { Preferences } from "./data";
import type { InboxStore } from "./inbox";
import type { HostConfiguration } from "./host";
import ProviderConnections from "./ProviderConnections";
import "./settings.css";

export type SettingsProps = {
  preferences: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
  onClose: () => void;
  onOpenShortcuts: () => void;
  initialPage?: string;
  account?: string;
  accounts: string[];
  host: HostConfiguration | null;
  store: InboxStore;
};

const sections = [
  { title: "", items: ["Reminders", "Split Inbox", "Split Inbox Library"] },
  {
    title: "My Account",
    items: ["Add Accounts", "Edit Profile", "Theme", "Shortcuts"],
  },
  {
    title: "Calendar",
    items: [
      "Calendar Accounts",
      "Meeting Links",
      "Timezones",
      "Scheduling",
      "Notifications",
    ],
  },
  {
    title: "Triage",
    items: ["Get Me To Zero", "Bulk Actions", "Hide Empty Split Inboxes"],
  },
  {
    title: "Writing",
    items: ["Emoji", "Signatures"],
  },
  {
    title: "Workflow",
    items: [
      "Auto Advance",
      "Auto Bcc",
      "Blocked Senders",
      "Downloads",
      "Images",
      "Instant Intro",
      "Out of Office Reply",
      "Read Statuses",
      "Recent Opens",
    ],
  },
  {
    title: "Advanced",
    items: [
      "Backtick as Escape",
      "Send + Mark Done",
      "RSVP + Mark Done",
      "Hide Comment Bar",
      "Show Sender Full Names",
    ],
  },
];

const morePreferences = [
  "Default Reply",
  "Send Delay",
  "Font",
  "Density",
  "Show Snippets",
  "Spellcheck",
  "Mark as Read",
  "Notification Options",
  "Calendar Settings",
];
const defaultSplitRules: Record<string, string> = {
  Important: "Direct, personal, and high priority messages",
  Github: "from:notifications@github.com",
  Inbound: "(from:feedback@inbound.new OR from:support@inbound.new)",
  Calendar: "Never miss an invitation again",
  Other:
    "Split conversations from marketing, social networks, and automatic updates",
};

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
  onOpenShortcuts,
  initialPage,
  account = "",
  accounts,
  host,
  store,
}: SettingsProps) {
  const findPage = (value = "") =>
    [
      ...sections.flatMap((section) => section.items),
      ...morePreferences,
      "Availability",
    ].find(
      (item) =>
        item !== "Read Statuses" &&
        item.toLowerCase().replace(/[^a-z]/g, "") ===
          value.toLowerCase().replace(/[^a-z]/g, ""),
    ) || "";
  const [page, setPage] = useState(() => findPage(initialPage));
  const [entry, setEntry] = useState("");
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [splitTab, setSplitTab] = useState<"Active" | "Inactive">("Active");
  const [splitEditor, setSplitEditor] = useState<string | null>(null);
  const [splitRule, setSplitRule] = useState("");
  const [splitHelp, setSplitHelp] = useState(false);
  const sidebar = useRef<HTMLDivElement>(null);
  const openShortcuts = useRef(onOpenShortcuts);
  openShortcuts.current = onOpenShortcuts;

  const closeDetail = () => setPage("");

  useEffect(() => {
    const next = findPage(initialPage);
    if (next === "Shortcuts") {
      openShortcuts.current();
      setPage("");
    } else setPage(next);
  }, [initialPage]);

  useEffect(() => {
    setEntry("");
    setError("");
    setPendingDelete(null);
    setSplitEditor(null);
    setSplitHelp(false);
  }, [page]);

  useEffect(() => {
    if (!page) sidebar.current?.focus({ preventScroll: true });
  }, []);

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
  const splitRules: Record<string, string> = {
    ...(preferences.splitRules &&
    typeof preferences.splitRules === "object" &&
    !Array.isArray(preferences.splitRules)
      ? (preferences.splitRules as Record<string, string>)
      : {}),
  };
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
  const openPage = (next: string) => {
    if (next === "Shortcuts") {
      onOpenShortcuts();
      return;
    }
    setPage(next);
  };
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
            aria-describedby={error ? "settings-entry-error" : undefined}
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
          <p className="settings-error" id="settings-entry-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  };

  let content: ReactNode;
  switch (page) {
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
          {splitEditor !== null ? (
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
                if (splitEditor) delete rules[splitEditor];
                rules[name] = splitRule.trim();
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
                  placeholder="from:example.com"
                  onChange={(event) => setSplitRule(event.target.value)}
                />
              </label>
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
          ) : (
            <>
              <div className="settings-split-intro">
                <p>
                  Customize your splits, create new ones, or explore the library
                  to find your ideal workflow and focus on what matters most.
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
              <div className="settings-split-navigation">
                <div
                  className="settings-split-tabs"
                  role="tablist"
                  aria-label="Split inboxes"
                >
                  {(["Active", "Inactive"] as const).map((tab) => (
                    <button
                      type="button"
                      role="tab"
                      id={`settings-splits-${tab}`}
                      aria-controls="settings-split-list"
                      aria-selected={splitTab === tab}
                      tabIndex={splitTab === tab ? 0 : -1}
                      key={tab}
                      onClick={() => {
                        setSplitTab(tab);
                        setPendingDelete(null);
                      }}
                      onKeyDown={(event) => {
                        if (
                          ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                            event.key,
                          )
                        ) {
                          event.preventDefault();
                          const next =
                            event.key === "Home"
                              ? "Active"
                              : event.key === "End"
                                ? "Inactive"
                                : tab === "Active"
                                  ? "Inactive"
                                  : "Active";
                          setSplitTab(next);
                          document
                            .getElementById(`settings-splits-${next}`)
                            ?.focus();
                        }
                      }}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="settings-link-button"
                  onClick={() => setPage("Hide Empty Split Inboxes")}
                >
                  Hide Empty Split Inboxes
                </button>
              </div>
              <div
                role="tabpanel"
                id="settings-split-list"
                aria-labelledby={`settings-splits-${splitTab}`}
              >
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
                          title={splitRules[split] || defaultSplitRules[split]}
                        >
                          {splitRules[split] ||
                            defaultSplitRules[split] ||
                            "All matching conversations"}
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
                                disabled={preferences.splits.length <= 1}
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
                              splitTab === "Active" &&
                              preferences.splits.length <= 1
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
              </div>
              <footer className="settings-split-footer">
                <button
                  type="button"
                  className="settings-link-button"
                  aria-expanded={splitHelp}
                  onClick={() => setSplitHelp(!splitHelp)}
                >
                  Learn more
                </button>{" "}
                about Split Inboxes to help you stay in flow and eliminate
                context switching.
                {splitHelp && (
                  <p className="settings-note">
                    Select a split to edit its name and search rule. Move splits
                    with the arrow controls, or deactivate a split to keep it in
                    the Inactive tab. Your messages stay in All Mail.{" "}
                    <button
                      type="button"
                      className="settings-link-button"
                      onClick={() => setPage("Split Inbox Library")}
                    >
                      Explore the library
                    </button>
                  </p>
                )}
              </footer>
            </>
          )}
        </div>
      );
      break;
    case "Split Inbox Library":
      content = (
        <div className="settings-library">
          {[
            "Important",
            "Github",
            "Inbound",
            "Calendar",
            "Newsletters",
            "Receipts",
            "Other",
          ].map((split) => (
            <div className="settings-control-row" key={split}>
              <span>{split}</span>
              <button
                type="button"
                className="settings-text-button"
                disabled={preferences.splits.includes(split)}
                onClick={() =>
                  onChange({
                    splits: [...preferences.splits, split],
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
          {toggle("showImages", "Automatically show remote images", false, "Loads images directly from senders’ servers.")}
          <div className="settings-control-row"><span>Known tracking pixels</span><span>Blocked</span></div>
          {toggle("showAvatars", "Show sender avatars")}
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
          {select(
            "inboxZeroAge",
            "Focus on conversations from",
            [
              "The last week",
              "The last month",
              "The last three months",
              "All time",
            ],
            "All time",
          )}
          {checkbox("celebrateInboxZero", "Celebrate Inbox Zero", true)}
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
    case "Add Accounts":
      content = <ProviderConnections host={host} store={store} />;
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
          {select("timeFormat", "Time format", ["12 hour", "24 hour"])}
          {field("timezone", "Time zone", "America/New_York")}
          {toggle("showWeekends", "Show weekends", true)}
          {toggle("declinedEvents", "Show declined events")}
          {toggle("calendarNotifications", "Event notifications", true)}
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

  const dialogTitle =
    page === "Split Inbox"
      ? splitEditor === null
        ? "Split Inbox Settings"
        : splitEditor
          ? "Edit Split Inbox"
          : "Add Split Inbox"
      : page;

  return (
    <div
      className="settings-main"
      ref={sidebar}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (
          !page &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === "k"
        )
          return;
        if (event.key === "Escape" && !page) {
          event.stopPropagation();
          onClose();
        }
        // Do not let letter shortcuts in the mailbox act on a focused settings control.
        event.stopPropagation();
      }}
    >
      <header className="settings-heading">
        <h2>Settings</h2>
        <IconButton
          className="settings-close"
          name="Close"
          title="Close settings"
          onClick={onClose}
        />
      </header>
      <div className="settings-scroll">
        {sections.map((section) => (
          <section
            className="settings-section"
            key={section.title}
            aria-label={section.title || "Inbox preferences"}
          >
            {section.title && <h3>{section.title}</h3>}
            {section.items.map((item) => {
              const setting = inlineToggles[item];
              return setting ? (
                <div className="settings-menu-row" key={item}>
                  <button
                    type="button"
                    className="settings-menu-label"
                    onClick={() =>
                      onChange({
                        [setting[0]]: !enabled(setting[0], setting[1]),
                      })
                    }
                  >
                    {item}
                  </button>
                  <Toggle
                    label={item}
                    checked={enabled(setting[0], setting[1])}
                    onChange={(value) => onChange({ [setting[0]]: value })}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="settings-menu-row"
                  key={item}
                  onClick={() => openPage(item)}
                >
                  {item}
                </button>
              );
            })}
          </section>
        ))}
        <details className="settings-more-preferences">
          <summary>More Preferences</summary>
          {morePreferences.map((item) => (
            <button
              type="button"
              className="settings-menu-row"
              key={item}
              onClick={() => openPage(item)}
            >
              {item}
            </button>
          ))}
        </details>
      </div>
      {page && content && (
        <Modal
          label={dialogTitle}
          onClose={closeDetail}
          className={`settings-dialog settings-${page.toLowerCase().replaceAll(" ", "-")}-dialog ${page === "Split Inbox" ? "settings-split-dialog" : ""}`}
        >
          <header className="settings-dialog-header">
            <h2>{dialogTitle}</h2>
            <IconButton
              name="Close"
              title={`Close ${page}`}
              onClick={closeDetail}
            />
          </header>
          <div
            className={
              page === "Theme" ? "settings-theme-body" : "settings-dialog-body"
            }
          >
            {content}
          </div>
        </Modal>
      )}
    </div>
  );
}

export default Settings;
