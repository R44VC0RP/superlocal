import { MockInboxProvider } from './mock'
import { providerRegistry } from './registry'

export * from './registry'
export * from './mock'

// Only the API runtime loads the database-backed demo adapter.
providerRegistry.register('mock', (credentials) => new MockInboxProvider(credentials))
