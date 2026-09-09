import { describe, expect, test } from 'vitest'
import { getDiffSelection, getHunkPatches } from './fileChangesReviewUtils'

const patch = [
  'diff --git a/src/example.ts b/src/example.ts',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -1,2 +1,2 @@',
  '-old first',
  '+new first',
  ' context',
  '@@ -10 +10 @@',
  '-old second',
  '+new second',
  '',
].join('\n')

describe('fileChangesReviewInteractions', () => {
  test('builds individual hunk patches with the file header', () => {
    const hunks = getHunkPatches(patch)

    expect(hunks).toHaveLength(2)
    expect(hunks[1]).toContain('@@ -10 +10 @@')
    expect(hunks[1]).not.toContain('@@ -1,2 +1,2 @@')
  })

  test('maps a selected additions range back to source text and line numbers', () => {
    expect(
      getDiffSelection(patch, {
        start: 1,
        end: 2,
        side: 'additions',
        endSide: 'additions',
      })
    ).toEqual({
      selectedText: 'new first\ncontext',
      startLine: 1,
      endLine: 2,
    })
  })
})
