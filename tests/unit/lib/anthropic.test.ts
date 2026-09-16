// @vitest-environment node
import { execFile } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completeText } from '@/lib/anthropic'

// The CLI is never really invoked — execFile is mocked so we control its callback.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

const mockExecFile = vi.mocked(execFile)

/** The callback execFile is always invoked with, regardless of the (file, args, [options]) arity. */
type ExecCb = (err: unknown, stdout: string, stderr: string) => void
const lastCallback = (): ExecCb => {
  const call = mockExecFile.mock.calls.at(-1)!
  return call[call.length - 1] as unknown as ExecCb
}
/** The argv array passed to `claude` on the most recent call. */
const lastArgs = (): string[] => mockExecFile.mock.calls.at(-1)![1] as unknown as string[]

const okResult = (result: string): string =>
  JSON.stringify({ type: 'result', subtype: 'success', result })

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('completeText (claude CLI)', () => {
  it('returns the parsed `result` text on a successful CLI call', async () => {
    mockExecFile.mockImplementation(((...cbArgs: unknown[]) => {
      const cb = cbArgs[cbArgs.length - 1] as ExecCb
      cb(null, okResult('the rewritten profile'), '')
      return {} as never
    }) as never)

    const out = await completeText({ prompt: 'fold this in' })

    expect(out).toBe('the rewritten profile')
    // Invoked as `claude -p <prompt> --output-format json --max-turns 1`.
    expect(mockExecFile.mock.calls[0]![0]).toBe('claude')
    const args = lastArgs()
    expect(args).toEqual(['-p', 'fold this in', '--output-format', 'json', '--max-turns', '1'])
  })

  it('passes a `system` param through as --append-system-prompt', async () => {
    mockExecFile.mockImplementation(((...cbArgs: unknown[]) => {
      const cb = cbArgs[cbArgs.length - 1] as ExecCb
      cb(null, okResult('ok'), '')
      return {} as never
    }) as never)

    await completeText({ prompt: 'p', system: 'you are careful' })

    const args = lastArgs()
    expect(args).toContain('--append-system-prompt')
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('you are careful')
  })

  it('returns null (no throw) when the claude binary is missing (ENOENT)', async () => {
    mockExecFile.mockImplementation(((...cbArgs: unknown[]) => {
      const cb = cbArgs[cbArgs.length - 1] as ExecCb
      const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
      cb(err, '', '')
      return {} as never
    }) as never)

    const out = await completeText({ prompt: 'p' })

    expect(out).toBeNull()
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/not found|PATH/i))
  })

  it('returns null (no throw) when the CLI exits non-zero', async () => {
    mockExecFile.mockImplementation(((...cbArgs: unknown[]) => {
      const cb = cbArgs[cbArgs.length - 1] as ExecCb
      const err = Object.assign(new Error('Command failed'), { code: 1 })
      cb(err, '', 'boom')
      return {} as never
    }) as never)

    const out = await completeText({ prompt: 'p' })

    expect(out).toBeNull()
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/error/i))
  })

  it('returns null (no throw) when the CLI times out and is killed', async () => {
    mockExecFile.mockImplementation(((...cbArgs: unknown[]) => {
      const cb = cbArgs[cbArgs.length - 1] as ExecCb
      const err = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })
      cb(err, '', '')
      return {} as never
    }) as never)

    const out = await completeText({ prompt: 'p' })

    expect(out).toBeNull()
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/tim(e|ed) out/i))
  })

  it('returns null when the CLI reports a non-success subtype', async () => {
    mockExecFile.mockImplementation(((...cbArgs: unknown[]) => {
      const cb = cbArgs[cbArgs.length - 1] as ExecCb
      cb(null, JSON.stringify({ type: 'result', subtype: 'error_max_turns' }), '')
      return {} as never
    }) as never)

    const out = await completeText({ prompt: 'p' })

    expect(out).toBeNull()
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/error_max_turns|subtype/i))
  })

  it('returns null (no throw) when stdout is not valid JSON', async () => {
    mockExecFile.mockImplementation(((...cbArgs: unknown[]) => {
      const cb = cbArgs[cbArgs.length - 1] as ExecCb
      cb(null, 'not json at all', '')
      return {} as never
    }) as never)

    const out = await completeText({ prompt: 'p' })

    expect(out).toBeNull()
  })

  it('does not pass --append-system-prompt when no system param is given', async () => {
    mockExecFile.mockImplementation(((...cbArgs: unknown[]) => {
      const cb = cbArgs[cbArgs.length - 1] as ExecCb
      cb(null, okResult('ok'), '')
      return {} as never
    }) as never)

    await completeText({ prompt: 'p' })

    expect(lastArgs()).not.toContain('--append-system-prompt')
  })
})
