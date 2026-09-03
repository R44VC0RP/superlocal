import type { ReactNode } from "react";
import { IconButton } from "./components";
import type { InboxIssue } from "./inbox";
import "./notices.css";

// Floating, non-modal notices for background problems. They never take part in
// the workspace layout, never take focus, and each problem keeps one slot.
const MAX_VISIBLE = 3;

type NoticeProps = {
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
  onDismiss: () => void;
  quiet?: boolean;
  data?: Record<string, string | number>;
};

export function Notice({ title, detail, action, onDismiss, quiet, data }: NoticeProps) {
  const attributes = Object.fromEntries(Object.entries(data ?? {}).map(([key, value]) => [`data-${key}`, value]));
  return (
    <div className={`notice ${quiet ? "notice-quiet" : ""}`} {...attributes}>
      <p className="notice-text">
        {title}
        {detail && <span className="notice-detail"> · {detail}</span>}
      </p>
      {action && (
        <button type="button" className="notice-action" onClick={action.onClick}>{action.label}</button>
      )}
      <IconButton name="Notification-closeIcon" title="Dismiss" size={10} className="notice-close" onClick={onDismiss} />
    </div>
  );
}

type Props = {
  issues: InboxIssue[];
  onRetry: (issue: InboxIssue) => void;
  onDismiss: (key: string) => void;
  children?: ReactNode;
};

export default function Notices({ issues, onRetry, onDismiss, children }: Props) {
  const visible = issues.filter(issue => !issue.dismissed).slice(-MAX_VISIBLE);
  return (
    <div className="notice-stack">
      {/* The live region is always mounted so a new problem is announced once; text of a repeated problem does not change. */}
      <div className="notice-list" role="status" aria-live="polite" aria-atomic="false">
        {visible.map(issue => (
          <Notice
            key={issue.key}
            title={issue.title}
            detail={issue.detail}
            action={issue.retry ? { label: "Retry", onClick: () => onRetry(issue) } : undefined}
            onDismiss={() => onDismiss(issue.key)}
            data={{ scope: issue.scope, code: issue.code, count: issue.count }}
          />
        ))}
      </div>
      {children}
    </div>
  );
}
