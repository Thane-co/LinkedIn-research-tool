// Layer 2 — shared fetch helper with a per-request abort-on-timeout (PRD §10.7).
// Uses an explicit AbortController + setTimeout (not AbortSignal.timeout) so the timeout is a
// normal timer the test suite can drive with fake timers. The timer is always cleared so a
// resolved request never leaves a dangling handle.

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs,
  )
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
