import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const inspectRuntimePath = join(import.meta.dirname, 'embedded_browser_inspect.js')

describe('embedded browser inspect runtime', () => {
  test('uses the deepest shadow target for actionable hit testing', async () => {
    const source = await readFile(inspectRuntimePath, 'utf8')

    expect(source).toContain('const root = doc.documentElement || doc.body')
    expect(source).toContain('const hit = deepestElementFromPoint(doc, localX, localY)')
    expect(source).toContain('element.shadowRoot.elementFromPoint(x, y)')
  })
})
