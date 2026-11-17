// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDialogKeyboard } from './useDialogKeyboard'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
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
  nativeChild = false,
  disabledField = false,
}: {
  onClose(): void
  nativeChild?: boolean
  disabledField?: boolean
}) {
  const ref = useDialogKeyboard<HTMLDivElement>(onClose)
  return (
    <div ref={ref} role="dialog" tabIndex={-1}>
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
      {nativeChild ? (
        <dialog open>
          <button data-testid="native-child">Native child</button>
        </dialog>
      ) : null}
    </div>
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
  const first = container.querySelector<HTMLElement>('[data-testid="first"]')!
  const last = container.querySelector<HTMLElement>('[data-testid="last"]')!
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

it('leaves keyboard handling to an open native child dialog', async () => {
  const close = vi.fn()
  await act(async () => root.render(<Dialog onClose={close} nativeChild />))
  const child = container.querySelector<HTMLElement>('[data-testid="native-child"]')!
  child.focus()
  expect(key(child, 'Tab').defaultPrevented).toBe(false)
  expect(key(child, 'Escape').defaultPrevented).toBe(false)
  expect(close).not.toHaveBeenCalled()
})

it('skips controls disabled by a read-only fieldset when choosing initial focus', async () => {
  await act(async () => root.render(<Dialog onClose={() => {}} disabledField />))
  expect(document.activeElement).toBe(container.querySelector('[data-testid="first"]'))
})

it('restores the trigger even when a field takes autofocus during mount', async () => {
  function AutofocusDialog() {
    const ref = useDialogKeyboard<HTMLDivElement>(() => {})
    return (
      <div ref={ref} role="dialog">
        <input autoFocus />
        <button>Close</button>
      </div>
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
