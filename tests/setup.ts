// Vitest global setup (referenced by vitest.config.ts `setupFiles`).
//
// When adapters are built (Layer 2), wire the msw server lifecycle here so ALL external HTTP
// (Apify, Voyage, Anthropic) is mocked and no test ever hits a real API:
//
//   import { afterAll, afterEach, beforeAll } from 'vitest'
//   import { server } from './msw/server'
//   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
//   afterEach(() => server.resetHandlers())
//   afterAll(() => server.close())
//
// Intentionally empty until the first adapter test needs it.
export {}
