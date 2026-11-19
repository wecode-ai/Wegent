import { useRef } from 'react'
import { DialogSurface } from './DialogSurface'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function Dialog({
  onClose,
  nestedChild = false,
  disabledField = false,
  onNestedClose = () => {},
}: {
  onClose(): void
  nestedChild?: boolean
  disabledField?: boolean
  onNestedClose?(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <DialogSurface onClose={onClose} render={<div ref={ref} tabIndex={-1} />}>
      {disabledField ? (
        <fieldset disabled>
          <input aria-label="Read only field" />
        </fieldset>
      ) : null}
      <button data-testid="first">First</button>
      <div hidden>
        <button>Hidden</button>
      </div>
      <button data-testid="last">Last</button>
      {nestedChild ? (
        <DialogSurface onClose={onNestedClose} render={<div aria-label="Nested" />}>
          <button data-testid="native-child">Native child</button>
        </DialogSurface>
      ) : null}
    </DialogSurface>
  )
}
function key(target: HTMLElement, value: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: value,
    shiftKey,
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
  return event
}

it('contains Tab in both directions, handles Escape, and restores its trigger', async () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const close = vi.fn()
  await act(async () => root.render(<Dialog onClose={close} />))
  const first = document.querySelector<HTMLElement>('[data-testid="first"]')!
  const last = document.querySelector<HTMLElement>('[data-testid="last"]')!
  expect(document.activeElement).toBe(first)
  last.focus()
  expect(key(last, 'Tab').defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(first)
  expect(key(first, 'Tab', true).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(last)
  key(last, 'Escape')
  expect(close).toHaveBeenCalledOnce()
  await act(async () => root.render(null))
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})

it('leaves keyboard handling to the nested SDK dialog', async () => {
  const close = vi.fn()
  const childClose = vi.fn()
  await act(async () =>
    root.render(<Dialog onClose={close} nestedChild onNestedClose={childClose} />)
  )
  const child = document.querySelector<HTMLElement>('[data-testid="native-child"]')!
  child.focus()
  expect(key(child, 'Tab').defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(child)
  expect(key(child, 'Escape').defaultPrevented).toBe(true)
  expect(childClose).toHaveBeenCalledOnce()
  expect(close).not.toHaveBeenCalled()
})

it('skips controls disabled by a read-only fieldset when choosing initial focus', async () => {
  await act(async () => root.render(<Dialog onClose={() => {}} disabledField />))
  expect(document.activeElement).toBe(document.querySelector('[data-testid="first"]'))
})

it('restores the trigger even when a field takes autofocus during mount', async () => {
  function AutofocusDialog() {
    const ref = useRef<HTMLDivElement>(null)
    return (
      <DialogSurface onClose={() => {}} render={<div ref={ref} />}>
        <input autoFocus />
        <button>Close</button>
      </DialogSurface>
    )
  }
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  await act(async () => root.render(<AutofocusDialog />))
  await act(async () => root.render(null))
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})
