import type { WebContents } from 'electron'
import { describe, expect, test, vi } from 'vitest'
import { sendE2EKey, sendE2EText } from './e2e-keyboard.js'

const environment = {
  WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
  VITE_WEWORK_E2E: 'true',
}

function fixture() {
  const view = {
    isDestroyed: () => false,
    isFocused: vi.fn(() => false),
    focus: vi.fn(),
    insertText: vi.fn(),
    sendInputEvent: vi.fn(),
  }
  return { view, contents: view as unknown as WebContents, focusWindow: vi.fn() }
}

describe('isolated native keyboard verification', () => {
  test.each(['key', 'text'])('preserves an already focused editor for %s input', async kind => {
    const { view, contents, focusWindow } = fixture()
    view.isFocused.mockReturnValue(true)

    if (kind === 'key') await sendE2EKey(contents, 'Meta+Shift+B', focusWindow, environment)
    else await sendE2EText(contents, 'editor text', focusWindow, environment)

    expect(focusWindow).not.toHaveBeenCalled()
    expect(view.focus).not.toHaveBeenCalled()
    if (kind === 'key') {
      expect(view.sendInputEvent.mock.calls).toEqual([
        [{ type: 'keyDown', keyCode: 'B', modifiers: ['meta', 'shift'] }],
        [{ type: 'keyUp', keyCode: 'B', modifiers: ['meta', 'shift'] }],
      ])
    } else expect(view.insertText).toHaveBeenCalledWith('editor text')
  })

  test('waits for window activation before sending native input', async () => {
    const { view, contents } = fixture()
    let activate!: () => void
    const activated = new Promise<void>(resolve => {
      activate = resolve
    })
    const input = sendE2EKey(contents, 'Enter', () => activated, environment)
    expect(view.sendInputEvent).not.toHaveBeenCalled()
    activate()
    await input
    expect(view.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode: 'Enter', modifiers: [] }],
      [{ type: 'char', keyCode: '\r', modifiers: [] }],
      [{ type: 'keyUp', keyCode: 'Enter', modifiers: [] }],
    ])
  })

  test('sends real shifted Tab events to the selected view', async () => {
    const { view, contents, focusWindow } = fixture()
    expect(await sendE2EKey(contents, 'Shift+Tab', focusWindow, environment)).toEqual({
      backend: 'electron-send-input-event',
      key: 'Shift+Tab',
      phase: 'press',
    })
    expect(focusWindow).toHaveBeenCalledOnce()
    expect(view.focus).toHaveBeenCalledOnce()
    expect(view.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] }],
      [{ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] }],
    ])
  })

  test('keeps native Space pressed until a matching key-up event', async () => {
    const { view, contents, focusWindow } = fixture()
    await sendE2EKey(contents, 'Space', focusWindow, environment, 'down')
    await sendE2EKey(contents, 'Space', focusWindow, environment, 'up')
    expect(view.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode: 'Space', modifiers: [] }],
      [{ type: 'keyUp', keyCode: 'Space', modifiers: [] }],
    ])
  })

  test('sends Space as a native key sequence including its character event', async () => {
    const { view, contents, focusWindow } = fixture()
    await sendE2EKey(contents, 'Space', focusWindow, environment)
    expect(view.sendInputEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'keyDown',
      'char',
      'keyUp',
    ])
  })

  test.each([
    ['Meta+B', 'B', ['meta']],
    ['Meta+C', 'C', ['meta']],
    ['Control+B', 'B', ['control']],
    ['Meta+Alt+B', 'B', ['meta', 'alt']],
    ['Meta+Alt+F', 'F', ['meta', 'alt']],
    ['Meta+Alt+R', 'R', ['meta', 'alt']],
    ['Meta+Alt+S', 'S', ['meta', 'alt']],
    ['Control+Alt+F', 'F', ['control', 'alt']],
    ['Control+Alt+R', 'R', ['control', 'alt']],
    ['Control+Alt+S', 'S', ['control', 'alt']],
    ['Control+Shift+M', 'M', ['control', 'shift']],
    ['Shift+PageUp', 'PageUp', ['shift']],
    ['Shift+PageDown', 'PageDown', ['shift']],
    ['Meta+W', 'W', ['meta']],
  ])('sends native shortcut %s without inserting a character', async (key, keyCode, modifiers) => {
    const { view, contents, focusWindow } = fixture()
    await sendE2EKey(contents, key as string, focusWindow, environment)
    expect(view.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode, modifiers }],
      [{ type: 'keyUp', keyCode, modifiers }],
    ])
  })

  test('can send native input without re-focusing the window', async () => {
    const { view, contents, focusWindow } = fixture()
    await sendE2EKey(contents, 'Enter', focusWindow, environment, 'press', false)
    expect(focusWindow).not.toHaveBeenCalled()
    expect(view.focus).not.toHaveBeenCalled()
    expect(view.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode: 'Enter', modifiers: [] }],
      [{ type: 'char', keyCode: '\r', modifiers: [] }],
      [{ type: 'keyUp', keyCode: 'Enter', modifiers: [] }],
    ])
  })

  test('inserts ordinary text through a native character event', async () => {
    const { view, contents, focusWindow } = fixture()
    await sendE2EKey(contents, 'x', focusWindow, environment)
    expect(view.sendInputEvent.mock.calls).toContainEqual([
      { type: 'char', keyCode: 'x', modifiers: [] },
    ])
  })

  test('inserts text through the focused native editor', async () => {
    const { view, contents, focusWindow } = fixture()
    await expect(sendE2EText(contents, '第一行', focusWindow, environment)).resolves.toEqual({
      backend: 'electron-insert-text',
      textLength: 3,
    })
    expect(focusWindow).toHaveBeenCalledOnce()
    expect(view.focus).toHaveBeenCalledOnce()
    expect(view.insertText).toHaveBeenCalledWith('第一行')
  })

  test.each([{}, { WEWORK_E2E_CONTROL_URL: environment.WEWORK_E2E_CONTROL_URL }])(
    'rejects input without both isolated controller signals',
    async value => {
      const { view, contents, focusWindow } = fixture()
      await expect(sendE2EKey(contents, 'Enter', focusWindow, value)).rejects.toThrow(
        'An isolated E2E controller is required'
      )
      expect(focusWindow).not.toHaveBeenCalled()
      expect(view.sendInputEvent).not.toHaveBeenCalled()
    }
  )

  test.each(['Meta+Q', 'Control+Q', 'constructor', 'text', 'Unknown+B'])(
    'rejects unsupported key %s',
    async key => {
      const { view, contents, focusWindow } = fixture()
      await expect(sendE2EKey(contents, key, focusWindow, environment)).rejects.toThrow(
        'Unsupported verification key'
      )
      expect(view.sendInputEvent).not.toHaveBeenCalled()
      expect(focusWindow).not.toHaveBeenCalled()
    }
  )
})
