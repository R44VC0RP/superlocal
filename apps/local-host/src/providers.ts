import { createGoogleCredentialRefresh, createGoogleOAuthApi, createGoogleOAuthHost, InboxError, verifyGoogleCredentials,
  type GoogleOAuthConfig, type Inbox, type ProviderCredentialHelp, type ProviderDefinition, type ProviderOnboarding, type ProviderOnboardingField, type ProviderOnboardingOption } from 'inbox-sdk'
import type { InboxApiOptions } from 'inbox-sdk/http'
import { builtInProviders } from 'inbox-sdk/providers'
import { createHash } from 'node:crypto'
import { resolveSecret, type ImapHostPreset, type LocalConfig } from './config'
import type { openLocalRuntime } from './runtime'

/** Browser-facing onboarding descriptor: SDK `ProviderDefinition.onboarding` plus host readiness, presets and connections. */
export interface HostProvider {
  id: string
  name: string
  connection: 'oauth' | 'credentials' | 'none'
  enabled: boolean
  ready: boolean
  setupMessage?: string
  summary?: string
  actionLabel?: string
  redirectNote?: string
  fields?: HostProviderField[]
  mailboxSelection: 'automatic' | 'manual'
  credentialHelp?: ProviderCredentialHelp
  advancedNote?: string
  reconnect?: boolean
  connectionIds: string[]
}
export interface HostProviderField {
  name: string
  label: string
  type: 'password' | 'text' | 'email' | 'select'
  required: boolean
  advanced?: boolean
  defaultValue?: string
  options?: HostProviderOption[]
}
export interface HostProviderOption {
  value: string
  label: string
  summary?: string
  fieldLabels?: Record<string, string>
  hiddenFields?: string[]
  credentialHelp?: ProviderCredentialHelp
}

export type ConnectResult = { connectionId: string } | { authorizeUrl: string }
export interface HostExtension {
  matches(path: string): boolean
  /** Native browser return from the upstream identity provider; carries no host session header. */
  callbackPath: string
  /** Native navigation handoff whose opaque ticket must be owner-checked before the SDK consumes it. */
  authorization?: { attemptId(path: string): string | undefined; owns(id: string, owner: string): boolean }
  fetch(request: Request): Promise<Response>
}
export interface HostProviderRegistration {
  definition: ProviderDefinition
  descriptor: Omit<HostProvider, 'connectionIds'>
  connect?(inbox: Inbox, owner: string, credentials: Record<string, string>, origin: string): Promise<ConnectResult>
  reconnect?(inbox: Inbox, owner: string, connectionId: string, credentials: Record<string, string>): Promise<ConnectResult>
  mount?(inbox: Inbox, authenticate: InboxApiOptions['authenticate']): HostExtension
}

export interface HostPresets {
  /** Select field offered when more than one preset exists; a single preset is applied directly to the fields. */
  field: { name: string; label: string }
  options: readonly ProviderOnboardingOption[]
}
export interface DescribeOptions {
  ready?: boolean
  setupMessage?: string
  /** False when the browser cannot start a connection (offline mock). */
  connectable?: boolean
  reconnect?: boolean
  presets?: HostPresets
}

const cloneField = ({ options, ...field }: ProviderOnboardingField): HostProviderField => ({ ...field, ...(options ? { options: options.map(cloneOption) } : {}) })
const cloneOption = ({ fieldLabels, hiddenFields, ...option }: ProviderOnboardingOption): HostProviderOption => ({ ...option,
  ...(fieldLabels ? { fieldLabels: { ...fieldLabels } } : {}), ...(hiddenFields ? { hiddenFields: [...hiddenFields] } : {}) })
const defined = <T extends object>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>

