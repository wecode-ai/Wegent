import { afterEach, expect, test, vi } from 'vitest'
import * as desktopHost from '@/api/dsh/desktopHost'
import * as nativeKey from './native-key-acknowledgement'
import { fillNativeEditor } from './native-editor-fill'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const editor = document.createElement('div')
  editor.textContent = 'private-existing-content'
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const native = vi.spyOn(desktopHost, 'invokeDesktopHost').mockResolvedValue(undefined as never)
  vi.spyOn(nativeKey, 'sendNativeKeyAndWait').mockImplementation(
    async (_target, _phase, send, observe) => {
      observe?.('native-event')
      await send()
      observe?.('host-acknowledged')
    }
  )
  const trace = () =>
    log.mock.calls.map(([message]) => JSON.parse(String(message).replace('[desktop-e2e-key] ', '')))
  return { editor, native, trace, log }
}

test('records native fill phases without exposing editor text or an error payload', async () => {
  const { editor, native, trace, log } = fixture()
  const failure = new Error('private-host-error')
  native.mockImplementation(async method => {
    if (method === 'e2e.insertText') throw failure
    return undefined as never
  })
  await expect(
    fillNativeEditor(editor, 'private-new-text', async () => {}, 'command-123')
  ).rejects.toBe(failure)

  expect(trace().map(row => row.stage)).toEqual([
    'focus-started',
    'focus-completed',
    'select-all-started',
    'select-all-native-event',
    'select-all-host-acknowledged',
    'select-all-completed',
    'insert-text-started',
    'insert-text-failed',
  ])
  expect(trace().every(row => row.fillId === 'command-123')).toBe(true)
  expect(trace().every(row => Number.isFinite(row.elapsedMs))).toBe(true)
  expect(trace().every(row => Number.isFinite(Date.parse(row.at)))).toBe(true)
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-')
})

test('keeps multiline input serialized behind native insertion and renderer completion', async () => {
  const { editor, native, trace } = fixture()
  let inserted!: () => void
  const insertion = new Promise<void>(resolve => {
    inserted = resolve
  })
  native.mockImplementation(async method => {
    if (method === 'e2e.insertText') await insertion
    return undefined as never
  })
  let rendered!: () => void
  const renderWait = vi.fn(
    () =>
      new Promise<void>(resolve => {
        rendered = resolve
      })
  )
  const fill = fillNativeEditor(editor, 'first\r\n\r\nsecond', renderWait, 'serialized-fill')
  await vi.waitFor(() => expect(trace().at(-1)?.stage).toBe('insert-text-started'))
  expect(renderWait).not.toHaveBeenCalled()
  inserted()
  await vi.waitFor(() => expect(renderWait).toHaveBeenCalledOnce())
  expect(trace().at(-1)?.stage).toBe('render-wait-started')
  expect(native.mock.calls.filter(([, params]) => params?.key === 'Enter')).toHaveLength(0)
  renderWait.mockResolvedValue(undefined)
  rendered()
  await fill
  expect(native.mock.calls.filter(([, params]) => params?.key === 'Enter')).toHaveLength(2)
  expect(
    native.mock.calls
      .filter(([method]) => method === 'e2e.insertText')
      .map(([, params]) => params?.text)
  ).toEqual(['first', 'second'])
  expect(trace().at(-1)).toMatchObject({ stage: 'render-wait-completed', line: 2 })
})
