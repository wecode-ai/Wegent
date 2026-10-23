import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { NativeTerminalElement } from '@/e2e/native-terminal-diagnostics'
import type { BackgroundTerminal } from '../backgroundTerminals'
import { BackgroundTerminalPanel } from './BackgroundTerminalPanel'

const records = vi.hoisted(() => ({
  instances: [] as {
    write: ReturnType<typeof vi.fn>
    reset: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    options: Record<string, unknown>
  }[],
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    write = vi.fn()
    reset = vi.fn()
    dispose = vi.fn()
    open = vi.fn()
    loadAddon = vi.fn()
    buffer = { active: { viewportY: 10, baseY: 20, length: 65 } }
    rows = 45
    constructor(public options: Record<string, unknown>) {
      records.instances.push(this)
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))
vi.mock('./xtermLinks', () => ({ createXtermWebLinksAddon: () => ({}) }))

function terminal(output: string): BackgroundTerminal {
  return {
    id: 'command-1',
    tabId: 'background-terminal:task-1:command-1',
    command: 'pnpm dev',
    cwd: '/project',
    running: true,
    background: true,
    block: {
      id: 'command-1',
      subtaskId: 'turn-1',
      type: 'tool',
      toolName: 'bash',
      status: 'streaming',
      createdAt: 1,
      toolOutput: output,
    },
  }
}

beforeEach(() => {
  records.instances = []
})
afterEach(() => vi.unstubAllEnvs())

describe('BackgroundTerminalPanel', () => {
  test('exposes only a read-only viewport snapshot in E2E builds and removes it on disposal', () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    const { container, unmount } = render(
      <BackgroundTerminalPanel terminal={terminal('ready\n')} active />
    )
    const region = container.querySelector<NativeTerminalElement>('[role="region"]')!
    expect(region.__weworkViewportForE2E?.()).toEqual({
      viewportY: 10,
      baseY: 20,
      length: 65,
      rows: 45,
    })
    unmount()
    expect(region.__weworkViewportForE2E).toBeUndefined()
  })

  test('does not expose the diagnostic bridge in normal builds', () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'false')
    const { container } = render(<BackgroundTerminalPanel terminal={terminal('ready\n')} active />)
    expect(
      container.querySelector<NativeTerminalElement>('[role="region"]')?.__weworkViewportForE2E
    ).toBeUndefined()
  })

  test('appends live output once across tab switches and resets when the bounded output changes', () => {
    const { rerender, unmount } = render(
      <BackgroundTerminalPanel terminal={terminal('ready\n')} active />
    )
    const xterm = records.instances[0]
    expect(xterm.options.disableStdin).toBe(true)
    expect(xterm.write).toHaveBeenCalledWith('ready\n')
    rerender(<BackgroundTerminalPanel terminal={terminal('ready\nlistening\n')} active />)
    expect(xterm.write).toHaveBeenLastCalledWith('listening\n')
    rerender(<BackgroundTerminalPanel terminal={terminal('ready\nlistening\n')} active={false} />)
    rerender(<BackgroundTerminalPanel terminal={terminal('ready\nlistening\n')} active />)
    expect(xterm.write.mock.calls.map(([text]) => text).join('')).toBe('ready\nlistening\n')
    expect(xterm.reset).not.toHaveBeenCalled()
    rerender(<BackgroundTerminalPanel terminal={terminal('new tail\n')} active />)
    expect(xterm.reset).toHaveBeenCalledOnce()
    expect(xterm.write).toHaveBeenLastCalledWith('new tail\n')
    unmount()
    expect(xterm.dispose).toHaveBeenCalledOnce()
  })

  test('shows the reference app placeholder before output arrives', () => {
    const { rerender } = render(<BackgroundTerminalPanel terminal={terminal('')} active />)
    expect(screen.getByText('暂无输出')).toBeInTheDocument()
    expect(records.instances).toHaveLength(0)
    rerender(<BackgroundTerminalPanel terminal={terminal('first output')} active />)
    expect(screen.queryByText('暂无输出')).toBeNull()
    expect(records.instances[0].write).toHaveBeenCalledWith('first output')
  })
})
