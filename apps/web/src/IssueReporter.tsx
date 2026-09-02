import { useEffect, useRef, useState } from "react";
import { Icon, IconButton, Modal } from "./components";
import {
  readIssueReports,
  saveIssueReport,
  type IssueReport,
} from "./issue-reports";
import "./issue-reporter.css";

export default function IssueReporter({
  draft,
  onClose,
  onSaved,
}: {
  draft: IssueReport | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [report, setReport] = useState(draft);
  const [prompt, setPrompt] = useState(draft?.prompt || "");
  const [reports, setReports] = useState<IssueReport[] | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (draft) return;
    let active = true;
    readIssueReports().then(
      (saved) => {
        if (active) setReports(saved);
      },
      () => {
        if (active)
          setError(
            "Could not load saved issues. Browser storage is unavailable.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [draft]);

  useEffect(() => {
    if (!report) return;
    const url = URL.createObjectURL(report.screenshot);
    setScreenshotUrl(url);
    input.current?.focus();
    return () => URL.revokeObjectURL(url);
  }, [report]);

  function requestClose(action: () => void) {
    if (saving) return;
    if (prompt === (report?.prompt || "") || !prompt.trim()) action();
    else setDiscardAction(() => action);
  }

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
            onSubmit={async (event) => {
              event.preventDefault();
              if (saving || !prompt.trim()) return;
              setSaving(true);
              setError("");
              try {
                await saveIssueReport({
                  ...report,
                  prompt: prompt.trim(),
                  updatedAt: new Date().toISOString(),
                });
                onSaved();
              } catch {
                setError(
                  "Could not save this issue. Your description and screenshot are still here; try again.",
                );
                setSaving(false);
              }
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
              <span>Stored in this browser. Nothing is sent.</span>
              <button
                className="primary-button"
                type="submit"
                disabled={saving || !prompt.trim()}
              >
                {saving ? "Saving..." : "Save locally"}
              </button>
            </footer>
          </form>
        ) : (
          <div className="issue-list">
            {error ? (
              <p className="issue-error" role="alert">
                {error}
              </p>
            ) : reports === null ? (
              <p role="status">Loading saved issues...</p>
            ) : reports.length === 0 ? (
              <p>No saved issues yet. Use the Issue command to capture one.</p>
            ) : (
              reports.map((saved) => (
                <button
                  className="issue-list-row"
                  key={saved.id}
                  onClick={() => {
                    setReport(saved);
                    setPrompt(saved.prompt);
                    setError("");
                  }}
                >
                  <strong>{saved.prompt.split("\n")[0]}</strong>
                  <span>{saved.title}</span>
                  <time dateTime={saved.capturedAt}>
                    {new Date(saved.capturedAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                </button>
              ))
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
