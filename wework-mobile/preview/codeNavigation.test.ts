import { parsePatchFiles } from '@pierre/diffs'
import { describe, expect, it, vi } from 'vitest'
import { createCodeItems, findCodeMatch, initialCodeTarget } from './codeNavigation'
import type { PreviewState } from './protocol'

const patch = `diff --git a/first.ts b/first.ts
--- a/first.ts
+++ b/first.ts
@@ -1 +1 @@
-first old
+first new
diff --git a/src/second.ts b/src/second.ts
--- a/src/second.ts
+++ b/src/second.ts
@@ -10,2 +20,2 @@
 unchanged
-removed value
+added value
`
const state: PreviewState = {
  name: 'changes.diff',
  path: '',
  url: 'http://127.0.0.1/test.diff',
  mimeType: 'text/x-diff',
  size: patch.length,
  text: patch,
  kind: 'diff',
  mode: 'preview',
  search: '',
  wrap: false,
  initialPosition: 0,
  theme: 'light',
  plantumlServerUrl: '',
}

describe('shared code renderer navigation', () => {
  it('renders a diff source as unmodified text without invoking the patch parser', () => {
    const parser = vi.fn(parsePatchFiles)
    const items = createCodeItems({ ...state, mode: 'source' }, parser)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'file', file: { contents: patch } })
    expect(parser).not.toHaveBeenCalled()
  })
  it('selects the requested patch file and never substitutes another file on a missing path', () => {
    const items = createCodeItems({ ...state, path: '/repo/src/second.ts' }, parsePatchFiles)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'diff', fileDiff: { name: 'src/second.ts' } })
    expect(createCodeItems({ ...state, path: '/repo/missing.ts' }, parsePatchFiles)).toEqual([])
    expect(createCodeItems(state, parsePatchFiles)).toHaveLength(2)
  })
  it('maps diff search to actual file lines and sides rather than patch header offsets', () => {
    const items = createCodeItems(state, parsePatchFiles)
    expect(findCodeMatch(items, 'added value')).toEqual({
      id: ':1',
      lineNumber: 21,
      side: 'additions',
    })
    expect(findCodeMatch(items, 'removed value')).toEqual({
      id: ':1',
      lineNumber: 11,
      side: 'deletions',
    })
    expect(findCodeMatch(items, '@@')).toBeUndefined()
  })
  it('prefers an explicit line over a remembered scroll position', () => {
    const items = createCodeItems(
      { ...state, kind: 'text', path: '/repo/a.ts', text: 'first\nneedle' },
      parsePatchFiles
    )
    expect(initialCodeTarget(items, 2, 500)).toMatchObject({ type: 'line', lineNumber: 2 })
    expect(initialCodeTarget(items, undefined, 500)).toMatchObject({
      type: 'position',
      position: 500,
    })
    expect(findCodeMatch(items, 'NEEDLE')).toEqual({ id: '/repo/a.ts', lineNumber: 2 })
  })
})
