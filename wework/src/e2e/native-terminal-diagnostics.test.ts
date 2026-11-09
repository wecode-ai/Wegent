import { beforeEach, expect, test, vi } from 'vitest'
import type { NativeTerminalElement } from './native-terminal-diagnostics'

beforeEach(() => {
  document.body.innerHTML = ''
  vi.resetModules()
})

test('records buffer positions and native key metadata without terminal contents', async () => {
  const { getNativeTerminalDiagnostics, recordNativeTerminalKey } =
    await import('./native-terminal-diagnostics')
  document.body.innerHTML = `
    <section data-testid="background-terminal-output-panel">
      <div role="region">
        <div class="xterm-accessibility-tree">
          <div role="listitem" aria-posinset="11" aria-setsize="55">private output</div>
        </div>
        <textarea class="xterm-helper-textarea"></textarea>
      </div>
    </section>`
  const region = document.querySelector<NativeTerminalElement>('[role="region"]')!
  region.__weworkViewportForE2E = () => ({ viewportY: 65, baseY: 100, length: 145, rows: 45 })
  const textarea = document.querySelector('textarea')!
  textarea.focus()
  recordNativeTerminalKey(
    'native-event',
    'Shift+PageUp',
    textarea,
    new KeyboardEvent('keydown', { key: 'PageUp', shiftKey: true })
  )
  const snapshot = getNativeTerminalDiagnostics()
  expect(snapshot.samples[0]).toMatchObject({
    targetFocused: true,
    firstRow: '11',
    buffer: { viewportY: 65 },
    event: { key: 'PageUp', shiftKey: true, isTrusted: false },
  })
  expect(JSON.stringify(snapshot)).not.toContain('private output')
})

test('bounds the trace and ignores keys unrelated to terminal paging', async () => {
  const { getNativeTerminalDiagnostics, recordNativeTerminalKey } =
    await import('./native-terminal-diagnostics')
  recordNativeTerminalKey('ignored', 'Enter', null)
  expect(getNativeTerminalDiagnostics().samples).toHaveLength(0)
  for (let index = 0; index < 110; index += 1) {
    recordNativeTerminalKey(String(index), 'Shift+PageDown', null)
  }
  expect(getNativeTerminalDiagnostics().samples).toHaveLength(100)
  expect(getNativeTerminalDiagnostics().samples[0]).toMatchObject({ phase: '10', buffer: null })
})
