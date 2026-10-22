import { describe, expect, it } from 'vitest'
import { readRendererProcesses } from './electron-metrics.js'

function contents(id: number, pid: number, title: string) {
  return {
    id,
    getOSProcessId: () => pid,
    getTitle: () => title,
  }
}

describe('renderer process labels', () => {
  it('labels each renderer pid once and accepts an explicit label', () => {
    const processes = readRendererProcesses(
      [
        contents(1, 200, 'Task — Refactor'),
        contents(2, 200, 'Duplicate'),
        contents(3, 300, 'Browser: docs'),
      ],
      entry => (entry.id === 3 ? 'Embedded browser: docs' : '')
    )

    expect(processes).toEqual([
      { pid: 200, label: 'Task — Refactor' },
      { pid: 300, label: 'Embedded browser: docs' },
    ])
  })

  it('skips contents without an OS process and falls back to a generic label', () => {
    const processes = readRendererProcesses([contents(1, 0, 'Nope'), contents(2, 400, '')])
    expect(processes).toEqual([{ pid: 400, label: 'Window' }])
  })
})
