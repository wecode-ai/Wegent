import { expect, test, vi } from 'vitest'

test('updates all accessible row text before measuring any row width', async () => {
  vi.useFakeTimers()
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const { Terminal } = await import('@xterm/xterm')
  const container = document.createElement('div')
  document.body.append(container)
  const terminal = new Terminal({ cols: 20, rows: 3, screenReaderMode: true })
  const measurements: string[][] = []
  const bounds = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'listitem') {
        measurements.push(
          Array.from(container.querySelectorAll('[role="listitem"]'), row => row.textContent ?? '')
        )
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 80,
        bottom: 14,
        width: 80,
        height: 14,
        toJSON() {},
      }
    })
  try {
    terminal.open(container)
    await vi.advanceTimersByTimeAsync(1100)
    measurements.length = 0
    terminal.write('first\r\nsecond\r\nthird')
    await vi.advanceTimersByTimeAsync(1100)
    expect(measurements.length).toBeGreaterThan(0)
    expect(measurements.every(rows => rows.join('|') === 'first|second|third')).toBe(true)
  } finally {
    terminal.dispose()
    container.remove()
    bounds.mockRestore()
    canvas.mockRestore()
    vi.useRealTimers()
  }
})
