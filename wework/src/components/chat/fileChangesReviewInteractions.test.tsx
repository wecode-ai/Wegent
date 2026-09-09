import { describe, expect, test } from 'vitest'
import {
  getDiffSelection,
  getHunkActionAnchor,
  getHunkPatches,
  getOpenSourceLine,
} from './fileChangesReviewUtils'

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

  test('opens only addition-side line numbers in the current source file', () => {
    expect(getOpenSourceLine({ annotationSide: 'additions', lineNumber: 12 })).toBe(12)
    expect(getOpenSourceLine({ annotationSide: 'deletions', lineNumber: 8 })).toBeNull()
  })

  test('anchors hunk actions to the final changed line like ChatGPT', () => {
    expect(getHunkActionAnchor(getHunkPatches(patch)[0])).toEqual({
      side: 'additions',
      lineNumber: 1,
    })
    expect(
      getHunkActionAnchor(
        [
          'diff --git a/src/example.ts b/src/example.ts',
          '--- a/src/example.ts',
          '+++ b/src/example.ts',
          '@@ -7,2 +7,0 @@',
          '-removed one',
          '-removed two',
        ].join('\n')
      )
    ).toEqual({
      side: 'deletions',
      lineNumber: 8,
    })
  })
})
