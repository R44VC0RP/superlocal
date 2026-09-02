import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { loadLocalConfig, ROOT_DIR } from '../apps/local-host/src/config'
import { reportStartupError, startLocalServer } from '../apps/local-host/src/index'

// The host runs here; Vite is the only direct child. No shell/watch supervisor or platform-specific service manager.
let service: Awaited<ReturnType<typeof startLocalServer>> | undefined
let web: ReturnType<typeof Bun.spawn> | undefined
let stopping: Promise<void> | undefined
let interrupted = false

function stop(code = 0): Promise<void> {
  interrupted = true
  return stopping ??= (async () => {
    process.exitCode = code
    const child = web
    try { child?.kill('SIGTERM') } catch { /* It may already have exited. */ }
    const force = setTimeout(() => { try { child?.kill('SIGKILL') } catch { /* Already exited. */ } }, 5000)
    force.unref()
    try { await Promise.all([child?.exited, service?.close()]) } finally { clearTimeout(force) }
  })()
}

const signal = () => { void stop().catch(() => { console.error('[LOCAL_SHUTDOWN_FAILED] Development shutdown failed.'); process.exitCode = 1 }) }
process.on('SIGINT', signal)
process.on('SIGTERM', signal)

try {
  const config = loadLocalConfig()
  const webDir = join(ROOT_DIR, 'apps', 'web')
  const require = createRequire(join(webDir, 'package.json'))
  const vite = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js')
  service = await startLocalServer(config)
  if (interrupted) await service.close()
  else {
    // Provider/client secrets and arbitrary VITE_* variables must not enter the frontend process.
    const env: Record<string, string> = {}
    for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'FORCE_COLOR', 'NO_COLOR']) {
      if (process.env[name] !== undefined) env[name] = process.env[name]!
    }
    Object.assign(env, { NODE_ENV: 'development', SUPERLOCAL_API_ORIGIN: `http://127.0.0.1:${service.server.port}`,
      SUPERLOCAL_WEB_PORT: String(config.web.port), SUPERLOCAL_WEB_ORIGIN: config.web.origin, SUPERLOCAL_CONFIG: config.configPath })
    web = Bun.spawn([process.execPath, '--no-env-file', vite, '--host', '127.0.0.1', '--port', String(config.web.port), '--strictPort'], {
      cwd: webDir, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
    })
    console.info(`Superlocal (${config.mode}): ${config.web.origin}\nConfiguration: ${config.configPath}\nCtrl-C stops the web server and drains the local SDK host.`)
    const code = await web.exited
    if (!stopping) await stop(code)
    else await stopping
  }
} catch (error) {
  reportStartupError(error)
  await stop(1).catch(() => {})
}
