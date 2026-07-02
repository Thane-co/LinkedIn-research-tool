// Layer 5 (client) — the single fetch wrapper every UI component uses to talk to /api. It turns a
// failed request (network error, non-2xx status, or a malformed body) into a thrown ApiError instead
// of letting the caller silently swallow it (CLAUDE.md: no silent failures). Callers catch it to show
// an error state; the `status` + parsed `body` let them branch (e.g. a 412 "needs keys" response).

export class ApiError extends Error {
  readonly status: number
  /** The parsed JSON error body when the server sent one (else null) — lets callers read fields like `needs`. */
  readonly body: unknown

  constructor(status: number, message: string, body: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

/** Read a `{ error: string }` message out of an already-parsed body, if present. */
function messageFromBody(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const { error } = body as { error?: unknown }
    if (typeof error === 'string' && error.length > 0) return error
  }
  return null
}

/** Fetch `input`, throwing ApiError on any failure. Returns the parsed JSON body on a 2xx response. */
export async function apiFetch<T>(input: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(input, init)
  } catch (err) {
    throw new ApiError(0, (err as Error).message || 'Network request failed')
  }

  if (!res.ok) {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      /* non-JSON error body — leave body null */
    }
    throw new ApiError(res.status, messageFromBody(body) ?? `Request failed (${res.status})`, body)
  }

  try {
    return (await res.json()) as T
  } catch {
    throw new ApiError(res.status, 'Malformed response from server')
  }
}
