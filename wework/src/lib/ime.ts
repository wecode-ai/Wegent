interface ImeKeyboardEventLike {
  key?: string
  isComposing?: boolean
  keyCode?: number
  which?: number
  nativeEvent?: {
    isComposing?: boolean
    keyCode?: number
    which?: number
  }
}

const IME_PROCESS_KEY_CODE = 229

export function isImeComposingEvent(event: ImeKeyboardEventLike): boolean {
  const nativeEvent = event.nativeEvent
  return Boolean(
    event.isComposing ||
    nativeEvent?.isComposing ||
    event.keyCode === IME_PROCESS_KEY_CODE ||
    event.which === IME_PROCESS_KEY_CODE ||
    nativeEvent?.keyCode === IME_PROCESS_KEY_CODE ||
    nativeEvent?.which === IME_PROCESS_KEY_CODE
  )
}

export function isImeEnterEvent(event: ImeKeyboardEventLike): boolean {
  return event.key === 'Enter' && isImeComposingEvent(event)
}
