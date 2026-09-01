import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const actionRuntimePath = join(import.meta.dirname, 'embedded_browser_action.js')

describe('embedded browser action runtime', () => {
  test('uses the deepest shadow target for coordinate hit testing and visibility', async () => {
    const source = await readFile(actionRuntimePath, 'utf8')

    expect(source).toContain('const hit = deepestElementFromPoint(x, y)')
    expect(source).toContain('return deepestElementFromPoint(x, y)')
    expect(source).toContain('element.shadowRoot.elementFromPoint(x, y)')
    expect(source).toContain('root instanceof ShadowRoot ? root.host : null')
  })

  test('keeps preflight warnings iterable for failed visibility checks', async () => {
    const source = await readFile(actionRuntimePath, 'utf8')

    expect(source).toMatch(
      /function errorResult[\s\S]*?error: errorObject\(code, message, suggestedNextAction\),\s*warnings: \[\]/
    )
  })
})
