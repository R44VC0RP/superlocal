import type { Database } from 'bun:sqlite'
import { InboxError, type Inbox, type MailboxStateTarget } from 'inbox-sdk'

/** Get me to zero, Superhuman-style: mark inbox conversations older than a cutoff as Done in one bulk action.
 * Reads the SDK directly (no frozen window capture), so it works while AI sorting or imports are running.
 * Done is the SDK-local membership state; nothing is deleted and no provider folder changes. */
export type ZeroSweepInput = { account: string; olderThanDays: number; keepUnread: boolean; keepStarred: boolean }
export type ZeroSweepPreview = { token: string; conversations: number; messages: number; cutoff: string; complete: boolean }
export type ZeroSweepRun = { id: string; account: string; at: string; cutoff: string; conversations: number; messages: number; skipped: number; undone: boolean; receipts: number }

const DAY = 86_400_000
const UNDO_WINDOW_MS = 7 * DAY
const PREVIEW_TTL_MS = 10 * 60_000
const BATCH = 500
const idOK = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{8,100}$/.test(value)
const fail = (code: string, status = 400): never => { throw new InboxError(code, 'The local host request could not be completed.', status) }

type Preview = { input: ZeroSweepInput; cutoff: string; conversations: Array<{ targets: MailboxStateTarget[]; messages: number }>; complete: boolean; expires: number }

