import { beforeEach, describe, expect, it } from 'vitest'
import {
  OPEN_SETTINGS_COMMAND,
  OPEN_TERMINAL_COMMAND,
  TOGGLE_SIDEBAR_COMMAND,
  TOGGLE_SIDE_PANEL_COMMAND,
  TOGGLE_MODEL_SELECTOR_COMMAND,
  isEditableShortcutTarget,
  dispatchOpenSettingsShortcut,
  dispatchOpenTerminalShortcut,
  dispatchToggleModelSelectorShortcut,
  keybindingFromKeyboardEvent,
  mergeKeybindings,
  normalizeKeybinding,
  TOGGLE_BOTTOM_WORKSPACE_PANEL_BUTTON_TEST_ID,
  WEWORK_OPEN_TERMINAL_EVENT,
  MODEL_SELECTOR_BUTTON_TEST_ID,
  INCREASE_FONT_SIZE_COMMAND,
  DECREASE_FONT_SIZE_COMMAND,
  RESET_FONT_SIZE_COMMAND,
} from './keybindings'

describe('keybindings', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
  })

  it('normalizes equivalent modifier names', () => {
    expect(normalizeKeybinding('cmd+shift+j')).toBe('Shift+Command+J')
    expect(normalizeKeybinding('Ctrl+Option+`')).toBe('Control+Alt+`')
  })

  it('merges defaults with overrides and clears', () => {
    expect(mergeKeybindings([])[OPEN_TERMINAL_COMMAND]).toBe('Command+J')
    expect(mergeKeybindings([])[OPEN_SETTINGS_COMMAND]).toBe('Command+,')
    expect(mergeKeybindings([])[TOGGLE_SIDEBAR_COMMAND]).toBe('Command+B')
    expect(mergeKeybindings([])[TOGGLE_SIDE_PANEL_COMMAND]).toBe('Alt+Command+B')
    expect(mergeKeybindings([])[TOGGLE_MODEL_SELECTOR_COMMAND]).toBe('Control+Shift+M')
    expect(mergeKeybindings([])[INCREASE_FONT_SIZE_COMMAND]).toBe('Command+Plus')
    expect(mergeKeybindings([])[DECREASE_FONT_SIZE_COMMAND]).toBe('Command+Minus')
    expect(mergeKeybindings([])[RESET_FONT_SIZE_COMMAND]).toBe('Command+0')
    expect(
      mergeKeybindings([{ command: OPEN_TERMINAL_COMMAND, key: 'Control+J' }])[
        OPEN_TERMINAL_COMMAND
      ]
    ).toBe('Control+J')
    expect(
      mergeKeybindings([{ command: OPEN_TERMINAL_COMMAND, key: null }])[OPEN_TERMINAL_COMMAND]
    ).toBeNull()
  })

  it('creates keybindings from keyboard events', () => {
    const event = new KeyboardEvent('keydown', {
      key: 'j',
      metaKey: true,
      shiftKey: true,
    })

    expect(keybindingFromKeyboardEvent(event)).toBe('Shift+Command+J')
    expect(
      keybindingFromKeyboardEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true }))
    ).toBe('Command+,')
    expect(
      keybindingFromKeyboardEvent(
        new KeyboardEvent('keydown', { key: 'b', metaKey: true, altKey: true })
      )
    ).toBe('Alt+Command+B')
    expect(
      keybindingFromKeyboardEvent(
        new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true })
      )
    ).toBe('Control+Shift+M')
    expect(
      keybindingFromKeyboardEvent(
        new KeyboardEvent('keydown', { key: '+', metaKey: true, shiftKey: true })
      )
    ).toBe('Command+Plus')
    expect(
      keybindingFromKeyboardEvent(new KeyboardEvent('keydown', { key: '=', metaKey: true }))
    ).toBe('Command+Plus')
    expect(
      keybindingFromKeyboardEvent(new KeyboardEvent('keydown', { key: '-', metaKey: true }))
    ).toBe('Command+Minus')
  })

  it('detects editable shortcut targets', () => {
    expect(isEditableShortcutTarget(document.createElement('input'))).toBe(true)
    expect(isEditableShortcutTarget(document.createElement('button'))).toBe(false)

    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const terminalTextarea = document.createElement('textarea')
    terminal.appendChild(terminalTextarea)
    expect(isEditableShortcutTarget(terminalTextarea)).toBe(false)
  })

  it('uses the existing bottom panel toggle button when available', () => {
    const button = document.createElement('button')
    const clickEvents: string[] = []
    const handleShortcutEvent = () => clickEvents.push('event')
    button.setAttribute('data-testid', TOGGLE_BOTTOM_WORKSPACE_PANEL_BUTTON_TEST_ID)
    button.addEventListener('click', () => clickEvents.push('click'))
    window.addEventListener(WEWORK_OPEN_TERMINAL_EVENT, handleShortcutEvent)
    document.body.appendChild(button)

    dispatchOpenTerminalShortcut()

    expect(clickEvents).toEqual(['click'])
    button.remove()
    window.removeEventListener(WEWORK_OPEN_TERMINAL_EVENT, handleShortcutEvent)
  })

  it('opens settings through history navigation', () => {
    const originalPath = window.location.pathname
    let popStateCount = 0
    const handlePopState = () => {
      popStateCount += 1
    }
    window.addEventListener('popstate', handlePopState)

    dispatchOpenSettingsShortcut()

    expect(window.location.pathname).toBe('/settings')
    expect(popStateCount).toBe(1)
    window.history.pushState({}, '', originalPath)
    window.removeEventListener('popstate', handlePopState)
  })

  it('toggles the model selector in the active workbench pane', () => {
    const inactivePane = document.createElement('div')
    inactivePane.dataset.activeWorkbenchPane = 'false'
    const inactiveButton = document.createElement('button')
    inactiveButton.dataset.testid = MODEL_SELECTOR_BUTTON_TEST_ID
    inactivePane.appendChild(inactiveButton)

    const activePane = document.createElement('div')
    activePane.dataset.activeWorkbenchPane = 'true'
    const activeButton = document.createElement('button')
    activeButton.dataset.testid = MODEL_SELECTOR_BUTTON_TEST_ID
    let clickCount = 0
    activeButton.addEventListener('click', () => {
      clickCount += 1
    })
    activePane.appendChild(activeButton)
    document.body.append(inactivePane, activePane)

    dispatchToggleModelSelectorShortcut()

    expect(clickCount).toBe(1)
    inactivePane.remove()
    activePane.remove()
  })
})
