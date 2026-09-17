import { describe, expect, test } from 'vitest'
import { getAssistantReferences } from './codexReferences'

describe('getAssistantReferences', () => {
  test.each(['./design.md', 'docs/../design.md'])(
    'merges %s with the corresponding absolute assistant link',
    relativePath => {
      const references = getAssistantReferences(
        [
          {
            path: relativePath,
            title: 'Design document',
            lineStart: 12,
            lineEnd: 18,
          },
        ],
        'See [design](/workspace/project/design.md).'
      )

      expect(references).toEqual([
        {
          path: '/workspace/project/design.md',
          title: 'Design document',
          lineStart: 12,
          lineEnd: 18,
        },
      ])
    }
  )

  test('decodes escaped parentheses in assistant file link destinations', () => {
    expect(getAssistantReferences(null, String.raw`See [notes](docs/a\(draft\).md).`)).toEqual([
      {
        path: 'docs/a(draft).md',
        title: 'notes',
        lineStart: undefined,
        lineEnd: undefined,
      },
    ])
  })
})
