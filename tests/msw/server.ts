// Shared msw server for all adapter tests (PRD §13). Handlers are registered per-test via
// server.use(...); the lifecycle is wired in tests/setup.ts.
import { setupServer } from 'msw/node'

export const server = setupServer()
