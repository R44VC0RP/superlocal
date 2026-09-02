import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

function getEncryptionKey(
  configuredKey: string | undefined,
  variable: string,
  environment: NodeJS.ProcessEnv,
): Buffer {
  configuredKey = configuredKey?.trim()

  if (!configuredKey) {
    if (variable !== 'CREDENTIAL_ENCRYPTION_KEY' || environment.NODE_ENV === 'production') {
      throw new Error(`${variable} is required${variable === 'CREDENTIAL_ENCRYPTION_KEY' ? ' in production' : ''}`)
    }

    return createHash('sha256')
      .update(
        environment.BETTER_AUTH_SECRET ??
          environment.AUTH_SECRET ??
          'openmail-insecure-development-credential-secret',
      )
      .update('\0openmail:credential-encryption:v1')
      .digest()
  }

  if (/^[a-f\d]{64}$/i.test(configuredKey)) {
    return Buffer.from(configuredKey, 'hex')
  }

  if (!/^[A-Za-z\d+/]+={0,2}$/.test(configuredKey)) {
    throw new Error(`${variable} must be a 32-byte hex or base64 value`)
  }

  const key = Buffer.from(configuredKey, 'base64')
  const canonicalKey = key.toString('base64').replace(/=+$/, '')

  if (key.length !== 32 || canonicalKey !== configuredKey.replace(/=+$/, '')) {
    throw new Error(`${variable} must be a 32-byte hex or base64 value`)
  }

  return key
}

function decodePart(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url')

  if (decoded.toString('base64url') !== value) {
    throw new Error('Invalid encrypted credential format')
  }

  return decoded
}

export function createCredentialCrypto(environment: NodeJS.ProcessEnv = process.env): {
  keyId: string
  encryptCredential: (plaintext: string, userId: string, accountId: string) => string
  decryptCredential: (ciphertext: string, userId: string, accountId: string) => string
} {
  const encryptionKey = getEncryptionKey(
    environment.CREDENTIAL_ENCRYPTION_KEY,
    'CREDENTIAL_ENCRYPTION_KEY',
    environment,
  )
  const keyId =
    environment.CREDENTIAL_ENCRYPTION_KEY_ID?.trim() ||
    createHash('sha256').update(encryptionKey).digest('hex').slice(0, 16)

  if (!/^[A-Za-z\d_-]{1,64}$/.test(keyId)) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY_ID must contain only letters, numbers, - or _')
  }

  const encryptionKeys = new Map([[keyId, encryptionKey]])
  const configuredPreviousKeys = environment.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS?.trim()

  if (configuredPreviousKeys) {
    let parsed: unknown

    try {
      parsed = JSON.parse(configuredPreviousKeys)
    } catch {
      throw new Error('CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS must be a JSON object mapping key IDs to keys')
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS must be a JSON object mapping key IDs to keys')
    }

    const entries = configuredPreviousKeys.slice(1, -1).trim()

    for (const entry of entries ? entries.split(',') : []) {
      let parsedEntry: unknown

      try {
        parsedEntry = JSON.parse(`{${entry}}`)
      } catch {
        throw new Error('CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS must be a JSON object mapping key IDs to keys')
      }

      const previousEntries = Object.entries(parsedEntry as Record<string, unknown>)

      if (previousEntries.length !== 1) {
        throw new Error('CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS must be a JSON object mapping key IDs to keys')
      }

      const [previousKeyId, configuredPreviousKey] = previousEntries[0]

      if (!/^[A-Za-z\d_-]{1,64}$/.test(previousKeyId)) {
        throw new Error('Credential encryption key IDs must contain only letters, numbers, - or _')
      }

      if (encryptionKeys.has(previousKeyId)) {
        throw new Error('Credential encryption key IDs must be unique')
      }

      if (typeof configuredPreviousKey !== 'string') {
        throw new Error('CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS entries must be 32-byte hex or base64 values')
      }

      const previousKey = getEncryptionKey(
        configuredPreviousKey,
        'CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS entries',
        environment,
      )

      if (Array.from(encryptionKeys.values()).some((key) => timingSafeEqual(key, previousKey))) {
        throw new Error('Credential encryption key IDs must reference distinct keys')
      }

      encryptionKeys.set(previousKeyId, previousKey)
    }
  }

  return {
    keyId,
    encryptCredential(plaintext: string, userId: string, accountId: string): string {
      if (!userId || !accountId) {
        throw new Error('Credential encryption requires a user ID and account ID')
      }

      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
      cipher.setAAD(Buffer.from(JSON.stringify([userId, accountId]), 'utf8'))

      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()

      return [
        'v1',
        keyId,
        iv.toString('base64url'),
        encrypted.toString('base64url'),
        tag.toString('base64url'),
      ].join('.')
    },
    decryptCredential(ciphertext: string, userId: string, accountId: string): string {
      if (!userId || !accountId) {
        throw new Error('Credential decryption requires a user ID and account ID')
      }

      const parts = ciphertext.split('.')
      const decryptionKey = parts.length === 5 && parts[0] === 'v1'
        ? encryptionKeys.get(parts[1])
        : undefined

      if (!decryptionKey) {
        throw new Error('Invalid encrypted credential version or key ID')
      }

      const iv = decodePart(parts[2])
      const encrypted = decodePart(parts[3])
      const tag = decodePart(parts[4])

      if (iv.length !== 12 || tag.length !== 16) {
        throw new Error('Invalid encrypted credential format')
      }

      const decipher = createDecipheriv('aes-256-gcm', decryptionKey, iv)
      decipher.setAAD(Buffer.from(JSON.stringify([userId, accountId]), 'utf8'))
      decipher.setAuthTag(tag)

      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    },
  }
}

let credentialCrypto: ReturnType<typeof createCredentialCrypto> | undefined

export function encryptCredential(plaintext: string, userId: string, accountId: string): string {
  return (credentialCrypto ??= createCredentialCrypto()).encryptCredential(plaintext, userId, accountId)
}

export function decryptCredential(ciphertext: string, userId: string, accountId: string): string {
  return (credentialCrypto ??= createCredentialCrypto()).decryptCredential(ciphertext, userId, accountId)
}
