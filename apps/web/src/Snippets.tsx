import {
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useState,
  type FormEvent,
} from "react";
import { Icon, IconButton, Key, Modal } from "./components";
import { loadSaved } from "./data";
import { writeSaved } from "./storage";
import "./auxiliary.css";

type Snippet = { id: string; title: string; body: string };
type SnippetMetrics = { uses: number; modified?: string; lastUsed?: string };
const defaults: Snippet[] = [
  {
    id: "ref-schedule",
    title: "Schedule",
    body: "Thanks {first_name}! Adding Matti on CC who will find us time to connect.",
  },
  {
    id: "ref-decline",
    title: "Decline",
    body: "Hi {first_name}, Thanks for the note! I'm not interested right now, but perhaps we can reconnect in the future.",
  },
  {
    id: "ref-calendly",
    title: "Calendly",
    body: "Please find time here: calendly.com/example. Very much looking forward to it!",
  },
  {
    id: "ref-call",
    title: "Call follow-up",
    body: "Hi {first_name}, It was so great talking today! As discussed, I will follow up with the next steps shortly.",
  },
  {
    id: "ref-zoom",
    title: "Zoom link",
    body: "We can use my Zoom link: zoom.us/1234567890. Looking forward to it!",
  },
];

export function loadSnippets(): Snippet[] {
  const saved = loadSaved<Snippet[]>("snippets", defaults);
  return Array.isArray(saved)
    ? saved.filter(
        (item) =>
          item &&
          typeof item.id === "string" &&
          typeof item.title === "string" &&
          typeof item.body === "string" &&
          !(
            item.id === "ref-company" &&
            item.title === "Company description" &&
            item.body ===
              "Superhuman is the fastest email experience in the world. Our customers get through their inbox twice as fast."
          ),
      )
    : defaults;
}

function snippetText(body: string) {
  if (!/<\/?[a-z][\s\S]*>/i.test(body)) return body;
  const doc = new DOMParser().parseFromString(
    body.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n\n"),
    "text/html",
  );
  return (doc.body.textContent || "").trim();
}

function snippetHTML(text: string) {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return escaped
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
    .join("");
}

