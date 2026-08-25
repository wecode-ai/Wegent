import { isImeComposingEvent } from './ime'
import { isElectronRuntime } from './runtime-environment'

// Prevent macOS native text input handling from inserting U+FFFC when an arrow
// key is pressed at the start or end of a controlled input.
const ARROW_LEFT = 'ArrowLeft'
const ARROW_RIGHT = 'ArrowRight'

function isMacOsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac/i.test(navigator.userAgent || '')
}

function isNativeTextInput(
  target: EventTarget | null
): target is HTMLInputElement | HTMLTextAreaElement {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName
  return tagName === 'INPUT' || tagName === 'TEXTAREA'
}

function shouldSwallowArrowKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false
  if (event.key !== ARROW_LEFT && event.key !== ARROW_RIGHT) return false
  if (!isNativeTextInput(event.target)) return false
  if (event.isComposing || isImeComposingEvent(event)) return false

  const input = event.target
  if (input.disabled || input.readOnly) return false

  const { selectionStart, selectionEnd, value } = input
  if (selectionStart === null || selectionEnd === null) return false
  if (selectionStart !== selectionEnd) return false

  if (event.key === ARROW_LEFT && selectionStart === 0) return true
  if (event.key === ARROW_RIGHT && selectionEnd === value.length) return true
  return false
}

export function installMacOSInputArrowKeyGuard(): () => void {
  if (!isElectronRuntime() || !isMacOsPlatform()) {
    return () => undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!shouldSwallowArrowKey(event)) return
    event.preventDefault()
  }

  document.addEventListener('keydown', handleKeyDown, true)
  return () => document.removeEventListener('keydown', handleKeyDown, true)
}
