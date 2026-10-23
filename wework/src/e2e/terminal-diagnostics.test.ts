import type { Terminal } from '@xterm/xterm'
import { afterEach, expect, it, vi } from 'vitest'
import { observeTerminalDiagnostics, traceTerminal } from './terminal-diagnostics'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('does not inspect or subscribe to terminals outside isolated verification', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'false')
  const terminal = {} as Terminal
  expect(() => observeTerminalDiagnostics(terminal)()).not.toThrow()
  expect(() => traceTerminal(terminal, 'written')).not.toThrow()
})

it('observes navigation without intercepting keys or recording input and cleans up pending observations', async () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const textarea = document.createElement('textarea')
  textarea.value = 'private terminal input'
  const disposeScroll = vi.fn()
  const disposeWrite = vi.fn()
  const terminal = {
    rows: 20,
    cols: 80,
    buffer: { active: { baseY: 40, viewportY: 20 } },
    textarea,
    onScroll: vi.fn(() => ({ dispose: disposeScroll })),
    onWriteParsed: vi.fn(() => ({ dispose: disposeWrite })),
  } as unknown as Terminal
  const dispose = observeTerminalDiagnostics(terminal)
  const before = log.mock.calls.length
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }))
  expect(log).toHaveBeenCalledTimes(before)
  const event = new KeyboardEvent('keydown', { key: 'PageUp', shiftKey: true, cancelable: true })
  textarea.dispatchEvent(event)
  await Promise.resolve()
  expect(event.defaultPrevented).toBe(false)
  expect(terminal.buffer.active.viewportY).toBe(20)
  expect(log.mock.calls.some(call => String(call[0]).includes('key-handled'))).toBe(true)
  expect(JSON.stringify(log.mock.calls)).not.toContain(textarea.value)
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }))
  dispose()
  const afterDispose = log.mock.calls.length
  await Promise.resolve()
  textarea.dispatchEvent(event)
  expect(log).toHaveBeenCalledTimes(afterDispose)
  expect(disposeScroll).toHaveBeenCalledOnce()
  expect(disposeWrite).toHaveBeenCalledOnce()
})
