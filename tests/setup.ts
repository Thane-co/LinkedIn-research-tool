// Vitest global setup (referenced by vitest.config.ts `setupFiles`).
//
// All external HTTP (Apify, Voyage, Anthropic) is mocked with msw so no test ever hits a real API
// (hard rule, CLAUDE.md / PRD §13). Tests register handlers per-case via `server.use(...)`.
// `onUnhandledRequest: 'error'` makes any un-mocked outbound request fail loudly.
// jsdom component tests (PRD §13) also get the @testing-library/jest-dom matchers here; importing
// is side-effect-only (extends `expect`) and harmless under the node environment.
import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './msw/server'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
