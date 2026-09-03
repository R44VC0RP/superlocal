import type { Database } from 'bun:sqlite'
import { InboxError, type Inbox, type MailboxMembership, type MailboxStateTarget } from 'inbox-sdk'
import { classifyAttention } from '../../shared/mail-attention'
import { object } from './config'

type Target = MailboxStateTarget & { sourceId: string; messageRevision: number }
type Feedback = {
  version: 1; label: 'not-important-to-me';
  id: string; createdAt: string; status: 'pending' | 'active' | 'retracting' | 'retracted' | 'failed';
  targets: Target[]; context: Array<{ sourceId: string; messageId: string; threadId: string; revision: number; decision: ReturnType<typeof classifyAttention> }>;
  retractedAt?: string; problem?: string;
  states?: MailboxMembership[];
}
const publicEvent = (event: Feedback, command = false) => ({ id: event.id, createdAt: event.createdAt, status: event.status,
  count: event.context.length, ...(event.retractedAt ? { retractedAt: event.retractedAt } : {}), ...(event.problem ? { problem: event.problem } : {}),
  ...(command && event.states ? { states: event.states } : {}) })
const definitive = (error: unknown) => error instanceof InboxError && error.status >= 400 && error.status < 500

/** Collection only. Nothing in categorization reads this ledger. SDK owns the local state transaction. */
export function createAttentionFeedbackStore(database: Database, inbox: Inbox, owner: string) {
  database.exec('CREATE TABLE IF NOT EXISTS local_attention_feedback (owner TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,id)) STRICT')
  const read = (id: string): Feedback | undefined => {
    const row = database.query<{ data: string }, [string, string]>('SELECT data FROM local_attention_feedback WHERE owner=? AND id=?').get(owner, id)
    return row ? JSON.parse(row.data) : undefined
  }
  const save = (event: Feedback) => database.query('UPDATE local_attention_feedback SET data=? WHERE owner=? AND id=?').run(JSON.stringify(event), owner, event.id)
  let queue = Promise.resolve()
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const task = queue.then(work); queue = task.then(() => {}, () => {}); return task
  }
  async function settle(event: Feedback): Promise<Feedback> {
    if (event.status === 'pending') {
      try {
        const receipt = await inbox.setMailboxStates(owner, { id: `attention:${event.id}`, targets: event.targets.map(({ mailboxId, messageId, revision, messageRevision }) => ({ mailboxId, messageId, revision, messageRevision })), done: true })
        event.states = receipt.states
        event.status = receipt.retracted ? 'retracted' : 'active'; save(event)
      } catch (error) {
        if (definitive(error)) { event.status = 'failed'; event.problem = 'Mailbox state changed; no feedback was recorded.'; save(event) }
        throw error
      }
    }
    if (event.status === 'retracting') {
      try { event.states = (await inbox.undoMailboxStates(owner, `attention:${event.id}`)).states }
      catch (error) {
        if (!definitive(error)) throw error
        // A newer user action wins. The requested retraction still takes effect.
        delete event.states
        event.problem = 'Feedback retracted. Newer mailbox changes were not overwritten.'
      }
      event.status = 'retracted'; event.retractedAt = new Date().toISOString(); save(event)
    }
    return event
  }
  return {
    record(input: unknown) { return serialized(async () => {
      if (!object(input) || Object.keys(input).some(key => !['id', 'targets'].includes(key)) || typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.id) || !Array.isArray(input.targets) || !input.targets.length || input.targets.length > 500) throw new InboxError('HOST_FEEDBACK_INVALID', 'Provide an action ID and 1–500 message memberships.', 400)
      const targets: Target[] = input.targets.map(value => {
        if (!object(value) || Object.keys(value).sort().join(',') !== 'mailboxId,messageId,messageRevision,revision,sourceId' || !['mailboxId', 'messageId', 'sourceId'].every(key => typeof value[key] === 'string' && /^[^\s\x00-\x1f]{1,512}$/.test(value[key] as string)) || !['revision', 'messageRevision'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) > 0)) throw new InboxError('HOST_FEEDBACK_INVALID', 'Invalid message membership.', 400)
        return { sourceId: value.sourceId as string, mailboxId: value.mailboxId as string, messageId: value.messageId as string, revision: value.revision as number, messageRevision: value.messageRevision as number }
      }).sort((a, b) => a.mailboxId.localeCompare(b.mailboxId) || a.messageId.localeCompare(b.messageId))
      if (new Set(targets.map(target => `${target.mailboxId}\0${target.messageId}`)).size !== targets.length) throw new InboxError('HOST_FEEDBACK_INVALID', 'Duplicate membership.', 400)
      const previous = read(input.id)
      if (previous) {
        if (JSON.stringify(previous.targets) !== JSON.stringify(targets)) throw new InboxError('HOST_FEEDBACK_CONFLICT', 'This feedback ID already describes another selection.', 409)
        return publicEvent(await settle(previous), true)
      }
      const context = new Map<string, Feedback['context'][number]>()
      for (const target of targets) {
        const message = await inbox.mailboxMessage(owner, target.mailboxId, target.messageId)
        if (message.sourceId !== target.sourceId || message.revision !== target.messageRevision || message.memberships[0]?.revision !== target.revision) throw new InboxError('HOST_FEEDBACK_CONFLICT', 'Selected messages changed. Refresh before recording feedback.', 412)
        const membership = message.memberships[0]!
        if (message.folder === 'inbox' && !membership.done && (!membership.snoozedUntil || Date.parse(membership.snoozedUntil) <= Date.now())) {
          context.set(`${message.sourceId}\0${message.id}`, { sourceId: message.sourceId, messageId: message.id, threadId: message.threadId, revision: message.revision, decision: classifyAttention(message) })
        }
      }
      if (!context.size) throw new InboxError('HOST_FEEDBACK_INVALID', 'Select incoming inbox mail before recording attention feedback.', 400)
      const event: Feedback = { version: 1, label: 'not-important-to-me', id: input.id, createdAt: new Date().toISOString(), status: 'pending', targets, context: [...context.values()] }
      database.query('INSERT INTO local_attention_feedback VALUES (?,?,?)').run(owner, event.id, JSON.stringify(event))
      return publicEvent(await settle(event), true)
    }) },
    undo(id: string) { return serialized(async () => {
      let event = read(id)
      if (!event) throw new InboxError('HOST_FEEDBACK_NOT_FOUND', 'Feedback not found.', 404)
      event = await settle(event)
      if (event.status === 'active') { event.status = 'retracting'; save(event); await settle(event) }
      return publicEvent(event, true)
    }) },
    list() { return serialized(async () => {
      const rows = database.query<{ data: string }, [string]>(`SELECT data FROM local_attention_feedback WHERE owner=? AND json_extract(data,'$.status') IN ('pending','retracting') LIMIT 100`).all(owner)
      for (const row of rows) { try { await settle(JSON.parse(row.data)) } catch (error) { if (!definitive(error)) throw error } }
      return database.query<{ data: string }, [string]>(`SELECT data FROM local_attention_feedback WHERE owner=? ORDER BY json_extract(data,'$.createdAt') DESC LIMIT 20`).all(owner).map(row => publicEvent(JSON.parse(row.data)))
    }) },
  }
}
