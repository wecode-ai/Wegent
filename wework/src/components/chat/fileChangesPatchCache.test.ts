import { getSingularPatch } from '@pierre/diffs'
import { expect, it } from 'vitest'
import { createFileChangesPatchCache } from './fileChangesPatchCache'

function patchFor(content: string) {
  return `diff --git a/nested/file.ts b/nested/file.ts
--- a/nested/file.ts
+++ b/nested/file.ts
@@ -1 +1 @@
-before
+${content}
`
}

it('reuses exact patch data and gives changed content a distinct highlight identity', () => {
  const getPatch = createFileChangesPatchCache()
  const original = patchFor('after')
  const first = getPatch(original)
  expect(getPatch(original)).toBe(first)
  expect(first.cacheKey).toBeDefined()
  expect(first).toEqual({ ...getSingularPatch(original), cacheKey: first.cacheKey })

  const changed = getPatch(patchFor('different'))
  expect(changed.cacheKey).not.toBe(first.cacheKey)
  expect(changed.additionLines).toEqual(['different\n'])
  expect(getPatch(original)).toBe(first)
})

it('evicts least recently used patches at the entry limit', () => {
  const getPatch = createFileChangesPatchCache(2)
  const first = getPatch(patchFor('first'))
  const second = getPatch(patchFor('second'))
  expect(getPatch(patchFor('first'))).toBe(first)
  getPatch(patchFor('third'))
  expect(getPatch(patchFor('first'))).toBe(first)
  expect(getPatch(patchFor('second')).cacheKey).not.toBe(second.cacheKey)
})

it('evicts entries for the text byte budget and skips oversized patches', () => {
  const getPatch = createFileChangesPatchCache(100, 1024)
  const first = patchFor('a'.repeat(160))
  const second = patchFor('b'.repeat(160))
  const original = getPatch(first)
  const retained = getPatch(second)
  expect(getPatch(second)).toBe(retained)
  expect(getPatch(first).cacheKey).not.toBe(original.cacheKey)

  const small = patchFor('small')
  const cached = getPatch(small)
  const oversized = patchFor('c'.repeat(600))
  const unretained = getPatch(oversized)
  expect(unretained.cacheKey).toBeUndefined()
  expect(getPatch(oversized)).not.toBe(unretained)
  expect(getPatch(small)).toBe(cached)
})
