export interface InboxScope {
  kind: 'domain' | 'address'
  value: string
}

export interface ConnectionSources {
  sources: Array<InboxScope & { canReceive: boolean; canSend: boolean; canFilter?: boolean; unavailableReason?: string }>
  identities: Array<{ email: string; name?: string }>
}

export interface SavedInbox {
  id: string
  accountId: string
  name: string
  scopes: InboxScope[]
  defaultSender: string | null
}

export interface SavedInboxInput {
  accountId: string
  name: string
  scopes: InboxScope[]
  defaultSender?: string | null
}
