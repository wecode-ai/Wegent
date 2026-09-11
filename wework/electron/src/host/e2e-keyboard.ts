import type { KeyboardInputEvent, WebContents } from 'electron'
import { HostCapabilityError } from './capability-router.js'

const KEYS: Record<string, string> = {
  Tab: 'Tab',
  Enter: 'Enter',
  Space: 'Space',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  A: 'A',
  B: 'B',
  M: 'M',
  T: 'T',
  x: 'x',
}

const MODIFIERS: Record<string, 'shift' | 'control' | 'alt' | 'meta'> = {
  Shift: 'shift',
  Control: 'control',
  Alt: 'alt',
  Meta: 'meta',
}

export type E2EKeyPhase = 'press' | 'down' | 'up'

export async function sendE2EKey(
  contents: WebContents,
  key: string,
  focusWindow: () => void | Promise<void>,
  environment: NodeJS.ProcessEnv = process.env,
  phase: E2EKeyPhase = 'press'
) {
  if (!environment.WEWORK_E2E_CONTROL_URL || environment.VITE_WEWORK_E2E !== 'true') {
    throw new HostCapabilityError('e2e_control_required', 'An isolated E2E controller is required')
  }
  const parts = key.split('+')
  const mainKey = parts.pop() ?? ''
  const keyCode = Object.hasOwn(KEYS, mainKey) ? KEYS[mainKey] : undefined
  if (!keyCode || parts.some(part => !Object.hasOwn(MODIFIERS, part))) {
    throw new HostCapabilityError('e2e_invalid_key', 'Unsupported verification key')
  }
  if (contents.isDestroyed()) {
    throw new HostCapabilityError('e2e_view_unavailable', 'Verification view is unavailable')
  }
  const modifiers: KeyboardInputEvent['modifiers'] = parts.map(part => MODIFIERS[part])
  await focusWindow()
  contents.focus()
  if (phase !== 'up') {
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  }
  // Chromium activates native buttons on Enter's character event.
  const character =
    mainKey === 'Space' ? ' ' : mainKey === 'Enter' ? '\r' : mainKey.length === 1 ? mainKey : null
  if (phase === 'press' && character && parts.every(part => part === 'Shift')) {
    contents.sendInputEvent({ type: 'char', keyCode: character, modifiers })
  }
  if (phase !== 'down') {
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  return { backend: 'electron-send-input-event', key, phase }
}