export default function Snippets({
  onCompose,
  onBack,
  onOpenFolders,
  onOpenSettings,
}: {
  onCompose: (subject: string, body: string) => void;
  onBack: () => void;
  onOpenFolders?: () => void;
  onOpenSettings?: () => void;
}) {
  const [snippets, setSnippets] = useState(loadSnippets);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [deleting, setDeleting] = useState<Snippet | null>(null);
  const [error, setError] = useState("");
  const [metrics, setMetrics] = useState<Record<string, SnippetMetrics>>(() =>
    loadSaved("snippet-metrics", {}),
  );
  const search = useDeferredValue(query.trim().toLowerCase());
  const visible = snippets.filter((snippet) =>
    `${snippet.title} ${snippetText(snippet.body)}`
      .toLowerCase()
      .includes(search),
  );
  const active =
    visible.find((snippet) => snippet.id === selected) || visible[0];
  const closeEditor = useCallback(() => setEditing(null), []);
  const closeDelete = useCallback(() => {
    setDeleting(null);
    setError("");
  }, []);
  function persist(next: Snippet[]) {
    if (!writeSaved("snippets", next))
      throw new Error("Browser storage is unavailable.");
    setSnippets(next);
  }
  function compose(snippet: Snippet) {
    const next = {
      ...metrics,
      [snippet.id]: {
        ...metrics[snippet.id],
        uses: (metrics[snippet.id]?.uses || 0) + 1,
        lastUsed: new Date().toISOString(),
      },
    };
    if (!writeSaved("snippet-metrics", next))
      return setError(
        "Could not save snippet usage. Browser storage is unavailable.",
      );
    setMetrics(next);
    onCompose(
      snippet.id === "ref-call" ? "Following up on our call" : snippet.title,
      snippetHTML(snippetText(snippet.body)),
    );
  }
  function newSnippet() {
    setEditing({ id: "", title: "", body: "" });
  }
  function formattedDate(date?: string) {
    if (!date) return "Not recorded";
    const value = new Date(date);
    const day = value.getDate(),
      remainder = day % 100;
    const suffix =
      remainder >= 11 && remainder <= 13
        ? "th"
        : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ||
          "th";
    return `${value.toLocaleDateString("en-US", { month: "long" })} ${day}${suffix}, ${value.getFullYear()}`;
  }
  const shortcut = useEffectEvent((event: KeyboardEvent) => {
    if (document.querySelector(".app.settings-open")) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('input,textarea,select,[contenteditable="true"]')
    )
      return;
    if (document.querySelector('[role="dialog"]') || event.altKey) return;
    if (!event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "c")
      newSnippet();
    else if (event.key === ";" && active) compose(active);
    else if (!event.metaKey && !event.ctrlKey && event.key === "Escape") {
      if (sidebarOpen) setSidebarOpen(false);
      else if (searchOpen) {
        setSearchOpen(false);
        setQuery("");
      } else onBack();
    } else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => shortcut(event);
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);
  const activeMetrics = active && metrics[active.id];
  return (
    <section
      className={`aux-view snippets-view ${sidebarOpen ? "aux-sidebar-open" : ""}`}
      aria-label="Snippets"
    >
      <div className="aux-main snippets-main">
        <header className="aux-header snippets-header">
          <IconButton
            name="LinesThree"
            title={onOpenFolders ? "Switch folders" : "Back to mail"}
            className="snippets-folder-button"
            onClick={onOpenFolders || onBack}
          />
          <h1>Snippets</h1>
          <div className="aux-header-actions">
            <IconButton
              name="PencilSquircle"
              title="Compose"
              onClick={() => onCompose("", "")}
            />
            <IconButton
              name="Search"
              title="Search snippets"
              aria-expanded={searchOpen}
              onClick={() => {
                setSearchOpen(!searchOpen);
                setQuery("");
              }}
            />
            <IconButton
              name="Snippet"
              title="Show snippet details"
              className="aux-mobile-sidebar-button"
              onClick={() => setSidebarOpen(true)}
            />
          </div>
        </header>
        {searchOpen && (
          <div className="snippets-search">
            <Icon name="Search" />
            <input
              type="search"
              aria-label="Search snippets"
              placeholder="Search snippets"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span>{visible.length}</span>
            <IconButton
              name="Close"
              title="Close snippet search"
              onClick={() => {
                setSearchOpen(false);
                setQuery("");
              }}
            />
          </div>
        )}
        <div className="snippets-list" aria-label="Saved snippets">
          <section className="snippet-section" aria-label="Snippets">
            <header className="snippet-section-header snippet-table-grid">
              <h2>Snippets</h2>
              <button onClick={newSnippet}>New snippet</button>
              <span title="Times used in a draft">Uses</span>
            </header>
            {visible.map((snippet) => (
              <button
                key={snippet.id}
                className={`snippet-row snippet-table-grid ${active?.id === snippet.id ? "selected" : ""}`}
                onClick={() => setSelected(snippet.id)}
                onDoubleClick={() =>
                  setEditing({
                    ...snippet,
                    body: snippetText(snippet.body),
                  })
                }
                aria-pressed={active?.id === snippet.id}
              >
                <strong>{snippet.title}</strong>
                <span className="snippet-row-body">
                  {snippet.id === "ref-call" && (
                    <span className="snippet-row-subject">
                      Following up on our call
                    </span>
                  )}
                  {snippetText(snippet.body).replaceAll("\n", " ")}
                </span>
                <span className="snippet-metric" title="Times used in a draft">
                  {metrics[snippet.id]?.uses || 0}
                </span>
              </button>
            ))}
          </section>
          {!visible.length && (
            <div className="aux-empty">
              <Icon name="Snippet" size={24} />
              <p>
                {query ? "No snippets match your search." : "No snippets yet."}
              </p>
              <button
                className="aux-button"
                onClick={() => (query ? setQuery("") : newSnippet())}
              >
                {query ? "Clear search" : "Create snippet"}
              </button>
            </div>
          )}
        </div>
      </div>
      <aside
        className="aux-owned-sidebar snippet-owned-sidebar"
        aria-label="Snippet details"
      >
        <IconButton
          name="Close"
          title="Close snippet details"
          className="aux-mobile-sidebar-close"
          onClick={() => setSidebarOpen(false)}
        />
        <div className="snippet-sidebar-content">
          {active && (
            <>
              <header className="snippet-detail-heading">
                <h2>{active.title}</h2>
                <div className="snippet-detail-actions">
                  <IconButton
                    name="PencilSquircle"
                    title={`Edit ${active.title}`}
                    onClick={() =>
                      setEditing({ ...active, body: snippetText(active.body) })
                    }
                  />
                  <IconButton
                    name="Trash"
                    title={`Delete ${active.title}`}
                    onClick={() => setDeleting(active)}
                  />
                </div>
              </header>
              <div className="snippet-detail-body">
                {snippetText(active.body)}
              </div>
              <dl className="snippet-metadata">
                <div>
                  <dt>Modified</dt>
                  <dd>{formattedDate(activeMetrics?.modified)}</dd>
                </div>
                <div>
                  <dt title="Last used in a draft">Last used</dt>
                  <dd>
                    {activeMetrics?.lastUsed
                      ? formattedDate(activeMetrics.lastUsed)
                      : "Never"}
                  </dd>
                </div>
              </dl>
            </>
          )}
          <div className="snippet-shortcuts">
            <button onClick={newSnippet}>
              <span>Create Snippet</span>
              <Key>C</Key>
            </button>
            <button
              disabled={!active}
              onClick={() => active && compose(active)}
            >
              <span>Use Snippet Inline</span>
              <Key>;</Key>
            </button>
            <button
              disabled={!active}
              onClick={() => active && compose(active)}
            >
              <span>Use Snippet</span>
              <span>
                <Key>⌘</Key> <Key>;</Key>
              </span>
            </button>
          </div>
          {error && (
            <p className="aux-form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="aux-sidebar-footer">
          {onOpenSettings && (
            <IconButton name="Gear" title="Settings" onClick={onOpenSettings} />
          )}
        </footer>
      </aside>
      {editing && (
        <SnippetEditor
          snippet={editing}
          onClose={closeEditor}
          onSave={(snippet) => {
            const saved = {
              ...snippet,
              id: snippet.id || crypto.randomUUID(),
              body: snippetHTML(snippet.body),
            };
            persist(
              snippet.id
                ? snippets.map((item) =>
                    item.id === snippet.id ? saved : item,
                  )
                : [...snippets, saved],
            );
            const next = {
              ...metrics,
              [saved.id]: {
                ...metrics[saved.id],
                uses: metrics[saved.id]?.uses || 0,
                modified: new Date().toISOString(),
              },
            };
            if (writeSaved("snippet-metrics", next)) {
              setMetrics(next);
            } else {
              setError(
                "Snippet saved, but its modification date could not be saved.",
              );
            }
            setSelected(saved.id);
            setQuery("");
            closeEditor();
          }}
        />
      )}
      {deleting && (
        <Modal
          label="Delete snippet"
          onClose={closeDelete}
          className="aux-editor snippet-delete-dialog"
        >
          <h2>Delete snippet?</h2>
          <p>Delete &quot;{deleting.title}&quot;?</p>
          {error && (
            <p role="alert" className="aux-form-error">
              {error}
            </p>
          )}
          <footer className="aux-editor-footer">
            <button className="aux-button aux-cancel" onClick={closeDelete}>
              Cancel <Key>Esc</Key>
            </button>
            <button
              className="aux-button aux-danger"
              onClick={() => {
                try {
                  persist(snippets.filter((item) => item.id !== deleting.id));
                  closeDelete();
                } catch {
                  setError(
                    "Could not delete this snippet. Browser storage is unavailable.",
                  );
                }
              }}
            >
              Delete
            </button>
          </footer>
        </Modal>
      )}
    </section>
  );
}

function SnippetEditor({
  snippet,
  onClose,
  onSave,
}: {
  snippet: Snippet;
  onClose: () => void;
  onSave: (snippet: Snippet) => void;
}) {
  const [title, setTitle] = useState(snippet.title);
  const [body, setBody] = useState(snippet.body);
  const [error, setError] = useState("");
  function save(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !body.trim())
      return setError("Add a name and message for this snippet.");
    try {
      onSave({ id: snippet.id, title: title.trim(), body });
    } catch {
      setError("Could not save this snippet. Browser storage may be full.");
    }
  }
  return (
    <Modal
      label={snippet.id ? "Edit snippet" : "New snippet"}
      onClose={onClose}
      className="aux-editor snippet-editor"
    >
      <form onSubmit={save}>
        <div className="aux-editor-heading">
          <h2>{snippet.id ? "Edit snippet" : "New snippet"}</h2>
        </div>
        <label className="snippet-name-field">
          <span>Name</span>
          <input
            aria-label="Snippet name"
            placeholder="Name your snippet"
            autoFocus
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <IconButton
          name="Close"
          title="Close snippet"
          className="snippet-editor-close"
          onClick={onClose}
        />
        <textarea
          className="snippet-body-input"
          aria-label="Snippet body"
          placeholder="Write your snippet..."
          rows={12}
          required
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {error && (
          <p role="alert" className="aux-form-error">
            {error}
          </p>
        )}
        <footer className="aux-editor-footer">
          <button
            type="button"
            className="aux-button aux-cancel"
            onClick={onClose}
          >
            Cancel <Key>Esc</Key>
          </button>
          <button type="submit" className="aux-button aux-primary">
            Save snippet
          </button>
        </footer>
      </form>
    </Modal>
  );
}
