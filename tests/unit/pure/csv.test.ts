import { describe, expect, it } from 'vitest'
import { parseCreatorCsv } from '@/lib/pure/csv'

describe('parseCreatorCsv', () => {
  it('returns one entry per line (urls and @handles)', () => {
    const csv = 'https://www.linkedin.com/in/jane\n@janedev\nhttps://x.com/joe'
    expect(parseCreatorCsv(csv)).toEqual([
      'https://www.linkedin.com/in/jane',
      '@janedev',
      'https://x.com/joe',
    ])
  })

  it('drops a leading header row', () => {
    const csv = 'profile_url\nhttps://www.linkedin.com/in/jane\n@joe'
    expect(parseCreatorCsv(csv)).toEqual(['https://www.linkedin.com/in/jane', '@joe'])
  })

  it('keeps only the first comma-cell of each row and strips quotes/whitespace', () => {
    const csv = 'url,tags,name\n"https://x.com/jane", "ai, founder" , Jane\n  @joe , news'
    expect(parseCreatorCsv(csv)).toEqual(['https://x.com/jane', '@joe'])
  })

  it('tolerates CRLF line endings and blank lines', () => {
    const csv = 'https://x.com/jane\r\n\r\n@joe\r\n'
    expect(parseCreatorCsv(csv)).toEqual(['https://x.com/jane', '@joe'])
  })

  it('does not treat a bare handle first row as a header', () => {
    // "jane" is not a known header word, so it is kept
    expect(parseCreatorCsv('jane\n@joe')).toEqual(['jane', '@joe'])
  })

  it('returns [] for empty / header-only input', () => {
    expect(parseCreatorCsv('')).toEqual([])
    expect(parseCreatorCsv('url\n')).toEqual([])
  })
})