export function createZeroSweepService({ database: db, inbox, owner }: { database: Database; inbox: Inbox; owner: string }) {
  db.exec(`CREATE TABLE IF NOT EXISTS local_zero_sweeps(owner TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, receipts TEXT NOT NULL, PRIMARY KEY(owner,id));
    CREATE INDEX IF NOT EXISTS local_zero_sweep_recent ON local_zero_sweeps(owner,at DESC)`)
  const previews = new Map<string, Preview>()

  function validate(input: unknown): ZeroSweepInput {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('HOST_INVALID_INPUT')
    const value = input as Record<string, unknown>
    if (Object.keys(value).some(key => !['account', 'olderThanDays', 'keepUnread', 'keepStarred'].includes(key)) || typeof value.account !== 'string' || !value.account || value.account.length > 128
      || !Number.isInteger(value.olderThanDays) || (value.olderThanDays as number) < 0 || (value.olderThanDays as number) > 3650
      || typeof value.keepUnread !== 'boolean' || typeof value.keepStarred !== 'boolean') fail('HOST_INVALID_INPUT')
    return value as ZeroSweepInput
  }
  async function mailboxIds(account: string): Promise<string[]> {
    const boxes = (await inbox.mailboxes(owner)).filter(box => box.status === 'active')
    const ids = account === 'unified' ? boxes.map(box => box.id) : boxes.filter(box => box.id === account).map(box => box.id)
    if (!ids.length) fail('HOST_INBOX_SCOPE_CHANGED', 409)
    return ids
  }
  function run(id: string): ZeroSweepRun | null {
    const row = db.query<{ data: string }, [string, string]>('SELECT data FROM local_zero_sweeps WHERE owner=? AND id=?').get(owner, id)
    return row ? JSON.parse(row.data) : null
  }

  return {
    /** Enumerate matching conversations newest-first and hold their conditional targets for a bounded time. */
    async preview(raw: unknown): Promise<ZeroSweepPreview> {
      const input = validate(raw)
      const boxes = await mailboxIds(input.account)
      const cutoff = new Date(Date.now() - input.olderThanDays * DAY).toISOString()
      const conversations: Preview['conversations'] = []
      let cursor: string | undefined, complete = false, pages = 0
      for (;;) {
        const page = await inbox.mailboxConversations(owner, { mailboxIds: boxes, limit: 100, query: { folder: 'inbox', done: false, snoozed: false, before: cutoff }, ...(cursor ? { cursor } : {}) })
        for (const item of page.items) {
          if (!item.awakeInboxMessageCount || item.lastMessageAt >= cutoff) continue
          if (input.keepUnread && !item.isRead || input.keepStarred && item.isStarred) continue
          if (!item.targets.length) continue
          conversations.push({ targets: item.targets, messages: item.messageCount })
        }
        cursor = page.nextCursor ?? undefined; pages++
        if (!cursor) { complete = true; break }
        if (pages >= 500 || conversations.length >= 20_000) break // Bounded: a second run picks up the rest.
      }
      for (const [key, value] of previews) if (value.expires <= Date.now()) previews.delete(key)
      if (previews.size >= 8) previews.delete(previews.keys().next().value!)
      const token = crypto.randomUUID()
      previews.set(token, { input, cutoff, conversations, complete, expires: Date.now() + PREVIEW_TTL_MS })
      return { token, conversations: conversations.length, messages: conversations.reduce((sum, item) => sum + item.messages, 0), cutoff, complete }
    },
    /** Apply the previewed sweep in atomic batches. Conversations whose state changed since the preview are skipped, never forced. */
    async apply(raw: unknown): Promise<ZeroSweepRun> {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['token', 'id'].includes(key))) fail('HOST_INVALID_INPUT')
      const { token, id } = raw as { token?: unknown; id?: unknown }
      if (!idOK(id) || typeof token !== 'string') return fail('HOST_INVALID_INPUT')
      const existing = run(id)
      if (existing) return existing
      const preview = previews.get(token)
      if (!preview || preview.expires <= Date.now()) return fail('HOST_ZERO_PREVIEW_EXPIRED', 409)
      previews.delete(token)
      const receipts: string[] = []
      let conversations = 0, messages = 0, skipped = 0
      // Batches are grouped by whole conversation so a partial failure never leaves a thread half Done.
      let batch: Preview['conversations'] = [], size = 0
      const flush = async () => {
        if (!batch.length) return
        const targets = batch.flatMap(item => item.targets)
        const receiptId = `${id}:${receipts.length + 1}`
        try {
          await inbox.setMailboxStates(owner, { id: receiptId, targets, done: true })
          receipts.push(receiptId); conversations += batch.length; messages += batch.reduce((sum, item) => sum + item.messages, 0)
        } catch (error) {
          if (!(error instanceof InboxError) || error.status !== 412) throw error
          // A changed revision fails the whole batch; retry each conversation alone so one edited thread does not block the rest.
          for (const item of batch) {
            const single = `${id}:${receipts.length + 1}`
            try { await inbox.setMailboxStates(owner, { id: single, targets: item.targets, done: true }); receipts.push(single); conversations++; messages += item.messages }
            catch (inner) { if (!(inner instanceof InboxError) || inner.status !== 412) throw inner; skipped++ }
          }
        }
        batch = []; size = 0
      }
      for (const item of preview.conversations) {
        if (size + item.targets.length > BATCH) await flush()
        batch.push(item); size += item.targets.length
      }
      await flush()
      const value: ZeroSweepRun = { id, account: preview.input.account, at: new Date().toISOString(), cutoff: preview.cutoff, conversations, messages, skipped, undone: false, receipts: receipts.length }
      db.query('INSERT INTO local_zero_sweeps(owner,id,at,data,receipts) VALUES (?,?,?,?,?)').run(owner, id, Date.now(), JSON.stringify(value), JSON.stringify(receipts))
      db.query('DELETE FROM local_zero_sweeps WHERE owner=? AND at<?').run(owner, Date.now() - 30 * DAY)
      return value
    },
    /** Undo every receipt of a run within the undo window. Conversations acted on since keep their newer state (the SDK refuses those). */
    async undo(raw: unknown): Promise<ZeroSweepRun> {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).join(',') !== 'id' || !idOK((raw as { id: unknown }).id)) fail('HOST_INVALID_INPUT')
      const { id } = raw as { id: string }
      const row = db.query<{ data: string; receipts: string; at: number }, [string, string]>('SELECT data,receipts,at FROM local_zero_sweeps WHERE owner=? AND id=?').get(owner, id)
      if (!row) return fail('HOST_NOT_FOUND', 404)
      const value: ZeroSweepRun = JSON.parse(row.data)
      if (value.undone) return value
      if (Date.now() - row.at > UNDO_WINDOW_MS) fail('HOST_ZERO_UNDO_EXPIRED', 409)
      for (const receipt of JSON.parse(row.receipts) as string[]) {
        try { await inbox.undoMailboxStates(owner, receipt) }
        catch (error) { if (!(error instanceof InboxError) || ![404, 409, 412].includes(error.status)) throw error }
      }
      const next = { ...value, undone: true }
      db.query('UPDATE local_zero_sweeps SET data=? WHERE owner=? AND id=?').run(JSON.stringify(next), owner, id)
      return next
    },
    /** Recent runs, newest first, for the undo affordance. */
    recent(): ZeroSweepRun[] {
      return db.query<{ data: string }, [string, number]>('SELECT data FROM local_zero_sweeps WHERE owner=? AND at>? ORDER BY at DESC LIMIT 5').all(owner, Date.now() - UNDO_WINDOW_MS).map(row => JSON.parse(row.data))
    },
  }
}
