import { useEffect, useRef, useState } from "react";
import { Icon, IconButton, Modal } from "./components";
import {
  IssueRequestError,
  prepareIssueAttempt,
  readBrowserIssueReport,
  readIssueReports,
  readRepoIssuePage,
  readRepoIssueReport,
  removeIssueAttempt,
  saveIssueReport,
  writeRepoIssueReport,
  type IssueListEntry,
  type IssueReport,
} from "./issue-reports";
import { ISSUE_LIMITS } from "../../shared/issue-reports";
import "./issue-reporter.css";

export default function IssueReporter({
  draft,
  issueScope,
  onClose,
  onSaved,
}: {
  draft: IssueReport | null;
  issueScope?: string;
  onClose: () => void;
  onSaved: (storage: "repo" | "browser") => void;
}) {
  const [report, setReport] = useState(draft);
  const [prompt, setPrompt] = useState(draft?.prompt || "");
  const [persistedPrompt, setPersistedPrompt] = useState(draft?.prompt || "");
  const [browserReports, setBrowserReports] = useState<IssueListEntry[] | null>(null);
  const [repoReports, setRepoReports] = useState<IssueListEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [listWarning, setListWarning] = useState("");
  const [opening, setOpening] = useState("");
  const [screenshotUrl, setScreenshotUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const action = useRef(0);
  const listGeneration = useRef(0);
  const savingRef = useRef(false);
  const openingRequest = useRef<AbortController | null>(null);
  const currentScope = useRef(issueScope);
  currentScope.current = issueScope;

  useEffect(() => {
    action.current++;
    savingRef.current = false;
    setSaving(false);
    setReport(draft);
    setPrompt(draft?.prompt || "");
    setPersistedPrompt(draft?.prompt || "");
    setError("");
    return () => {
      action.current++;
      openingRequest.current?.abort();
    };
  }, [draft]);

  useEffect(() => {
    action.current++;
    savingRef.current = false;
    setSaving(false);
    setOpening("");
    if (draft) return;
    let active = true;
    const controller = new AbortController();
    listGeneration.current++;
    setBrowserReports(null);
    setRepoReports([]);
    setNextCursor(null);
    setLoadingPage(!!issueScope);
    const warnings: string[] = [];
    setListWarning(issueScope ? "" : "This host does not support repo issues yet. Showing browser-only copies.");
    function warn(message: string) {
      warnings.push(message);
      if (active) setListWarning(warnings.join(" "));
    }
    readIssueReports(issueScope).then(
      (saved) => {
        if (active) setBrowserReports(saved);
      },
      () => {
        if (active) setBrowserReports([]);
        warn("Browser storage is unavailable; browser-only copies could not be loaded.");
      },
    );
    if (issueScope) readRepoIssuePage(issueScope, undefined, controller.signal).then(
      (page) => {
        if (!active) return;
        setRepoReports(page.items);
        setNextCursor(page.nextCursor);
      },
      () => warn("Repo issues are unavailable. Any browser copies are shown below; try reopening Saved issues."),
    ).finally(() => { if (active) setLoadingPage(false); });
    return () => {
      active = false;
      listGeneration.current++;
      action.current++;
      controller.abort();
      openingRequest.current?.abort();
    };
  }, [draft, issueScope]);

  useEffect(() => {
    setScreenshotUrl("");
    if (!report) return;
    const url = URL.createObjectURL(report.screenshot);
    setScreenshotUrl(url);
    input.current?.focus();
    return () => URL.revokeObjectURL(url);
  }, [report?.screenshot]);

  function requestClose(next: () => void) {
    if (savingRef.current) return;
    const proceed = () => {
      action.current++;
      openingRequest.current?.abort();
      setOpening("");
      next();
    };
    if (prompt === persistedPrompt || !prompt.trim()) proceed();
    else setDiscardAction(() => proceed);
  }

  async function openReport(saved: IssueListEntry) {
    const attempt = ++action.current;
    const scope = issueScope;
    openingRequest.current?.abort();
    const controller = new AbortController();
    openingRequest.current = controller;
    setOpening(`${saved.storage}:${saved.id}`);
    setError("");
    try {
      const loaded = saved.storage === "repo" && scope
        ? await readRepoIssueReport(saved.id, scope, controller.signal)
        : await readBrowserIssueReport(saved.id, scope);
      if (attempt !== action.current || currentScope.current !== scope) return;
      setReport(loaded);
      setPrompt(loaded.prompt);
      setPersistedPrompt(loaded.prompt);
    } catch (cause) {
      if (attempt === action.current && currentScope.current === scope) setError(cause instanceof Error ? cause.message : "Could not open this issue. Try again.");
    } finally {
      if (attempt === action.current && currentScope.current === scope) setOpening("");
    }
  }

  async function loadMore() {
    if (!issueScope || !nextCursor || loadingPage) return;
    const generation = listGeneration.current;
    setLoadingPage(true);
    try {
      const page = await readRepoIssuePage(issueScope, nextCursor);
      if (generation !== listGeneration.current) return;
      setRepoReports(previous => [...previous, ...page.items.filter(item => !previous.some(saved => saved.id === item.id))]);
      setNextCursor(page.nextCursor);
      setListWarning("");
    } catch {
      if (generation === listGeneration.current) setListWarning("Could not load more repo issues. Loaded issues and browser copies are still available.");
    } finally {
      if (generation === listGeneration.current) setLoadingPage(false);
    }
  }

  async function save() {
    if (!report || savingRef.current || !prompt.trim()) return;
    const attempt = ++action.current;
    const scope = issueScope;
    const active = () => attempt === action.current && currentScope.current === scope;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      if (!report.scope) {
        await saveIssueReport({ ...report, prompt: prompt.trim(), updatedAt: new Date().toISOString() });
        if (active()) onSaved("browser");
        return;
      }
      if (report.scope !== scope) throw new Error("This capture belongs to another host context. It cannot be saved to this repo.");
      const pending = prepareIssueAttempt(report, prompt);
      setReport(pending);
      setPrompt(pending.prompt);
      let browserCopy = false;
      try {
        await saveIssueReport(pending);
        browserCopy = true;
        if (active()) {
          setPersistedPrompt(pending.prompt);
          setBrowserReports(previous => [{
            id: pending.id, scope: pending.scope, prompt: pending.prompt,
            title: pending.title, url: pending.url,
            capturedAt: pending.capturedAt, updatedAt: pending.updatedAt,
            viewport: pending.viewport, storage: "browser", pending: true,
          }, ...(previous || []).filter(saved => saved.id !== pending.id)]);
        }
      } catch { /* A full browser must not prevent a durable repo save. */ }
      try {
        if (currentScope.current !== scope) throw new Error("This capture belongs to another host context.");
        await writeRepoIssueReport(pending, scope);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : "Could not save to the repo.";
        const retry = cause instanceof IssueRequestError && cause.status === 412 ? "" : " Retry Save to repo.";
        throw new Error(`${reason} ${browserCopy
          ? `Pending: your description and screenshot are saved in this browser.${retry}`
          : "No browser copy could be saved. Your description and screenshot are still in this form; keep it open and retry."}`);
      }
      // Host acknowledgement is authoritative. A cleanup failure can leave a
      // redundant browser copy, but it cannot undo the durable repo save.
      await removeIssueAttempt(pending.id, scope, pending.pending!.token).catch(() => {});
      if (active()) onSaved("repo");
    } catch (cause) {
      if (active()) setError(cause instanceof Error ? cause.message : "Could not save this issue. Your description and screenshot are still here; try again.");
    } finally {
      if (active()) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  const reports = [...(browserReports || []), ...repoReports].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const differentScope = !!report?.scope && report.scope !== issueScope;

  return (
    <div data-issue-ui>
      <Modal
        label={report ? "Report an issue" : "Saved issues"}
        className="issue-reporter"
        onClose={() => {
          requestClose(onClose);
        }}
      >
        <header className="issue-header">
          {report && !draft && (
            <IconButton
              name="Back"
              title="Back to saved issues"
              onClick={() => {
                requestClose(() => {
                  setReport(null);
                  setPrompt("");
                  setError("");
                });
              }}
            />
          )}
          <h2>{report ? "Report an issue" : "Saved issues"}</h2>
          <IconButton
            name="Close"
            title="Close issue reports"
            disabled={saving}
            onClick={() => {
              requestClose(onClose);
            }}
          />
        </header>
        {discardAction && (
          <div className="issue-discard" role="group" aria-label="Unsaved issue report">
            <span>Discard the unsaved changes to this report?</span>
            <button type="button" className="text-button" onClick={() => setDiscardAction(null)}>Keep editing</button>
            <button type="button" className="primary-button" onClick={() => { const action = discardAction; setDiscardAction(null); action(); }}>Discard changes</button>
          </div>
        )}
        {report ? (
          <form
            className="issue-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="issue-body">
              <figure className="issue-screenshot">
                {screenshotUrl && (
                  <a
                    href={screenshotUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open attached screenshot"
                  >
                    <img
                      src={screenshotUrl}
                      alt="Attached screenshot of the page before opening this issue report"
                    />
                  </a>
                )}
                <figcaption>
                  <span>
                    <Icon name="Paperclip" size={14} /> Screenshot attached
                  </span>
                  <a
                    href={screenshotUrl || undefined}
                    download={`superlocal-issue-${report.id}.${report.screenshot.type === "image/jpeg" ? "jpg" : "png"}`}
                  >
                    Download
                  </a>
                </figcaption>
              </figure>
              <label className="issue-description">
                Describe the issue
                <textarea
                  ref={input}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={5}
                  maxLength={ISSUE_LIMITS.promptCharacters}
                  required
                  disabled={saving}
                  placeholder="What happened, and what should happen instead?"
                />
              </label>
              <p className="issue-context" title={report.url}>
                {report.title}{" "}
                <span>
                  {report.viewport.width} x {report.viewport.height}
                </span>
              </p>
              <details className="issue-logs">
                <summary>Browser logs ({report.logs?.length || 0})</summary>
                <pre>
                  {report.logs?.length
                    ? report.logs
                        .map(
                          (entry) =>
                            `${entry.time} [${entry.level}] ${entry.message}`,
                        )
                        .join("\n")
                    : report.logs
                      ? "No browser logs were recorded before this capture."
                      : "This older report has no browser logs."}
                </pre>
              </details>
              {error && (
                <p className="issue-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer className="issue-footer">
              <span>{differentScope
                ? "This capture belongs to another host context."
                : !report.scope
                  ? "Browser-only. This capture stays in this browser."
                  : report.pending
                    ? "Pending repo save."
                    : "Saves to ignored data/issues in this repo."}</span>
              <button
                className="primary-button"
                type="submit"
                disabled={saving || !prompt.trim() || differentScope}
              >
                {saving ? "Saving..." : report.scope ? "Save to repo" : "Save in browser"}
              </button>
            </footer>
          </form>
        ) : (
          <div className="issue-list">
            {listWarning && <p className="issue-error" role="status">{listWarning}</p>}
            {error && (
              <p className="issue-error" role="alert">
                {error}
              </p>
            )}
            {opening && <p role="status">Opening issue...</p>}
            {browserReports === null || loadingPage ? (
              <p role="status">Loading saved issues...</p>
            ) : reports.length === 0 && !listWarning ? (
              <p>No saved issues yet. Use the Issue command to capture one.</p>
            ) : null}
            {reports.map((saved) => (
                <button
                  className="issue-list-row"
                  key={`${saved.storage}:${saved.id}`}
                  onClick={() => { void openReport(saved); }}
                >
                  <strong>{saved.prompt.split("\n")[0]}</strong>
                  <span>{saved.title} · {saved.storage === "repo" ? "Saved in repo" : saved.pending ? "Pending · Browser-only" : "Browser-only"}</span>
                  <time dateTime={saved.capturedAt}>
                    {new Date(saved.capturedAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                </button>
              ))}
            {nextCursor && <button type="button" className="text-button" disabled={loadingPage} onClick={() => { void loadMore(); }}>Load more</button>}
          </div>
        )}
      </Modal>
    </div>
  );
}
