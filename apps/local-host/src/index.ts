import { LocalConfigurationError, loadLocalConfig, type LocalConfig } from './config'
import { createLocalHost } from './host'

export { createLocalHost } from './host'
export { loadLocalConfig, LocalConfigurationError, type LocalConfig } from './config'
export type { HostProvider, HostProviderRegistration, ConnectResult } from './providers'

export function reportStartupError(error: unknown): void {
  const code = error instanceof LocalConfigurationError ? error.code : (error as { code?: unknown } | null)?.code
  if (error instanceof LocalConfigurationError) console.error(`[${error.code}] ${error.message}`)
  else if (code === 'EADDRINUSE') console.error('[LOCAL_PORT_IN_USE] A configured port is already occupied. Stop only your own process or choose SUPERLOCAL_API_PORT / SUPERLOCAL_WEB_PORT.')
  else console.error('[LOCAL_START_FAILED] The local host could not start. Check its local configuration, private data directory and available ports. No keys or databases were reset.')
}

export async function startLocalServer(config: LocalConfig = loadLocalConfig()) {
  const host = await createLocalHost(config)
  try {
    const server = Bun.serve({ hostname: '127.0.0.1', port: config.backend.port, idleTimeout: 30, maxRequestBodySize: 27 * 1024 * 1024,
      fetch(request, server) {
        if (new URL(request.url).pathname === '/v1/events') server.timeout(request, 0)
        return host.fetch(request)
      } })
    host.start()
    let stopping: Promise<void> | undefined
    const close = () => stopping ??= (async () => {
      // Drain requests; closing the host aborts SSE and waits for SDK work before closing its stores.
      const force = setTimeout(() => { void server.stop(true) }, 5000)
      force.unref()
      try { await Promise.all([server.stop(), host.close()]) } finally { clearTimeout(force) }
    })()
    return { host, server, close }
  } catch (error) { await host.close(); throw error }
}

if (import.meta.main) {
  try {
    const service = await startLocalServer()
    const stop = () => { void service.close().catch(() => { console.error('[LOCAL_SHUTDOWN_FAILED] Local host shutdown failed.'); process.exitCode = 1 }) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    console.info(`Local ${service.host.config.mode} host: http://127.0.0.1:${service.server.port}`)
  } catch (error) { reportStartupError(error); process.exitCode = 1 }
}
