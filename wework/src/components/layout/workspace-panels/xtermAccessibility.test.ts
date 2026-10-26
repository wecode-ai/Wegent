import { Terminal } from '@xterm/xterm'
import { afterEach, expect, test, vi } from 'vitest'

interface AccessibilityManager {
  _renderRows(start: number, end: number): void
  _refreshRowsDimensions(): void
  _renderService: {
    dimensions: { css: { cell: { width: number; height: number } } }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

test('batches accessible row layout reads before applying character alignment', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const terminal = new Terminal({ rows: 3, cols: 80, screenReaderMode: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  terminal.open(container)
  try {
    await new Promise<void>(resolve => terminal.write('ascii\r\n中文\r\n', resolve))
    const manager = (
      terminal as unknown as { _core: { _accessibilityManager: { value: AccessibilityManager } } }
    )._core._accessibilityManager.value
    manager._renderService.dimensions.css.cell.width = 10
    manager._renderService.dimensions.css.cell.height = 20
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="listitem"]'))
    expect(rows).toHaveLength(3)
    const operations: string[] = []
    for (const [index, row] of rows.entries()) {
      vi.spyOn(row, 'textContent', 'set').mockImplementation(value => {
        operations.push(`text:${index}`)
        row.replaceChildren(document.createTextNode(value ?? ''))
      })
      vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
        operations.push(`read:${index}`)
        return { width: 40 } as DOMRect
      })
      const descriptor = Object.getOwnPropertyDescriptor(
        CSSStyleDeclaration.prototype,
        'transform'
      )!
      vi.spyOn(row.style, 'transform', 'set').mockImplementation(value => {
        operations.push(`${value ? 'scale' : 'clear'}:${index}`)
        descriptor.set!.call(row.style, value)
      })
    }

    manager._renderRows(0, 2)
    expect(operations).toEqual([
      'text:0',
      'text:1',
      'text:2',
      'clear:0',
      'clear:1',
      'clear:2',
      'read:0',
      'read:1',
      'read:2',
      'scale:0',
      'scale:1',
      'scale:2',
    ])
    expect(rows[0].style.transform).toBe('scaleX(1.25)')
    expect(rows[1].style.transform).toBe('scaleX(1)')
    expect(rows[2].style.transform).toBe('scaleX(0.25)')
    expect(rows.map(row => row.getAttribute('aria-posinset'))).toEqual(['1', '2', '3'])

    operations.length = 0
    manager._refreshRowsDimensions()
    expect(operations).toEqual([
      'clear:0',
      'clear:1',
      'clear:2',
      'read:0',
      'read:1',
      'read:2',
      'scale:0',
      'scale:1',
      'scale:2',
    ])
  } finally {
    terminal.dispose()
  }
})
