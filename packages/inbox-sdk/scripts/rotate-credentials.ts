import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { createCredentialCrypto } from '../server/crypto'

type AccountCredential = {
  id: string
  user_id: string
  credentials_encrypted: string
}

function rotateCredentials(): void {
  const arguments_ = process.argv.slice(2)

  if (
    arguments_.some((argument) => argument !== '--dry-run' && argument !== '--verify') ||
    new Set(arguments_).size !== arguments_.length ||
    arguments_.length > 1
  ) {
    throw new Error('Usage: bun run scripts/rotate-credentials.ts [--dry-run | --verify]')
  }

  const oldKey = process.env.CREDENTIAL_ENCRYPTION_OLD_KEY?.trim()
  const newKey = process.env.CREDENTIAL_ENCRYPTION_NEW_KEY?.trim()

  if (!oldKey || !newKey) {
    throw new Error('CREDENTIAL_ENCRYPTION_OLD_KEY and CREDENTIAL_ENCRYPTION_NEW_KEY are required')
  }

  const oldCrypto = createCredentialCrypto({
    NODE_ENV: 'production',
    CREDENTIAL_ENCRYPTION_KEY: oldKey,
    ...(process.env.CREDENTIAL_ENCRYPTION_OLD_KEY_ID
      ? { CREDENTIAL_ENCRYPTION_KEY_ID: process.env.CREDENTIAL_ENCRYPTION_OLD_KEY_ID }
      : {}),
  })
  const newCrypto = createCredentialCrypto({
    NODE_ENV: 'production',
    CREDENTIAL_ENCRYPTION_KEY: newKey,
    ...(process.env.CREDENTIAL_ENCRYPTION_NEW_KEY_ID
      ? { CREDENTIAL_ENCRYPTION_KEY_ID: process.env.CREDENTIAL_ENCRYPTION_NEW_KEY_ID }
      : {}),
  })

  if (oldCrypto.keyId === newCrypto.keyId) {
    throw new Error('Old and new credential encryption keys must have distinct key IDs')
  }

  let previousKeys: Record<string, unknown> = {}

  if (process.env.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS?.trim()) {
    try {
      const parsed: unknown = JSON.parse(process.env.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS)

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid previous credential encryption keys')
      }

      previousKeys = parsed as Record<string, unknown>
    } catch {
      throw new Error('CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS must be a JSON object mapping key IDs to keys')
    }
  }

  delete previousKeys[newCrypto.keyId]
  previousKeys[oldCrypto.keyId] = oldKey

  const sourceCrypto = createCredentialCrypto({
    NODE_ENV: 'production',
    CREDENTIAL_ENCRYPTION_KEY: newKey,
    CREDENTIAL_ENCRYPTION_KEY_ID: newCrypto.keyId,
    CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify(previousKeys),
  })
  const mode = arguments_[0] === '--dry-run'
    ? 'dry-run'
    : arguments_[0] === '--verify'
      ? 'verify'
      : 'rotate'
  const databasePath = process.env.DATABASE_PATH ?? join(import.meta.dir, '..', 'data', 'openmail.sqlite')

  if (databasePath === ':memory:') {
    throw new Error('Credential rotation requires an existing persistent SQLite database')
  }

  const database = new Database(databasePath, mode === 'rotate'
    ? { readwrite: true, create: false }
    : { readonly: true })

  try {
    database.exec('PRAGMA busy_timeout = 5000')

    const transaction = database.transaction(() => {
      const accounts = database.query<AccountCredential, []>(`
        SELECT id, user_id, credentials_encrypted
        FROM mail_accounts
        WHERE credentials_encrypted IS NOT NULL
        ORDER BY user_id, id
      `).all()

      if (mode === 'verify') {
        for (const account of accounts) {
          newCrypto.decryptCredential(account.credentials_encrypted, account.user_id, account.id)
        }

        return accounts.length
      }

      const rotated = accounts.map((account) => {
        const plaintext = sourceCrypto.decryptCredential(
          account.credentials_encrypted,
          account.user_id,
          account.id,
        )
        const encrypted = newCrypto.encryptCredential(plaintext, account.user_id, account.id)

        if (newCrypto.decryptCredential(encrypted, account.user_id, account.id) !== plaintext) {
          throw new Error('New credential encryption key failed verification')
        }

        return { ...account, encrypted }
      })

      if (mode === 'dry-run') return accounts.length

      const update = database.query(`
        UPDATE mail_accounts
        SET credentials_encrypted = ?
        WHERE id = ? AND user_id = ? AND credentials_encrypted = ?
      `)

      for (const account of rotated) {
        const result = update.run(
          account.encrypted,
          account.id,
          account.user_id,
          account.credentials_encrypted,
        )

        if (result.changes !== 1) {
          throw new Error('Credential rotation encountered a changed or missing account')
        }
      }

      for (const account of rotated) {
        const current = database.query<AccountCredential, [string, string]>(`
          SELECT id, user_id, credentials_encrypted
          FROM mail_accounts
          WHERE id = ? AND user_id = ?
        `).get(account.id, account.user_id)

        if (
          !current ||
          newCrypto.decryptCredential(current.credentials_encrypted, current.user_id, current.id) !==
            sourceCrypto.decryptCredential(account.credentials_encrypted, account.user_id, account.id)
        ) {
          throw new Error('Persisted credential verification failed')
        }
      }

      return accounts.length
    })

    const accounts = mode === 'rotate' ? transaction.immediate() : transaction.deferred()

    console.log(JSON.stringify({
      mode,
      accounts,
      fromKeyId: oldCrypto.keyId,
      toKeyId: newCrypto.keyId,
    }))
  } finally {
    database.close()
  }
}

try {
  rotateCredentials()
} catch (error) {
  console.error(`Credential rotation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  process.exitCode = 1
}
