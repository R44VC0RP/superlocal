import type { InboxSelection, InboxWindowRow } from "../../shared/inbox-window";
import type { InboxStore, InboxCommandRecovery, InboxUndo } from "./inbox";

/** A frozen Important selection, consumed in bounded pages through existing Done receipts. */
export class ImportantDoneRun {
  selection: InboxSelection | null = null;
  completed = 0;
  changed = 0;
  finished = false;
  private cursor: string | undefined;
  private pending: InboxCommandRecovery | undefined;
  private pendingNext: string | null = null;
  private pendingExhausted = false;
  private undoSteps: InboxUndo[] = [];
  private running = false;
  private queryId: string | undefined;
  private readonly selectionId = crypto.randomUUID();
  private store: Pick<InboxStore, "windowTransport" | "action" | "replayCommand">;
  readonly account: string;
  constructor(store: Pick<InboxStore, "windowTransport" | "action" | "replayCommand">, account: string) { this.store = store; this.account = account; }
  async prepare() {
    if (!this.selection) {
      if (!this.queryId) {
        const view = await this.store.windowTransport.query({ account: this.account, folder: "Inbox", split: "Important", search: false, query: "", filter: null, limit: 1 });
        this.queryId = view.state.queryId;
      }
      try {
        this.selection = await this.store.windowTransport.selectionCreate({ id: this.selectionId, account: this.account, queryId: this.queryId, allMatching: true });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "HOST_INBOX_PREPARING") return false;
        throw error;
      }
    }
    if (!this.selection.captureComplete) {
      const page = await this.store.windowTransport.selectionPage({ selectionId: this.selection.id, limit: 1 });
      this.selection = page.selection;
    }
    return this.selection.captureComplete && this.selection.count !== null;
  }
  async run(update: () => void) {
    if (this.running) return;
    if (!this.selection?.captureComplete || this.selection.count === null) throw new Error("Important is still being captured. No mail was changed.");
    this.running = true;
    const sink = (plan: InboxCommandRecovery) => { this.pending = plan; };
    try {
      while (!this.finished) {
        let undo: InboxUndo;
        if (this.pending) {
          undo = await this.store.replayCommand(this.pending, sink);
        } else {
          const page = await this.store.windowTransport.selectionPage({ selectionId: this.selection.id, cursor: this.cursor, limit: 1 });
          if (!page.selection.captureComplete) throw new Error("The captured selection is not ready. No further mail was changed.");
          if (!page.exhausted && (!page.nextCursor || page.nextCursor === this.cursor)) throw new Error("The captured page made no progress. No further mail was changed.");
          const entry = page.entries[0];
          if (entry?.status === "unknown") throw new Error("A captured conversation is still being checked. No further mail was changed.");
          if (!entry || entry.status !== "found") {
            if (!entry && !page.exhausted) throw new Error("The captured page made no progress. No further mail was changed.");
            if (entry) this.changed++;
            this.advance(page.nextCursor, page.exhausted); update(); continue;
          }
          const row: InboxWindowRow = entry.row;
          this.pendingNext = page.nextCursor; this.pendingExhausted = page.exhausted;
          // Use the original captured membership revisions, never the current live query.
          undo = await this.store.action([{ ...row.mail, window: {
            counts: row.counts, messagesComplete: row.messagesComplete, targets: row.targets,
            targetsComplete: row.targetsComplete, actionContextComplete: row.actionContextComplete, contextVersion: row.contextVersion,
          } }], "done", undefined, sink);
        }
        this.undoSteps.push(undo); this.completed++; this.pending = undefined;
        this.advance(this.pendingNext, this.pendingExhausted); update();
      }
    } finally { this.running = false; }
  }
  private advance(next: string | null, exhausted: boolean) {
    if (!exhausted && (!next || next === this.cursor)) throw new Error("The captured page made no progress. No further mail was changed.");
    this.cursor = next ?? undefined; this.finished = exhausted;
  }
  get hasChanges() { return this.completed > 0 || !!this.pending; }
  async undo() {
    if (this.running) throw new Error("Wait for the current Done request before Undo.");
    if (this.pending) {
      if (this.pending.kind === "mailbox-state" && this.pending.status === "rejected") this.pending = undefined;
      else {
        const undo = await this.store.replayCommand(this.pending, plan => { this.pending = plan; });
        this.undoSteps.push(undo); this.completed++; this.pending = undefined;
      }
    }
    while (this.undoSteps.length) {
      await this.undoSteps[this.undoSteps.length - 1]();
      this.undoSteps.pop(); this.completed--;
    }
  }
}
