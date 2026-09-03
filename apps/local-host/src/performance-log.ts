import { constants } from 'node:fs'
import { lstat, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { PerformanceSample } from '../../shared/performance'

const FILE_LIMIT = 2 * 1024 * 1024
const PENDING_LIMIT = 256 * 1024
const BATCH_LIMIT = 8
const MINUTE_LIMIT = 1200

/** Best-effort, content-free diagnostics. Never await disk writes on an action path. */
export function createPerformanceLog(dataDir: string, mode: 'mock' | 'real') {
  const path = join(dataDir, 'performance.jsonl')
  const backup = `${path}.1`
  const queue: Array<{ text: string; bytes: number }> = []
  let pendingBytes = 0
  let writer: Promise<void> | undefined
  let closed = false
  let abandoned = false
  let failed = false
  let windowStart = performance.now()
  let accepted = 0

  async function drain(): Promise<void> {
    while (queue.length && !abandoned) {
      const batch = queue.shift()!
      try {
        const existing = await lstat(path).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        })
        if (existing && (!existing.isFile() || existing.nlink !== 1 || existing.size > FILE_LIMIT || process.getuid && existing.uid !== process.getuid())) throw new Error('Invalid diagnostic file')
        if (abandoned) return
        if (existing && existing.size + batch.bytes > FILE_LIMIT) {
          const previous = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW)
          try {
            const stat = await previous.stat()
            if (stat.ino !== existing.ino || stat.dev !== existing.dev || stat.nlink !== 1) throw new Error('Diagnostic file changed')
            await previous.chmod(0o600)
          } finally { await previous.close() }
          await rename(path, backup)
        }
        if (abandoned) return
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
        try {
          const stat = await file.stat()
          if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid() || stat.size + batch.bytes > FILE_LIMIT) throw new Error('Invalid diagnostic file')
          await file.chmod(0o600)
          if (!abandoned) await file.appendFile(batch.text, 'utf8')
        } finally { await file.close() }
      } finally { pendingBytes = Math.max(0, pendingBytes - batch.bytes) }
    }
  }

  function start(): void {
    if (writer) return
    writer = drain().catch(() => {
      // Logging must never create recursive logs or change mail request outcomes.
      failed = true; queue.length = 0; pendingBytes = 0
    }).finally(() => {
      writer = undefined
      if (queue.length && !failed && !abandoned) start()
    })
  }

  return {
    write(samples: readonly PerformanceSample[]): boolean {
      if (closed || failed || samples.length > 50) return false
      const now = performance.now()
      if (now - windowStart >= 60000) { windowStart = now; accepted = 0 }
      if (accepted + samples.length > MINUTE_LIMIT || queue.length + Number(!!writer) >= BATCH_LIMIT) return false
      const receivedAt = Date.now()
      const text = samples.map(sample => JSON.stringify({ ...sample, mode, receivedAt })).join('\n') + '\n'
      const bytes = Buffer.byteLength(text)
      if (bytes > FILE_LIMIT || pendingBytes + bytes > PENDING_LIMIT) return false
      accepted += samples.length
      pendingBytes += bytes
      queue.push({ text, bytes })
      start()
      return true
    },
    async close(): Promise<void> {
      closed = true
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([(async () => { while (writer) await writer })(), new Promise<void>(resolve => { timer = setTimeout(resolve, 500) })])
      } finally {
        clearTimeout(timer)
        abandoned = true; queue.length = 0; pendingBytes = 0
      }
    },
  }
}
