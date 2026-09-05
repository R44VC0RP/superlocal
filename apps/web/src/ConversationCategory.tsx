import { useState } from "react";
import { InboxClassificationError } from "./inbox";
import type { AttentionCategory } from "../../shared/attention-overrides";

export default function ConversationCategory({ category, onChange, disabled = false }: {
  category: AttentionCategory;
  disabled?: boolean;
  onChange: (category: AttentionCategory) => Promise<() => Promise<void>>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<(() => Promise<() => Promise<void>>) | null>(null);
  const [undo, setUndo] = useState<(() => Promise<void>) | null>(null);
  async function change(work: () => Promise<() => Promise<void>>) {
    if (busy || disabled) return;
    setBusy(true); setError("");
    try { const reverse = await work(); setUndo(() => reverse); setRetry(null); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "The category could not be confirmed.");
      setRetry(cause instanceof InboxClassificationError && cause.retry ? () => cause.retry! : null);
    } finally { setBusy(false); }
  }
  async function reverse() {
    if (!undo || busy || retry) return;
    setBusy(true); setError("");
    try { await undo(); setUndo(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Undo could not be confirmed."); }
    finally { setBusy(false); }
  }
  const opposite = category === "Other" ? "Important" : "Other";
  return <div className="conversation-category">
    <span>{category} · chosen by you</span>
    <button type="button" className="text-button" disabled={busy || disabled} onClick={() => void change(retry ?? (() => onChange(opposite)))}>
      {retry ? "Retry same decision" : `Move to ${opposite}`}
    </button>
    {undo && <button type="button" className="text-button" disabled={busy || disabled || !!retry} onClick={() => void reverse()}>Undo category change</button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
