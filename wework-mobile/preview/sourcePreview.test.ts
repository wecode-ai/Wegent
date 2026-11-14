import { describe, expect, it } from 'vitest'
import { readSourcePreview } from './sourcePreview'

describe('text source for binary-rendered diagrams and tables', () => {
  it('returns the original diagram source for the shared code renderer', async () => {
    const source = '@startuml\nAlice -> Bob: 你好\n@enduml'
    expect(await readSourcePreview(new Blob([source]))).toEqual({ text: source, truncated: false })
  })
  it('bounds a large source preview without corrupting a partial multibyte character', async () => {
    const prefix = 'x'.repeat(256 * 1024 - 1)
    expect(await readSourcePreview(new Blob([`${prefix}中文`]))).toEqual({
      text: prefix,
      truncated: true,
    })
  })
})