/** Every descriptor comes from the SDK definition; the host contributes only readiness, presets and connection state. */
export function describeProvider(definition: ProviderDefinition, host: DescribeOptions = {}): Omit<HostProvider, 'connectionIds'> {
  const onboarding: ProviderOnboarding = definition.onboarding ?? {}
  const ready = host.ready ?? true
  const connection = host.connectable === false ? 'none' : definition.connection ?? 'credentials'
  let name = definition.name
  let fields = connection === 'credentials' ? (onboarding.fields ?? []).map(cloneField) : undefined
  let { summary, credentialHelp } = onboarding
  if (fields && host.presets) {
    const [only, ...rest] = host.presets.options
    if (only && !rest.length) {
      // One trusted preset: it names the provider and adapts the fields; no select is offered.
      name = only.label
      summary = only.summary ?? summary
      credentialHelp = only.credentialHelp ?? credentialHelp
      fields = fields.filter(field => !only.hiddenFields?.includes(field.name)).map(field => ({ ...field, label: only.fieldLabels?.[field.name] ?? field.label }))
    } else if (only) {
      fields = [{ name: host.presets.field.name, label: host.presets.field.label, type: 'select', required: true, defaultValue: only.value, options: host.presets.options.map(cloneOption) }, ...fields]
    }
  }
  return {
    id: definition.id, name, connection, enabled: true, ready,
    // The SDK auto-creates the whole-account mailbox unless the definition asks for manual selection.
    mailboxSelection: definition.mailboxSelection === 'manual' ? 'manual' : 'automatic',
    ...defined({ summary, actionLabel: onboarding.actionLabel, redirectNote: onboarding.redirectNote, credentialHelp, advancedNote: onboarding.advancedNote }),
    ...(ready ? {} : { setupMessage: host.setupMessage ?? onboarding.setupMessage ?? 'Complete the provider configuration in the local host, then restart.' }),
    ...(fields?.length ? { fields } : {}),
    ...(host.reconnect ? { reconnect: true } : {}),
  }
}

/**
 * One browser-facing failure vocabulary for every provider, keyed on the SDK error code.
 * Host-owned codes pass through; everything else loses provider detail and raw messages.
 */
export function connectFailure(error: unknown, providerName: string): InboxError {
  if (error instanceof InboxError && /^HOST_[A-Z_]+$/.test(error.code)) return error
  const code = error instanceof InboxError ? error.code : 'NETWORK'
  switch (code) {
    case 'CONNECTION_EXISTS':
      return new InboxError('HOST_CONNECT_ALREADY_CONNECTED', 'This account is already connected. Use its Reconnect option to replace the credentials.', 409)
    case 'AUTHENTICATION': case 'AUTHORIZATION': case 'CREDENTIALS_UNAVAILABLE': case 'CREDENTIALS_REVOKED':
      return new InboxError('HOST_CONNECT_AUTHENTICATION', `${providerName} rejected the sign-in. Check the account and credentials; revoked credentials must be replaced.`, 409)
    case 'ACCOUNT_MISMATCH': case 'SOURCE_IDENTITY_UNVERIFIED':
      return new InboxError('HOST_CONNECT_ACCOUNT_MISMATCH', 'Reconnect using the same account and settings. A different account needs a new connection.', 409)
    case 'VALIDATION':
      return new InboxError('HOST_INVALID_CREDENTIALS', `${providerName} did not accept these credentials.`, 400)
    case 'RATE_LIMITED':
      return new InboxError('HOST_CONNECT_RATE_LIMITED', `${providerName} is limiting requests. Try again in a few minutes.`, 429)
    case 'UNSUPPORTED_OPERATION': case 'INVALID_PROVIDER':
      return new InboxError('HOST_CONNECT_UNAVAILABLE', `${providerName} cannot be connected by this host.`, 409)
    default:
      return new InboxError('HOST_CONNECT_FAILED', `${providerName} could not be reached securely. Check the connection and try again; certificate verification cannot be disabled.`, 409)
  }
}

/** Trusted-host wrapper: stored credentials can never move a built-in provider to another upstream. */
function pinned(definition: ProviderDefinition, create: ProviderDefinition['create'] = (credentials, context) => {
  const { baseUrl: _ignored, ...rest } = credentials
  return definition.create(rest, context)
}): ProviderDefinition {
  return { ...definition, create }
}

const ICLOUD_PRESET: ImapHostPreset = { id: 'icloud', name: 'iCloud Mail',
  imap: { host: 'imap.mail.me.com', port: 993, secure: true },
  smtp: { host: 'smtp.mail.me.com', port: 587, secure: false }, sentCopy: 'append',
  onboarding: { passwordLabel: 'App-specific password', usernameIsEmail: true,
    credentialHelp: { text: 'For iCloud, create a dedicated app-specific password with two-factor authentication enabled. Do not use your Apple Account password.',
      url: 'https://support.apple.com/en-us/102654', linkLabel: 'Create an app-specific password' } } }

function presetOption(preset: ImapHostPreset): ProviderOnboardingOption {
  const { passwordLabel, usernameIsEmail, credentialHelp } = preset.onboarding ?? {}
  return { value: preset.id, label: preset.name,
    ...(passwordLabel ? { summary: `Email and ${passwordLabel.toLowerCase()}`, fieldLabels: { password: passwordLabel } } : {}),
    ...(usernameIsEmail ? { hiddenFields: ['imapUsername', 'smtpUsername'] } : {}),
    ...(credentialHelp ? { credentialHelp } : {}) }
}

