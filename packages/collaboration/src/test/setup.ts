function* ancestorsOf(element: Element): Generator<Element> {
  yield element
  if (element.parentElement) yield* ancestorsOf(element.parentElement)
}

// jsdom lacks these browser APIs; popup contracts need their DOM semantics.
if (typeof Element !== 'undefined') {
  Element.prototype.getAnimations ??= () => []
  Element.prototype.checkVisibility ??= function (this: Element) {
    if (!this.isConnected || this.closest('[hidden]')) return false
    for (const ancestor of ancestorsOf(this)) {
      const style = getComputedStyle(ancestor)
      if (style.display === 'none' || style.visibility === 'hidden') return false
    }
    return true
  }
  Element.prototype.scrollIntoView ??= function () {}
  if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'inert')) {
    Object.defineProperty(HTMLElement.prototype, 'inert', {
      configurable: true,
      get() {
        return this.hasAttribute('inert')
      },
      set(value: boolean) {
        this.toggleAttribute('inert', value)
      },
    })
  }
}
if (typeof HTMLElement !== 'undefined') {
  HTMLElement.prototype.showPopover ??= function () {}
  HTMLElement.prototype.hidePopover ??= function () {}
  document.head.append(
    Object.assign(document.createElement('style'), {
      textContent: '[popover] { display: block !important }',
    })
  )
}
if (typeof window !== 'undefined') {
  globalThis.CSS ??= {} as typeof CSS
  CSS.supports ??= () => false
  CSS.escape ??= value =>
    Array.from(
      String(value),
      character => '\\' + (character.codePointAt(0) || 0xfffd).toString(16) + ' '
    ).join('')
}
