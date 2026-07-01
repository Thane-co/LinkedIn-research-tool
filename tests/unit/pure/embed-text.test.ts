import { describe, expect, it } from 'vitest'
import { buildEmbeddingText } from '@/lib/pure/embed-text'

describe('buildEmbeddingText', () => {
  it('trims the content when there is no image description', () => {
    expect(buildEmbeddingText('  hello world  ')).toBe('hello world')
  })

  it('appends the image description so visual signal lands in the text vector', () => {
    expect(buildEmbeddingText('a post', 'a bar chart')).toBe('a post\n\n[Image content: a bar chart]')
  })

  it('treats null/undefined content as an empty base', () => {
    expect(buildEmbeddingText(null)).toBe('')
    expect(buildEmbeddingText(null, 'a chart')).toBe('\n\n[Image content: a chart]')
  })

  it('ignores an empty-string image description', () => {
    expect(buildEmbeddingText('body', '')).toBe('body')
    expect(buildEmbeddingText('body', null)).toBe('body')
  })
})
