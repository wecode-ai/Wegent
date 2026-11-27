/** Exercise DOM composition against a real editor and record application value writes.
 * This verifies renderer behavior; it does not automate the OS candidate window.
 */
export async function composeDesktopInput(
  element: HTMLElement,
  values: string[],
  settle: () => Promise<void>
) {
  if (
    (!(element instanceof HTMLInputElement) && !element.matches('.ProseMirror[contenteditable]')) ||
    !values.length
  ) {
    throw new Error('composeInput requires an editor and at least one composition value')
  }
  const ownValue = Object.getOwnPropertyDescriptor(element, 'value')
  if (!ownValue?.get || !ownValue.set) {
    throw new Error('composeInput requires a controlled editor')
  }
  const nativeValue =
    element instanceof HTMLInputElement
      ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
      : undefined
  const editor = element as HTMLElement & { value: string }
  const writes: string[] = []
  const steps: { value: string; actual: string; focused: boolean; connected: boolean }[] = []
  Object.defineProperty(element, 'value', {
    configurable: true,
    get() {
      return ownValue.get!.call(this)
    },
    set(value: string) {
      writes.push(value)
      ownValue.set!.call(this, value)
    },
  })
  try {
    element.focus()
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    for (const value of values) {
      element.dispatchEvent(
        new CompositionEvent('compositionupdate', { bubbles: true, data: value })
      )
      if (nativeValue) nativeValue.set!.call(element, value)
      else {
        const paragraph = element.querySelector('p')
        if (!paragraph) throw new Error('The composing editor has no text paragraph')
        let text = paragraph.firstChild
        if (!(text instanceof Text)) {
          text = document.createTextNode('')
          paragraph.replaceChildren(text)
        }
        text.textContent = value
        const selection = window.getSelection()
        selection?.collapse(text, value.length)
      }
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertCompositionText',
          data: value,
          isComposing: true,
        })
      )
      await settle()
      steps.push({
        value,
        actual: editor.value,
        focused: document.activeElement === element,
        connected: element.isConnected,
      })
    }
    element.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: values.at(-1) })
    )
    await settle()
    return { writes, steps, value: editor.value }
  } finally {
    Object.defineProperty(element, 'value', ownValue)
  }
}
