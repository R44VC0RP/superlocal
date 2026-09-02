import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export function prepareDevelopmentEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  directory: string = process.cwd(),
): NodeJS.ProcessEnv {
  if (environment.NODE_ENV === 'production') {
    throw new Error('The development bootstrap refuses NODE_ENV=production; use bun run start instead')
  }

  const prepared: NodeJS.ProcessEnv = {
    ...environment,
    NODE_ENV: environment.NODE_ENV || 'development',
    PORT: environment.PORT || '8788',
  }
  const generated: Array<[string, string]> = []

  if (!prepared.INBOX_API_TOKEN?.trim()) {
    prepared.INBOX_API_TOKEN = randomBytes(32).toString('base64url')
    generated.push(['INBOX_API_TOKEN', prepared.INBOX_API_TOKEN])
  }

  if (!prepared.CREDENTIAL_ENCRYPTION_KEY?.trim()) {
    prepared.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64')
    generated.push(['CREDENTIAL_ENCRYPTION_KEY', prepared.CREDENTIAL_ENCRYPTION_KEY])
  }

  if (generated.length > 0) {
    const localEnvironmentPath = join(directory, '.env.local')
    const alreadyExists = existsSync(localEnvironmentPath)

    if (alreadyExists) chmodSync(localEnvironmentPath, 0o600)

    appendFileSync(
      localEnvironmentPath,
      `${alreadyExists ? '\n' : ''}# Automatically generated local development secrets.\n${
        generated.map(([name, value]) => `${name}=${value}`).join('\n')
      }\n`,
      { mode: 0o600 },
    )
  }

  return prepared
}

if (import.meta.main) {
  const environment = prepareDevelopmentEnvironment()
  const development = Bun.spawn({
    cmd: [process.execPath, '--watch', 'server/index.ts'],
    cwd: process.cwd(),
    env: environment,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (development.exitCode === null) development.kill(signal)
    })
  }

  process.exitCode = await development.exited
}
