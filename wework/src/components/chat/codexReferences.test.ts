// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { getAssistantReferences } from './codexReferences'

describe('getAssistantReferences', () => {
  test('extracts a document card from a URI-encoded Windows Markdown destination', () => {
    const path = String.raw`D:\workspace\cart-fixture\cart-review.md`

    expect(
      getAssistantReferences([], `Verified [cart-fixture/cart-review.md](<${encodeURI(path)}>)`)
    ).toEqual([
      { path, title: 'cart-fixture/cart-review.md', lineStart: undefined, lineEnd: undefined },
    ])
  })

  test.each(['./design.md'])(
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
