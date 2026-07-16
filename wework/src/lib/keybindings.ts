import { isTauriRuntime } from './runtime-environment'
import { navigateTo } from './navigation'

export const OPEN_TERMINAL_COMMAND = 'openTerminal'
export const OPEN_SETTINGS_COMMAND = 'openSettings'
export const GO_BACK_COMMAND = 'goBack'
export const GO_FORWARD_COMMAND = 'goForward'
export const TOGGLE_SIDEBAR_COMMAND = 'toggleSidebar'
export const TOGGLE_SIDE_PANEL_COMMAND = 'toggleSidePanel'
export const TOGGLE_MODEL_SELECTOR_COMMAND = 'toggleModelSelector'
export const WEWORK_OPEN_TERMINAL_EVENT = 'wework:open-terminal'
export const KEYBINDINGS_CHANGED_EVENT = 'wework:keybindings-changed'
export const ACTIVE_KEYBINDINGS_CHANGED_EVENT = 'wework:active-keybindings-changed'
export const TOGGLE_BOTTOM_WORKSPACE_PANEL_BUTTON_TEST_ID = 'toggle-bottom-workspace-panel-button'
export const TOGGLE_RIGHT_WORKSPACE_PANEL_BUTTON_TEST_ID = 'toggle-right-workspace-panel-button'
export const MODEL_SELECTOR_BUTTON_TEST_ID = 'model-selector-button'

export interface KeybindingOverride {
  command: string
  key: string | null
}

export interface KeybindingCommand {
  command: string
  defaultKey: string
  secondaryKeys?: string[]
}

export const DEFAULT_KEYBINDINGS: KeybindingCommand[] = [
  {
    command: OPEN_TERMINAL_COMMAND,
    defaultKey: 'Command+J',
  },
  {
    command: OPEN_SETTINGS_COMMAND,
    defaultKey: 'Command+,',
  },
  {
    command: GO_BACK_COMMAND,
    defaultKey: 'Command+[',
    secondaryKeys: ['Mouse Back'],
  },
  {
    command: GO_FORWARD_COMMAND,
    defaultKey: 'Command+]',
    secondaryKeys: ['Mouse Forward'],
  },
  {
    command: TOGGLE_SIDEBAR_COMMAND,
    defaultKey: 'Command+B',
  },
  {
    command: TOGGLE_SIDE_PANEL_COMMAND,
    defaultKey: 'Alt+Command+B',
  },
  {
    command: TOGGLE_MODEL_SELECTOR_COMMAND,
    defaultKey: 'Control+Shift+M',
  },
]

let activeKeybindings = mergeKeybindings([])

export function mergeKeybindings(overrides: KeybindingOverride[]): Record<string, string | null> {
  const merged = new Map<string, string | null>(
    DEFAULT_KEYBINDINGS.map(item => [item.command, normalizeKeybinding(item.defaultKey)])
  )
  overrides.forEach(item => {
    if (!item.command) return
    merged.set(item.command, item.key ? normalizeKeybinding(item.key) : null)
  })
  return Object.fromEntries(merged.entries())
}

export function normalizeKeybinding(value: string): string {
  const parts = value
    .split('+')
    .map(part => normalizeKeyPart(part.trim()))
    .filter(Boolean)
  const key = parts.pop()
  if (!key) return ''

  const modifiers = ['Control', 'Alt', 'Shift', 'Command'].filter(modifier =>
    parts.includes(modifier)
  )
  return [...modifiers, key].join('+')
}

export function keybindingFromKeyboardEvent(event: KeyboardEvent): string {
  const key = normalizeKeyPart(event.key)
  return [
    event.ctrlKey ? 'Control' : null,
    event.altKey ? 'Alt' : null,
    event.shiftKey ? 'Shift' : null,
    event.metaKey ? 'Command' : null,
    key && !['Command', 'Control', 'Alt', 'Shift'].includes(key) ? key : null,
  ]
    .filter(Boolean)
    .join('+')
}

export function setActiveKeybindings(
  overrides: KeybindingOverride[]
): Record<string, string | null> {
  activeKeybindings = mergeKeybindings(overrides)
  window.dispatchEvent(new CustomEvent(ACTIVE_KEYBINDINGS_CHANGED_EVENT))
  return activeKeybindings
}

export function getActiveKeybinding(command: string): string | null {
  return activeKeybindings[command] ?? null
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.xterm')) return false
  const tagName = target.tagName.toLowerCase()
  return (
    target.isContentEditable ||
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select'
  )
}

export function dispatchOpenTerminalShortcut() {
  const toggleButton = document.querySelector<HTMLButtonElement>(
    `[data-testid="${TOGGLE_BOTTOM_WORKSPACE_PANEL_BUTTON_TEST_ID}"]`
  )
  if (toggleButton && !toggleButton.disabled) {
    toggleButton.click()
    return
  }

  window.dispatchEvent(new CustomEvent(WEWORK_OPEN_TERMINAL_EVENT))
}

export function dispatchOpenSettingsShortcut() {
  navigateTo('/settings')
}

export function dispatchGoBackShortcut() {
  window.history.back()
}

export function dispatchGoForwardShortcut() {
  window.history.forward()
}

export function dispatchToggleSidebarShortcut() {
  const toggleButton = document.querySelector<HTMLButtonElement>(
    '[data-testid="collapse-sidebar-button"], [data-testid="expand-sidebar-button"]'
  )
  if (toggleButton && !toggleButton.disabled) {
    toggleButton.click()
  }
}

export function dispatchToggleSidePanelShortcut() {
  const toggleButton = document.querySelector<HTMLButtonElement>(
    `[data-testid="${TOGGLE_RIGHT_WORKSPACE_PANEL_BUTTON_TEST_ID}"]`
  )
  if (toggleButton && !toggleButton.disabled) {
    toggleButton.click()
  }
}

export function dispatchToggleModelSelectorShortcut() {
  const activePaneButton = document.querySelector<HTMLButtonElement>(
    `[data-active-workbench-pane="true"] [data-testid="${MODEL_SELECTOR_BUTTON_TEST_ID}"]`
  )
  const button =
    activePaneButton ??
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        `[data-testid="${MODEL_SELECTOR_BUTTON_TEST_ID}"]`
      )
    ).find(candidate => !candidate.disabled && candidate.getAttribute('aria-hidden') !== 'true')
  if (button && !button.disabled) button.click()
}

export function shortcutsAvailable(): boolean {
  return isTauriRuntime()
}

function normalizeKeyPart(value: string): string {
  const lower = value.toLowerCase()
  if (['cmd', 'command', 'meta', '⌘'].includes(lower)) return 'Command'
  if (['ctrl', 'control', '⌃'].includes(lower)) return 'Control'
  if (['alt', 'option', 'opt', '⌥'].includes(lower)) return 'Alt'
  if (['shift', '⇧'].includes(lower)) return 'Shift'
  if (lower === ' ') return 'Space'
  if (lower === 'escape') return 'Esc'
  if (value.length === 1) return value.toUpperCase()
  return value
}
