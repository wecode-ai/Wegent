/** Exercise DOM composition against a real input and record application value writes.
 * This verifies renderer behavior; it does not automate the OS candidate window.
 */
export async function composeDesktopInput(
  element: HTMLElement,
  values: string[],
  settle: () => Promise<void>
) {
  if (!(element instanceof HTMLInputElement) || !values.length) {
    throw new Error('composeInput requires an input and at least one composition value')
  }
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
  const ownValue = Object.getOwnPropertyDescriptor(element, 'value')
  if (!ownValue?.get || !ownValue.set) {
    throw new Error('composeInput requires a React-controlled input')
  }
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
      nativeValue.set!.call(element, value)
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
        actual: element.value,
        focused: document.activeElement === element,
        connected: element.isConnected,
      })
    }
    element.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: values.at(-1) })
    )
    await settle()
    return { writes, steps, value: element.value }
  } finally {
    Object.defineProperty(element, 'value', ownValue)
  }
}
