import { Database } from 'bun:sqlite'

// Private, parameterized read protocol. No SDK initialization, credentials or providers in this VM.
const READ_BYTES = 4 * 1024 * 1024
let database: Database | undefined
let filename: string | undefined

function stop(failed = false, id?: number): never {
  try { database?.close() } catch { failed = true }
  database = undefined
  postMessage(failed ? { type: 'error', id } : { type: 'closed' })
  process.exit(failed ? 1 : 0)
}

self.onmessage = ({ data }: MessageEvent) => {
  if (data?.type === 'close') stop()
  const id = data?.id
  try {
    if (!data || data.type !== 'read' || !Number.isSafeInteger(id) || id < 1
      || typeof data.filename !== 'string' || !data.filename || data.filename === ':memory:'
      || typeof data.owner !== 'string' || !data.owner.trim()
      || typeof data.sql !== 'string' || !/^\s*(?:WITH|SELECT)\b/i.test(data.sql) || data.sql.includes(';')
      || !Array.isArray(data.params) || data.params.some((value: unknown) => typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)))
      || Buffer.byteLength(JSON.stringify(data)) > READ_BYTES) throw new Error('Invalid read')
    if (!database) {
      database = new Database(data.filename, { readonly: true })
      filename = data.filename
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000')
    }
    if (filename !== data.filename) throw new Error('Changed read store')
    const db = database
    const result = db.transaction(() => {
      const row = db.query(data.sql).get(...data.params)
      const seq = db.query<{ seq: number }, [string]>('SELECT seq FROM sdk_states WHERE owner=?').get(data.owner)?.seq ?? 0
      const epoch = db.query<{ value: string }, []>("SELECT value FROM sdk_meta WHERE key='epoch'").get()?.value
      return { type: 'result', id, row, seq, epoch }
    }).deferred()
    if (Buffer.byteLength(JSON.stringify(result)) > READ_BYTES) throw new Error('Read result too large')
    postMessage(result)
  } catch {
    // Never forward SQLite errors, bindings, source excerpts or file paths through the error channel.
    stop(true, Number.isSafeInteger(id) ? id : undefined)
  }
}
