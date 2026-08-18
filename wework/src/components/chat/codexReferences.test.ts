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
})
