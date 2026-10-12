import type { WebContents } from 'electron'
import { describe, expect, test, vi } from 'vitest'
import { sendE2EKey, sendE2EText, setE2EReducedMotion } from './e2e-keyboard.js'

const environment = {
  WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
  VITE_WEWORK_E2E: 'true',
}

function fixture() {
  const view = {
    isDestroyed: () => false,
    focus: vi.fn(),
    insertText: vi.fn(),
    sendInputEvent: vi.fn(),
    debugger: {
      isAttached: vi.fn(() => false),
      attach: vi.fn(),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    },
  }
  return { view, contents: view as unknown as WebContents, focusWindow: vi.fn() }
}

describe('isolated native keyboard verification', () => {
  test('sets real Chromium motion preferences and reuses the attached debugger', async () => {
    const { view, contents } = fixture()
    await expect(setE2EReducedMotion(contents, false, environment)).resolves.toEqual({
      reduced: false,
    })
    expect(view.debugger.attach).toHaveBeenCalledExactlyOnceWith('1.3')
    expect(view.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })
    view.debugger.isAttached.mockReturnValue(true)
    await setE2EReducedMotion(contents, true, environment)
    expect(view.debugger.attach).toHaveBeenCalledTimes(1)
    expect(view.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
  })

  test('motion verification requires an isolated controller and propagates Chromium errors', async () => {
    const { view, contents } = fixture()
    await expect(setE2EReducedMotion(contents, false, {})).rejects.toThrow('isolated E2E')
    expect(view.debugger.attach).not.toHaveBeenCalled()
    view.debugger.sendCommand.mockRejectedValue(new Error('Chromium command failed'))
    await expect(setE2EReducedMotion(contents, false, environment)).rejects.toThrow(
      'Chromium command failed'
    )
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
    ['Control+Shift+M', 'M', ['control', 'shift']],
  ])('sends native shortcut %s without inserting a character', async (key, keyCode, modifiers) => {
    const { view, contents, focusWindow } = fixture()
    await sendE2EKey(contents, key as string, focusWindow, environment)
    expect(view.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode, modifiers }],
      [{ type: 'keyUp', keyCode, modifiers }],
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

  test.each(['Meta+Q', 'Control+W', 'constructor', 'text', 'Unknown+B'])(
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
