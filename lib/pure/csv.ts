// Layer 0 — parse a bulk-import CSV into creator inputs (PRD §11.2). Zero I/O.
// Simple CSV: one creator per line. The first comma-cell of each row is used (so `url,tag,tag`
// collapses to `url`), surrounding quotes/whitespace are stripped, blank lines are dropped, and a
// leading header row (first cell is a known header word) is skipped. The resulting strings are the
// same shape the paste box produces and go straight to `POST /api/creators { inputs }`.

const HEADER_WORDS = new Set([
  'url',
  'urls',
  'profile',
  'profile_url',
  'profileurl',
  'handle',
  'handles',
  'link',
  'links',
  'creator',
  'creators',
  'username',
  'name',
  'twitter',
  'linkedin',
])

const firstCell = (line: string): string =>
  (line.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '').trim()

export function parseCreatorCsv(text: string): string[] {
  const rows = text
    .split(/\r?\n/)
    .map(firstCell)
    .filter((cell) => cell.length > 0)

  if (rows.length > 0 && HEADER_WORDS.has(rows[0]!.toLowerCase())) rows.shift()
  return rows
}
