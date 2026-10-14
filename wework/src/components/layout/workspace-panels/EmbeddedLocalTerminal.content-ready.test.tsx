import { act, render } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { connectLocalTerminal } from '@/lib/local-terminal'
import { EmbeddedLocalTerminal } from './EmbeddedLocalTerminal'

const terminal = vi.hoisted(() => ({ callbacks: [] as (() => void)[], write: vi.fn() }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    rows = 24
    cols = 80
    options = {}
    loadAddon() {}
    open() {}
    dispose() {}
    refresh() {}
    onData() {
      return { dispose() {} }
    }
    onTitleChange() {
      return { dispose() {} }
    }
    write(data: string, callback?: () => void) {
      terminal.write(data)
      if (callback) terminal.callbacks.push(callback)
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock('@/lib/local-terminal', () => ({
  connectLocalTerminal: vi.fn(),
  resizeLocalTerminal: vi.fn(),
  writeLocalTerminal: vi.fn(),
}))
vi.mock('@/lib/xterm-theme', () => ({
  applyTerminalTheme: vi.fn(),
  getTerminalTheme: () => ({}),
  observeTerminalTheme: () => () => {},
}))
vi.mock('@/lib/runtime-terminal-context', () => ({ appendRuntimeTerminalContext: vi.fn() }))
vi.mock('./xtermLinks', () => ({ createXtermWebLinksAddon: () => ({}) }))
vi.mock('./xtermSelectionGuard', () => ({ installXtermSelectionGuard: () => ({ dispose() {} }) }))
vi.mock('./xtermTextDrag', () => ({ installXtermTextDrag: () => ({ dispose() {} }) }))
vi.mock('./xtermInputFallback', () => ({
  installXtermInputFallback: () => ({ noteData() {}, dispose() {} }),
}))
vi.mock('./xtermMacKeybindings', () => ({ installXtermMacKeybindings: vi.fn() }))
vi.mock('./xtermRenderRecovery', () => ({
  refreshXterm: vi.fn(),
  logXtermRenderState: vi.fn(),
  installXtermRenderRecovery: () => () => {},
}))

beforeEach(() => {
  terminal.callbacks = []
  terminal.write.mockClear()
  vi.mocked(connectLocalTerminal).mockReset()
})

test('waits for restored terminal snapshot output to finish writing before reporting content ready', async () => {
  vi.mocked(connectLocalTerminal).mockResolvedValue(() => {})
  const ready = vi.fn()
  render(
    <EmbeddedLocalTerminal sessionId="restored-harness" active={false} onContentReady={ready} />
  )
  expect(ready).not.toHaveBeenCalled()
  const output = vi.mocked(connectLocalTerminal).mock.calls[0][1]
  act(() =>
    output(
      { session_id: 'restored-harness', sequence: 1, data: 'Restored terminal snapshot' },
      'snapshot'
    )
  )
  expect(terminal.write).toHaveBeenCalledWith('Restored terminal snapshot')
  expect(ready).not.toHaveBeenCalled()
  act(() => terminal.callbacks.shift()?.())
  expect(ready).toHaveBeenCalledOnce()
})

test('reports a terminal connection error only after its recovery text has finished writing', async () => {
  vi.mocked(connectLocalTerminal).mockRejectedValue(new Error('Synthetic connection failure'))
  const ready = vi.fn()
  render(<EmbeddedLocalTerminal sessionId="failed-harness" active={false} onContentReady={ready} />)
  await act(async () => {
    await Promise.resolve()
  })
  expect(terminal.write).toHaveBeenCalledWith('\r\n[Terminal connection failed]\r\n')
  expect(ready).not.toHaveBeenCalled()
  act(() => terminal.callbacks.shift()?.())
  expect(ready).toHaveBeenCalledOnce()
})
