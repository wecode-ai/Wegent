import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const inspectRuntimePath = join(import.meta.dirname, 'embedded_browser_inspect.js')

describe('embedded browser inspect runtime', () => {
  test('uses the deepest shadow target for actionable hit testing', async () => {
    const source = await readFile(inspectRuntimePath, 'utf8')

    expect(source).toContain('const root = doc.documentElement || doc.body')
    expect(source).toContain('const hit = deepestElementFromPoint(doc, x, y)')
    expect(source).toContain('element.shadowRoot.elementFromPoint(x, y)')
  })

  test('maps nested frames with their borders and scales', async () => {
    const source = await readFile(inspectRuntimePath, 'utf8')

    expect(source).toContain('localRect.x + frameMetrics.left * frameMetrics.scaleX')
    expect(source).toContain('function frameContentMetrics(frame, rect)')
    expect(source).toContain('ancestorFramesAccept(element, x, y)')
    expect(source).toContain('viewportRect: viewportRectFor(element)')
  })
})
