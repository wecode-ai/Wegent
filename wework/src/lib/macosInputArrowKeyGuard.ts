import { isImeComposingEvent } from './ime'
import { isTauriRuntime } from './runtime-environment'

// Work around a macOS WKWebView/Tauri bug where arrow keys at the start/end of
// a native text input leak through AppKit's insertText: path and insert U+FFFC
// (object replacement character) / tofu glyphs. See tauri-apps/tauri#5685.
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
  if (!isTauriRuntime() || !isMacOsPlatform()) {
    return () => undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!shouldSwallowArrowKey(event)) return
    event.preventDefault()
  }

  document.addEventListener('keydown', handleKeyDown, true)
  return () => document.removeEventListener('keydown', handleKeyDown, true)
}
