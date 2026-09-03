import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { htmlToPlainText } from '../../../../packages/inbox-sdk/server/sdk/types'
import {
  labelingInstructions, preprocessingVersion, promptVersion, taxonomy, taxonomyVersion,
  classificationSchema, validateClassification, type Classification, type ClassificationInput,
} from './schema'

const checkout = resolve(import.meta.dir, '../../../..')
const eligible = "m.deleted=0 AND a.status='connected' AND m.generation=a.generation AND m.folder NOT IN ('sent','drafts','scheduled') AND m.native_id NOT LIKE 'submission:%'"
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const sourceFacts = ['listId', 'listUnsubscribe', 'listPost', 'bulk', 'automated', 'unsubscribeLink', 'reply']
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const participant = (value: unknown) => {
  const item = object(value)
  return [text(item.name), text(item.email)].filter(Boolean).join(' ').slice(0, 1000)
}
const participants = (value: unknown): string[] => Array.isArray(value) ? value.slice(0, 100).map(participant).filter(Boolean) : []

export function privateDirectory(path: string): string {
  const resolved = resolve(path)
  mkdirSync(resolved, { recursive: true, mode: 0o700 })
  const stat = lstatSync(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PRIVATE_DIRECTORY_REQUIRED')
  const actual = realpathSync(resolved), inside = relative(checkout, actual)
  if (!inside || inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) throw new Error('DATA_MUST_BE_OUTSIDE_CHECKOUT')
  if (process.getuid && stat.uid !== process.getuid()) throw new Error('PRIVATE_DIRECTORY_OWNER')
  if ((stat.mode & 0o077) !== 0) throw new Error('PRIVATE_DIRECTORY_MUST_BE_0700')
  return actual
}

export function openMailSource(path: string): Database {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('SOURCE_DATABASE_REQUIRED')
  const db = new Database(path, { readonly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;')
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name='sdk_messages' AND type='table'").get()) throw new Error('SDK_DATABASE_REQUIRED')
    return db
  } catch (error) { db.close(); throw error }
}

export function inventory(db: Database) {
  const total = db.query<{ messages: number; threads: number }, []>(`SELECT count(*) messages, count(DISTINCT m.account||':'||m.thread_id) threads FROM sdk_messages m JOIN sdk_accounts a ON a.id=m.account WHERE ${eligible}`).get()!
  const folders = db.query<{ folder: string; messages: number }, []>(`SELECT m.folder, count(*) messages FROM sdk_messages m JOIN sdk_accounts a ON a.id=m.account WHERE ${eligible} GROUP BY m.folder`).all()
  return { ...total, folders, sources: db.query<{ sources: number }, []>("SELECT count(*) sources FROM sdk_accounts WHERE status='connected'").get()!.sources }
}

type MailRow = { id: string; owner: string; account: string; thread_id: string; visible: string; body: string }
export type Example = { id: string; source: string; message: string; thread: string; input: ClassificationInput }
export type RunConfiguration = { model: string; endpoint: string; taxonomyVersion: string; promptVersion: string; preprocessingVersion: string; taxonomy: unknown; schema: unknown; instructions: string }
export function runConfiguration(model: string): RunConfiguration {
  return { model, endpoint: 'https://opencode.ai/inference/openai/v1/responses', taxonomyVersion, promptVersion, preprocessingVersion, taxonomy, schema: classificationSchema, instructions: labelingInstructions }
}

function snapshot(row: MailRow, origin: string) {
  const summary = object(JSON.parse(row.visible)), body = object(JSON.parse(row.body))
  const rawText = text(body.bodyText) || htmlToPlainText(text(body.bodyHtml))
  const normalized = rawText.replace(/\r\n?/g, '\n').replace(/\0/g, '')
  const bodyTruncated = normalized.length > 60_000
  const input: ClassificationInput = {
    subject: text(summary.subject).slice(0, 4000), from: participant(summary.from),
    to: participants(summary.to), cc: participants(summary.cc), receivedAt: text(summary.receivedAt),
    bodyText: bodyTruncated ? `${normalized.slice(0, 40_000)}\n[CONTENT OMITTED: INPUT LIMIT]\n${normalized.slice(-19_900)}` : normalized,
    bodyTruncated, facts: Object.fromEntries(sourceFacts.filter(key => typeof object(summary.facts)[key] === 'boolean').map(key => [key, summary.facts[key]])),
  }
  // Never include provider categories, read/star state, folder placement or personal feedback in model inputs.
  const original = { from: summary.from, to: summary.to, cc: summary.cc, subject: summary.subject, receivedAt: summary.receivedAt, body }
  const contentHash = digest(JSON.stringify([original, input])), id = digest(JSON.stringify([origin, row.owner, row.account, row.id, contentHash, preprocessingVersion]))
  return { id, origin, owner: row.owner, source: row.account, message: row.id, thread: row.thread_id, contentHash, input, original }
}

type JobRow = { example_id: string; input_json: string; source: string; message: string; thread: string; attempts: number }
type RunRow = { id: string; config_json: string; fingerprint: string; selection_json: string }

export function createDataset(path: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${path}${suffix}`
    if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error('PRIVATE_FILE_REQUIRED')
  }
  // A typo must never initialize tables in the live mail/host database or an unrelated file.
  if (existsSync(path)) {
    const existing = new Database(path, { readonly: true })
    try {
      if (!existing.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='classification_meta'").get()
        || existing.query<{ version: number }, []>('SELECT version FROM classification_meta WHERE id=1').get()?.version !== 1) throw new Error('CLASSIFICATION_DATABASE_REQUIRED')
    } finally { existing.close() }
  }
  privateDirectory(dirname(path))
  if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600))
  chmodSync(path, 0o600)
  const db = new Database(path)
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS classification_meta (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT OR IGNORE INTO classification_meta VALUES (1,1);
    CREATE TABLE IF NOT EXISTS examples (
      id TEXT PRIMARY KEY, origin TEXT NOT NULL, owner TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL,
      thread TEXT NOT NULL, content_hash TEXT NOT NULL, input_json TEXT NOT NULL, original_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, config_json TEXT NOT NULL, fingerprint TEXT NOT NULL, selection_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (
      run TEXT NOT NULL REFERENCES runs(id), example TEXT NOT NULL REFERENCES examples(id),
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
      result_json TEXT, error_code TEXT, PRIMARY KEY(run,example)
    );
    CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, run TEXT NOT NULL, example TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT, error_code TEXT);
    CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, run TEXT NOT NULL, example TEXT NOT NULL, classification_json TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(run,example) REFERENCES jobs(run,example));
    CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(run,status,lease_until);
    CREATE INDEX IF NOT EXISTS reviews_latest ON reviews(run,example,id DESC);
  `)
  const getRun = (id: string): RunRow => {
    const run = db.query<RunRow, [string]>('SELECT * FROM runs WHERE id=?').get(id)
    if (!run) throw new Error('RUN_NOT_FOUND')
    return run
  }
  return {
    close() { db.close() },
    prepare(source: Database, options: { run: string; model: string; seed: string; limit: number | 'all' }) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(options.run)) throw new Error('INVALID_RUN_ID')
      const config = runConfiguration(options.model), fingerprint = digest(JSON.stringify(config))
      if (db.query('SELECT 1 FROM runs WHERE id=?').get(options.run)) throw new Error('RUN_ALREADY_EXISTS_USE_RESUME')
      const origin = source.query<{ value: string }, []>("SELECT value FROM sdk_meta WHERE key='epoch'").get()?.value
      if (!origin) throw new Error('SOURCE_EPOCH_REQUIRED')
      return source.transaction(() => {
        const candidates = source.query<{ id: string }, []>(`SELECT m.id FROM sdk_messages m JOIN sdk_accounts a ON a.id=m.account WHERE ${eligible}`).all()
          .map(row => ({ id: row.id, rank: digest(`${options.seed}:${row.id}`) })).sort((a, b) => a.rank.localeCompare(b.rank))
        const selected = options.limit === 'all' ? candidates : candidates.slice(0, options.limit)
        const read = source.query<MailRow, [string]>('SELECT id,owner,account,thread_id,visible,body FROM sdk_messages WHERE id=?')
        return db.transaction(() => {
          db.query('INSERT INTO runs VALUES (?,?,?,?,?)').run(options.run, JSON.stringify(config), fingerprint, JSON.stringify({ origin, seed: options.seed, limit: options.limit, available: candidates.length, selected: selected.length }), new Date().toISOString())
          const save = db.query('INSERT OR IGNORE INTO examples VALUES (?,?,?,?,?,?,?,?,?)'), job = db.query('INSERT INTO jobs(run,example,status,result_json) VALUES (?,?,?,?)')
          const reusable = db.query<{ run: string; result_json: string }, [string, string]>("SELECT j.run,j.result_json FROM jobs j JOIN runs r ON r.id=j.run WHERE j.example=? AND j.status='completed' AND r.fingerprint=? ORDER BY r.created_at DESC LIMIT 1")
          let truncated = 0, empty = 0, reused = 0
          for (const item of selected) {
            const sample = snapshot(read.get(item.id)!, origin)
            save.run(sample.id, origin, sample.owner, sample.source, sample.message, sample.thread, sample.contentHash, JSON.stringify(sample.input), JSON.stringify(sample.original))
            const previous = reusable.get(sample.id, fingerprint)
            job.run(options.run, sample.id, previous ? 'completed' : 'pending', previous ? JSON.stringify({ ...JSON.parse(previous.result_json), reusedFromRun: previous.run }) : null)
            reused += Number(!!previous)
            truncated += Number(sample.input.bodyTruncated); empty += Number(!sample.input.bodyText.trim())
          }
          return { run: options.run, selected: selected.length, available: candidates.length, truncated, empty, reused }
        })()
      })()
    },
    configuration(id: string): RunConfiguration { return JSON.parse(getRun(id).config_json) },
    fork(from: string, run: string, model: string) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(run)) throw new Error('INVALID_RUN_ID')
      const previous = getRun(from), config = runConfiguration(model)
      if (JSON.parse(previous.config_json).preprocessingVersion !== config.preprocessingVersion) throw new Error('PREPROCESSING_CHANGED_PREPARE_NEW_SNAPSHOTS')
      if (db.query('SELECT 1 FROM runs WHERE id=?').get(run)) throw new Error('RUN_ALREADY_EXISTS_USE_RESUME')
      return db.transaction(() => {
        db.query('INSERT INTO runs VALUES (?,?,?,?,?)').run(run, JSON.stringify(config), digest(JSON.stringify(config)), JSON.stringify({ ...JSON.parse(previous.selection_json), forkedFrom: from }), new Date().toISOString())
        const result = db.query('INSERT INTO jobs(run,example) SELECT ?,example FROM jobs WHERE run=?').run(run, from)
        return { run, forkedFrom: from, selected: result.changes }
      })()
    },
    assertCurrent(id: string) {
      const run = getRun(id), config = JSON.parse(run.config_json) as RunConfiguration
      if (digest(JSON.stringify(runConfiguration(config.model))) !== run.fingerprint) throw new Error('RUN_VERSION_CHANGED_CREATE_NEW_RUN')
      return config
    },
    claim(run: string, maxAttempts = 3): (Example & { lease: string; attemptId: number; attempts: number }) | null {
      return db.transaction(() => {
        const now = Date.now()
        db.query("UPDATE jobs SET status='failed',error_code='ATTEMPT_LIMIT',lease=NULL WHERE run=? AND status='processing' AND lease_until<=? AND attempts>=?").run(run, now, maxAttempts)
        const row = db.query<JobRow, [string, number, number]>(`SELECT j.example example_id,e.input_json,e.source,e.message,e.thread,j.attempts FROM jobs j JOIN examples e ON e.id=j.example WHERE j.run=? AND j.attempts<? AND (j.status='pending' OR (j.status='processing' AND j.lease_until<=?)) ORDER BY j.example LIMIT 1`).get(run, maxAttempts, now)
        if (!row) return null
        const lease = randomUUID()
        db.query("UPDATE jobs SET status='processing',attempts=attempts+1,lease=?,lease_until=? WHERE run=? AND example=?").run(lease, now + 180_000, run, row.example_id)
        const record = db.query('INSERT INTO attempts(run,example,started_at) VALUES (?,?,?)').run(run, row.example_id, new Date().toISOString())
        return { id: row.example_id, input: JSON.parse(row.input_json), source: row.source, message: row.message, thread: row.thread, lease, attemptId: Number(record.lastInsertRowid), attempts: row.attempts + 1 }
      }).immediate()
    },
    finish(run: string, job: { id: string; lease: string; attemptId: number }, result: unknown) {
      return db.transaction(() => {
        const changed = db.query("UPDATE jobs SET status='completed',result_json=?,error_code=NULL,lease=NULL,lease_until=0 WHERE run=? AND example=? AND lease=? AND status='processing'").run(JSON.stringify(result), run, job.id, job.lease).changes
        if (!changed) throw new Error('JOB_LEASE_LOST')
        db.query("UPDATE attempts SET finished_at=?,outcome='completed' WHERE id=?").run(new Date().toISOString(), job.attemptId)
      })()
    },
    fail(run: string, job: { id: string; lease: string; attemptId: number }, code: string, retry: boolean, releaseAttempt = false) {
      const safeCode = /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'LABEL_FAILED'
      db.transaction(() => {
        db.query('UPDATE jobs SET status=?,error_code=?,lease=NULL,lease_until=0,attempts=max(0,attempts-?) WHERE run=? AND example=? AND lease=?').run(retry ? 'pending' : 'failed', safeCode, Number(releaseAttempt), run, job.id, job.lease)
        db.query("UPDATE attempts SET finished_at=?,outcome='failed',error_code=? WHERE id=?").run(new Date().toISOString(), safeCode, job.attemptId)
      })()
    },
    retryFailed(run: string) {
      this.assertCurrent(run)
      return db.query("UPDATE jobs SET status='pending',attempts=0,error_code=NULL WHERE run=? AND status='failed'").run(run).changes
    },
    status(run: string) {
      const info = getRun(run)
      const counts = Object.fromEntries(db.query<{ status: string; count: number }, [string]>('SELECT status,count(*) count FROM jobs WHERE run=? GROUP BY status').all(run).map(row => [row.status, row.count]))
      const categories = Object.fromEntries(db.query<{ label: string; count: number }, [string]>("SELECT json_extract(result_json,'$.classification.primaryType') label,count(*) count FROM jobs WHERE run=? AND status='completed' GROUP BY label").all(run).map(row => [row.label, row.count]))
      const errors = Object.fromEntries(db.query<{ error_code: string; count: number }, [string]>("SELECT error_code,count(*) count FROM jobs WHERE run=? AND status='failed' GROUP BY error_code").all(run).map(row => [row.error_code, row.count]))
      const usage = db.query<{ inputTokens: number; outputTokens: number }, [string]>("SELECT coalesce(sum(json_extract(result_json,'$.usage.inputTokens')),0) inputTokens,coalesce(sum(json_extract(result_json,'$.usage.outputTokens')),0) outputTokens FROM jobs WHERE run=? AND status='completed'").get(run)!
      const reviewed = db.query<{ count: number }, [string]>('SELECT count(DISTINCT example) count FROM reviews WHERE run=?').get(run)!.count
      return { run, configuration: { model: JSON.parse(info.config_json).model, taxonomyVersion: JSON.parse(info.config_json).taxonomyVersion }, selection: JSON.parse(info.selection_json), counts, categories, errors, usage, reviewed }
    },
    compare(left: string, right: string) {
      getRun(left); getRun(right)
      const rows = db.query<{ old: string; fresh: string }, [string, string]>("SELECT a.result_json old,b.result_json fresh FROM jobs a JOIN jobs b ON b.example=a.example WHERE a.run=? AND b.run=? AND a.status='completed' AND b.status='completed'").all(left, right)
      const changes: Record<string, number> = {}
      for (const row of rows) {
        const a = JSON.parse(row.old).classification, b = JSON.parse(row.fresh).classification
        for (const key of ['primaryType', 'secondaryTypes', 'actions', 'timeSensitivity', 'deadline', 'risk', 'certainty']) {
          const value = (x: any) => JSON.stringify(Array.isArray(x) ? [...x].sort() : x)
          if (value(a[key]) !== value(b[key])) changes[key] = (changes[key] ?? 0) + 1
        }
      }
      return { left, right, overlappingCompleted: rows.length, changes }
    },
    review(run: string, records: Array<{ exampleId: string; classification: unknown }>) {
      this.assertCurrent(run)
      return db.transaction(() => {
        for (const record of records) {
          const row = db.query<{ input_json: string }, [string, string]>('SELECT input_json FROM examples e JOIN jobs j ON j.example=e.id WHERE j.run=? AND e.id=?').get(run, record.exampleId)
          if (!row) throw new Error('REVIEW_EXAMPLE_NOT_FOUND')
          const label = validateClassification(record.classification, JSON.parse(row.input_json))
          db.query('INSERT INTO reviews(run,example,classification_json,created_at) VALUES (?,?,?,?)').run(run, record.exampleId, JSON.stringify(label), new Date().toISOString())
        }
        return { run, reviewed: records.length }
      })()
    },
    partition(run: string, developmentRuns: string[] = []) {
      getRun(run)
      if (developmentRuns.length > 20 || new Set(developmentRuns).size !== developmentRuns.length) throw new Error('INVALID_DEVELOPMENT_RUNS')
      const senderKey = (sender: string | null, fallback: string, id: string) => `sender:${digest((sender || fallback).trim().toLowerCase() || id)}`
      const developmentSenders = new Set<string>()
      for (const previous of developmentRuns) {
        getRun(previous)
        const senders = db.query<{ id: string; sender: string | null; fallback: string }, [string]>("SELECT e.id,json_extract(e.original_json,'$.from.email') sender,json_extract(e.input_json,'$.from') fallback FROM jobs j JOIN examples e ON e.id=j.example WHERE j.run=?").all(previous)
        for (const row of senders) developmentSenders.add(senderKey(row.sender, row.fallback, row.id))
      }
      // Labeling failures and model disagreements must never change the cohort's split assignment.
      const cohort = db.query<{ id: string; origin: string; source: string; thread: string; sender: string | null; input_json: string }, [string]>("SELECT e.id,e.origin,e.source,e.thread,json_extract(e.original_json,'$.from.email') sender,e.input_json FROM jobs j JOIN examples e ON e.id=j.example WHERE j.run=? ORDER BY e.id").all(run)
      const parents = new Map<string, string>(), senders = new Map<string, string>()
      const normalizeTemplate = (value: string) => value.normalize('NFKC').toLowerCase()
        .replace(/https?:\/\/\S+|www\.\S+|[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+/gu, ' ')
        .replace(/\p{N}+/gu, '0').replace(/\s+/g, ' ').trim()
      const find = (key: string): string => { const parent = parents.get(key); if (!parent) { parents.set(key, key); return key }; if (parent === key) return key; const root = find(parent); parents.set(key, root); return root }
      const unite = (a: string, b: string) => { const x = find(a), y = find(b); if (x !== y) parents.set(x < y ? y : x, x < y ? x : y) }
      for (const row of cohort) {
        const input: ClassificationInput = JSON.parse(row.input_json), sender = senderKey(row.sender, input.from, row.id)
        senders.set(row.id, sender)
        unite(sender, `thread:${row.origin}:${row.source}:${row.thread}`)
        unite(sender, `body:${digest(input.subject + '\n' + input.bodyText)}`)
        const template = normalizeTemplate(input.subject) + '\n' + normalizeTemplate(input.bodyText)
        if (template.length >= 80) unite(sender, `template:${digest(template)}`)
      }
      const anchors = new Map<string, string>(), exposed = new Set<string>()
      for (const sender of senders.values()) {
        const root = find(sender), anchor = anchors.get(root)
        if (!anchor || sender < anchor) anchors.set(root, sender)
        if (developmentSenders.has(sender)) exposed.add(root)
      }
      return cohort.map(row => {
        const root = find(senders.get(row.id)!), anchor = anchors.get(root)!, bucket = parseInt(digest(anchor).slice(0, 8), 16) % 100
        const split = exposed.has(root) || bucket < 80 ? 'train' : bucket < 90 ? 'validation' : 'test'
        return { exampleId: row.id, split, splitGroup: digest(anchor), developmentExposed: exposed.has(root) }
      })
    },
    export(run: string, directory: string, reviewedOnly = false, developmentRuns: string[] = []) {
      const config = JSON.parse(getRun(run).config_json) as RunConfiguration
      const root = privateDirectory(directory)
      const rows = db.query<{ id: string; source: string; message: string; content_hash: string; input_json: string; result_json: string; reviewed: string | null }, [string]>(`SELECT e.id,e.source,e.message,e.content_hash,e.input_json,j.result_json,(SELECT classification_json FROM reviews r WHERE r.run=j.run AND r.example=j.example ORDER BY r.id DESC LIMIT 1) reviewed FROM jobs j JOIN examples e ON e.id=j.example WHERE j.run=? AND j.status='completed' ORDER BY e.id`).all(run)
      const partition = new Map(this.partition(run, developmentRuns).map(row => [row.exampleId, row]))
      const descriptors = new Map<string, number>()
      let exported = 0, skipped = 0
      const counts: Record<string, number> = { train: 0, validation: 0, test: 0 }
      try {
        for (const name of ['train', 'validation', 'test', 'review']) descriptors.set(name, openSync(resolve(root, `${name}.jsonl`), 'wx', 0o600))
        for (const row of rows) {
          const input: ClassificationInput = JSON.parse(row.input_json), result = JSON.parse(row.result_json)
          const classification: Classification = row.reviewed ? JSON.parse(row.reviewed) : result.classification
          const labelSource = row.reviewed ? 'human' : 'llm'
          const example = { exampleId: row.id, sourceId: row.source, messageId: row.message, contentHash: row.content_hash, input, classification, labelSource, model: result.model, responseId: result.responseId }
          writeSync(descriptors.get('review')!, JSON.stringify(example) + '\n')
          if ((reviewedOnly && !row.reviewed) || (!row.reviewed && (input.bodyTruncated || classification.certainty !== 'clear'))) { skipped++; continue }
          const { split, splitGroup } = partition.get(row.id)!
          writeSync(descriptors.get(split)!, JSON.stringify({ ...example, splitGroup, messages: [{ role: 'system', content: config.instructions }, { role: 'user', content: JSON.stringify(input) }, { role: 'assistant', content: JSON.stringify(classification) }] }) + '\n')
          counts[split]++; exported++
        }
        const fd = openSync(resolve(root, 'manifest.json'), 'wx', 0o600)
        try { writeSync(fd, JSON.stringify({ version: 1, run, createdAt: new Date().toISOString(), config, exported, skipped, counts, reviewedOnly, developmentRuns, splitPolicyVersion: 3, labelQuality: 'LLM labels are not ground truth; held-out LLM labels measure imitation, not accuracy.', sourceFormat: 'Decoded SDK text/HTML snapshots; not original RFC822 MIME.', splitPolicy: 'All selected snapshots, including failed/unlabeled entries. Connected sender/thread/exact-text/normalized-template components anchored to sender; hash 80/10/10. Templates normalize whitespace, URLs, addresses and digits (minimum80characters). Components containing senders from development runs are training-only. Other near-duplicate campaigns still require review.' }, null, 2) + '\n') } finally { closeSync(fd) }
      } finally { for (const fd of descriptors.values()) closeSync(fd) }
      return { run, exported, skipped, counts, reviewExamples: rows.length, reviewedOnly }
    },
  }
}
