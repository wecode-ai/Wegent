import type { KeyboardInputEvent, WebContents } from 'electron'
import { HostCapabilityError } from './capability-router.js'

const KEYS: Record<string, string> = {
  Tab: 'Tab',
  'Shift+Tab': 'Tab',
  Enter: 'Enter',
  Space: 'Space',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}

export async function sendE2EKey(
  contents: WebContents,
  key: string,
  focusWindow: () => void | Promise<void>,
  environment: NodeJS.ProcessEnv = process.env
) {
  if (!environment.WEWORK_E2E_CONTROL_URL || environment.VITE_WEWORK_E2E !== 'true') {
    throw new HostCapabilityError('e2e_control_required', 'An isolated E2E controller is required')
  }
  const keyCode = Object.hasOwn(KEYS, key) ? KEYS[key] : undefined
  if (!keyCode) throw new HostCapabilityError('e2e_invalid_key', 'Unsupported verification key')
  if (contents.isDestroyed()) {
    throw new HostCapabilityError('e2e_view_unavailable', 'Verification view is unavailable')
  }
  const modifiers: KeyboardInputEvent['modifiers'] = key === 'Shift+Tab' ? ['shift'] : []
  await focusWindow()
  contents.focus()
  contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  // Chromium activates native buttons on Enter's character event.
  const character = key === 'Space' ? ' ' : key === 'Enter' ? '\r' : null
  if (character) contents.sendInputEvent({ type: 'char', keyCode: character, modifiers })
  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  return { backend: 'electron-send-input-event', key }
}
