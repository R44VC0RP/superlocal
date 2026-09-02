import { memo } from "react";
import { Icon, IconButton, Key } from "./components";
import { folders } from "./data";

type FolderNavigationProps = {
  open: boolean;
  account: string;
  folder: string;
  inboxCount: number;
  labels: string[];
  onClose: () => void;
  onAccounts: () => void;
  onFolder: (folder: string) => void;
  onSnippets: () => void;
  onCreateLabel: () => void;
  onEditLabel: (label: string) => void;
};

function FolderNavigation({
  open,
  account,
  folder: currentFolder,
  inboxCount,
  labels,
  onClose,
  onAccounts,
  onFolder,
  onSnippets,
  onCreateLabel,
  onEditLabel,
}: FolderNavigationProps) {
  return (
    <>
      {open && <div className="navigation-dismiss" onClick={onClose} />}
      <aside
        className={`folder-panel ${open ? "is-open" : ""}`}
        aria-label="Mailboxes"
        aria-hidden={!open}
        inert={!open}
      >
        <button className="account-selector" onClick={onAccounts}>
          <span className="account-avatar">{account.slice(0, 1).toUpperCase()}</span>
          <span>{account}</span>
          <Icon name="CaretLargeRight" />
        </button>
        <nav className="folder-list" aria-label="Folders">
          {folders
            .filter(([folder]) => folder !== "All Mail")
            .map(([folder, key]) => (
              <button
                className={`folder-item ${folder === currentFolder ? "active" : ""}`}
                key={folder}
                onClick={() =>
                  folder === "Snippets" ? onSnippets() : onFolder(folder)
                }
              >
                <span>
                  {folder}
                  {folder === "Inbox" && (
                    <small>
                      Important <span>•</span> Other
                    </small>
                  )}
                </span>
                {folder === "Inbox" && (
                  <span className="folder-count">{inboxCount}</span>
                )}
                {key && (
                  <span className="shortcut">
                    <Key>G</Key>
                    <em>then</em>
                    <Key>{key.toUpperCase()}</Key>
                  </span>
                )}
              </button>
            ))}
          <div className="folder-divider" />
          <div className="folder-section-title">
            <span>Labels</span>
            <IconButton
              name="Plus"
              title="Create label"
              onClick={onCreateLabel}
            />
          </div>
          {labels.map((label, index) => (
            <div
              className={`folder-label-row ${label.includes("/") ? "nested-folder" : ""}`}
              key={label}
            >
              <button
                className={`folder-item label-folder ${index < 5 || label.includes("/") ? "nested" : ""} ${currentFolder === label ? "active" : ""}`}
                onClick={() => onFolder(label)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onEditLabel(label);
                }}
              >
                <Icon name="Label" size={14} />
                {label.split("/").at(-1)}
              </button>
              <IconButton
                name="More"
                title={`Manage label ${label}`}
                className="label-manage"
                onClick={() => onEditLabel(label)}
              />
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}

// Closed contents are inert; always take fresh data and handlers when reopening.
export default memo(
  FolderNavigation,
  (previous, next) => !previous.open && !next.open,
);
