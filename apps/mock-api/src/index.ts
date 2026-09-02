import { MockConfigurationError } from './config'
import { logMockEvent, startMockServer } from './host'

export { createMockHost, startMockServer, type MockHost } from './host'
export { readMockConfig, MOCK_HOSTNAME, MOCK_UI_ORIGINS, type MockConfigOverrides } from './config'
export { createMockProviderDefinition, MockInboxProvider, MOCK_CAPABILITIES } from './provider'
export { MockMailStore, type StoreScope, type ReceiveInput } from './store'
export { seedMockMail, INITIAL_SEED_COUNTS } from './seed'
export { MOCK_OWNER } from './validation'

if (import.meta.main) {
  try {
    const service = await startMockServer()
    const stop = () => {
      void service.close().catch(() => {
        logMockEvent({ event: 'mock.host', code: 'MOCK_SHUTDOWN_FAILED', operation: 'shutdown' })
        process.exitCode = 1
      })
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    logMockEvent({ event: 'mock.started', origin: `http://127.0.0.1:${service.server.port}`, provider: 'mock', offline: true })
  } catch (error) {
    logMockEvent({ event: 'mock.host', code: error instanceof MockConfigurationError ? error.code : 'MOCK_START_FAILED', operation: 'startup' })
    process.exitCode = 1
  }
}