type Flow = (definition: ProviderDefinition) => HostProviderRegistration

export function createRealRegistrations(config: LocalConfig, runtime: ReturnType<typeof openLocalRuntime>, environment: NodeJS.ProcessEnv) {
  let googleConfig: GoogleOAuthConfig | undefined

  const google: Flow = base => {
    const clientId = resolveSecret(config.providers.gmail.oauth.clientId, environment)
    const clientSecret = resolveSecret(config.providers.gmail.oauth.clientSecret, environment)
    const callbackPath = '/v1/oauth/google/callback'
    if (clientId && clientSecret) googleConfig = { clientId, clientSecret, scopes: config.providers.gmail.oauth.scopes, redirectUri: `${config.web.origin}${callbackPath}` }
    let coordinator: ReturnType<typeof createGoogleOAuthHost> | undefined
    const oauth = (inbox: Inbox) => {
      if (!googleConfig) throw new InboxError('HOST_PROVIDER_NOT_READY', 'Configure the Gmail OAuth client in superlocal.local.json or its explicitly named environment variables, then restart.', 409)
      return coordinator ??= createGoogleOAuthHost({ inbox, database: runtime.database, encryptionKey: runtime.encryptionKey, config: googleConfig })
    }
    const definition = { ...pinned(base), scopes: config.providers.gmail.oauth.scopes, refresh: createGoogleCredentialRefresh(googleConfig) }
    return {
      definition,
      descriptor: describeProvider(definition, { ready: !!googleConfig,
        setupMessage: `Set providers.${base.id}.oauth.clientId and clientSecret in superlocal.local.json (or their explicit environment references), register web.origin + ${callbackPath} with Google, then restart.` }),
      async connect(inbox, owner, _credentials, origin) {
        if (origin !== config.web.origin) throw new InboxError('HOST_OAUTH_ORIGIN_REQUIRED', 'Open the configured web.origin before starting OAuth so its session and callback stay on the same origin.', 409)
        const attempt = await oauth(inbox).start(owner)
        if (!attempt.authorizeUrl) throw new InboxError('HOST_OAUTH_UNAVAILABLE', 'OAuth could not be started.', 503)
        const url = new URL(attempt.authorizeUrl)
        if (url.origin !== config.web.origin) throw new InboxError('HOST_OAUTH_UNAVAILABLE', 'OAuth origin does not match the local web origin.', 503)
        return { authorizeUrl: `${url.pathname}${url.search}` }
      },
      mount(inbox, authenticate) {
        const api = createGoogleOAuthApi({ oauth: () => oauth(inbox), authenticate, allowedOrigins: config.web.allowedOrigins })
        return {
          matches: path => path.startsWith('/v1/oauth/google/'), callbackPath,
          authorization: {
            attemptId: path => /^\/v1\/oauth\/google\/authorize\/([^/%]+)$/.exec(path)?.[1],
            // The SDK's redirect handoff consumes a one-use ticket; check its owner before consumption.
            owns: (id, owner) => !!runtime.database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sdk_oauth_attempts'").get() &&
              !!runtime.database.query('SELECT 1 FROM sdk_oauth_attempts WHERE id=? AND owner=?').get(id, owner),
          },
          async fetch(request) {
            const incoming = new URL(request.url)
            // Vite may rewrite Host. The coordinator must see its exact registered callback URL.
            const canonical = new Request(new URL(`${incoming.pathname}${incoming.search}`, config.web.origin), request)
            const response = await api.fetch(canonical)
            if (incoming.pathname !== callbackPath || request.method !== 'GET') return response
            const headers = new Headers(response.headers)
            headers.delete('Content-Type')
            headers.delete('Content-Length')
            // Tell the web app which provider finished so it can resume onboarding for that connection.
            const params = new URLSearchParams({ connection: response.ok ? 'connected' : 'failed', provider: base.id })
            if (response.ok) {
              const body = await response.clone().json().catch(() => null) as { id?: unknown } | null
              if (typeof body?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.id)) params.set('connectionId', body.id)
            }
            headers.set('Location', `${config.web.origin}/?${params}`)
            return new Response(null, { status: 303, headers })
          },
        }
      },
    }
  }

  const imap: Flow = base => {
    const presets: ImapHostPreset[] = [ICLOUD_PRESET, ...config.providers.imap.servers]
    const prepare = (credentials: Record<string, unknown>) => {
      const preset = presets.find(preset => preset.id === (credentials.preset || presets[0]!.id))
      if (!preset) throw new InboxError('HOST_IMAP_ENDPOINT_FORBIDDEN', 'Select a mail server preset configured by this host.', 400)
      const { email, password } = credentials
      if (typeof email !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) || typeof password !== 'string' || !password.length) {
        throw new InboxError('HOST_INVALID_CREDENTIALS', 'Enter the mailbox email and its mail password.', 400)
      }
      // Endpoints, TLS, and Sent policy are host-owned. Browser fields cannot override them.
      // Some services (iCloud) document the full address as the required IMAP/SMTP username.
      const address = email.toLowerCase()
      const fixed = preset.onboarding?.usernameIsEmail === true
      const imapUser = fixed ? address : typeof credentials.imapUsername === 'string' && credentials.imapUsername || address
      const smtpUser = fixed ? address : typeof credentials.smtpUsername === 'string' && credentials.smtpUsername || address
      const { onboarding: _descriptorOnly, ...endpoints } = preset
      const identity = { issuer: `imaps://${preset.imap.host}:${preset.imap.port}`, subject: imapUser,
        registrationId: createHash('sha256').update(JSON.stringify([endpoints, address, smtpUser])).digest('hex') }
      return { identity, email: address, imap: { ...preset.imap, user: imapUser, password },
        ...(preset.smtp ? { smtp: { ...preset.smtp, user: smtpUser, password } } : {}), sentCopy: preset.sentCopy }
    }
    // The SDK builds the IMAP client; the host only substitutes its pinned endpoints for the browser's fields.
    const definition = pinned(base, (credentials, context) => {
      const prepared = prepare(credentials)
      return base.create({ accountId: credentials.accountId, userId: credentials.userId, email: prepared.email, imap: prepared.imap, smtp: prepared.smtp, sentCopy: prepared.sentCopy }, context)
    })
    return {
      definition,
      descriptor: describeProvider(definition, { reconnect: true, presets: { field: { name: 'preset', label: 'Mail service' }, options: presets.map(presetOption) } }),
      async connect(inbox, owner, credentials) {
        const prepared = prepare(credentials)
        const connection = await inbox.createConnection(owner, { providerId: base.id, credentials }, prepared.identity)
        return { connectionId: connection.id }
      },
      async reconnect(inbox, owner, connectionId, credentials) {
        const connection = await inbox.connection(owner, connectionId)
        if (connection.providerId !== base.id) throw new InboxError('HOST_CONNECT_ACCOUNT_MISMATCH', `This connection does not belong to ${base.name}.`, 409)
        const prepared = prepare(credentials)
        if (!connection.identity || JSON.stringify(connection.identity) !== JSON.stringify(prepared.identity)) throw new InboxError('ACCOUNT_MISMATCH', 'Connection identity differs.', 409)
        if (connection.status === 'disconnected') await inbox.reconnect(owner, connection.sourceIds[0]!, credentials, { identity: prepared.identity, generation: connection.generation })
        else {
          const state = await inbox.credentialState(owner, connectionId)
          await inbox.updateCredentials(owner, connectionId, credentials, state.version, prepared.identity)
        }
        return { connectionId }
      },
    }
  }

  /** Any credential provider without host-specific wiring: descriptor fields in, SDK connection out. */
  const plain: Flow = base => {
    const definition = pinned(base)
    return {
      definition, descriptor: describeProvider(definition),
      async connect(inbox, owner, credentials) {
        const connection = await inbox.createConnection(owner, { providerId: base.id, credentials })
        return { connectionId: connection.id }
      },
    }
  }
  /** OAuth providers need a host coordinator; without one they are listed but cannot start. */
  const unavailable: Flow = base => {
    const definition = pinned(base)
    return { definition, descriptor: describeProvider(definition, { ready: false, setupMessage: `${base.name} sign-in is not available in this host yet.` }) }
  }

  const flows: Record<string, Flow> = { gmail: google, imap }
  const registrations = builtInProviders.flatMap(base => {
    if (!config.providers[base.id]?.enabled) return []
    return [(flows[base.id] ?? (base.connection === 'oauth' ? unavailable : plain))(base)]
  })
  return { registrations, verifyCredentials: (context: Parameters<typeof verifyGoogleCredentials>[0]) => verifyGoogleCredentials(context, googleConfig) }
}
