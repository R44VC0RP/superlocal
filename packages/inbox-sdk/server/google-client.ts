import { ApiError, type createInboxClient, type InboxRequestOptions } from '../src/client'
import type { OAuthAttempt } from './google-oauth'

export function createGoogleOAuthClient(client: ReturnType<typeof createInboxClient>) {
  return {
    startGoogleOAuth: (input: { connectionId?: string } = {}, options: InboxRequestOptions = {}) =>
      client.request<OAuthAttempt>('/connections/google/start', { method: 'POST', body: JSON.stringify(input), cache: 'no-store', signal: options.signal }),
    googleOAuthAttempt: (id: string, options: InboxRequestOptions = {}) => {
      if (!id || id === '.' || id === '..') throw new ApiError('Invalid resource ID', 400, 'INVALID_INPUT')
      return client.request<OAuthAttempt>(`/connections/google/attempts/${encodeURIComponent(id)}`, { cache: 'no-store', signal: options.signal })
    },
  }
}
