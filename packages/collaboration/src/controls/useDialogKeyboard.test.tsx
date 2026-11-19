// @vitest-environment jsdom
import { act, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDialogKeyboard } from '../dom-events'
import { DialogSurface } from './DialogSurface'

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

it('captures a fresh opener each time the same dialog hook is reopened', async () => {
  const first = document.createElement('button')
  const second = document.createElement('button')
  document.body.append(first, second)
  function Toggle({ open }: { open: boolean }) {
    const ref = useDialogKeyboard<HTMLDivElement>(() => {}, open)
    return open ? (
      <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
        <button>Inside</button>
      </div>
    ) : null
  }
  try {
    await act(async () => root.render(<Toggle open={false} />))
    first.focus()
    await act(async () => root.render(<Toggle open />))
    expect(container.contains(document.activeElement)).toBe(true)
    await act(async () => root.render(<Toggle open={false} />))
    expect(document.activeElement).toBe(first)
    second.focus()
    await act(async () => root.render(<Toggle open />))
    await act(async () => root.render(<Toggle open={false} />))
    expect(document.activeElement).toBe(second)
  } finally {
    first.remove()
    second.remove()
  }
})

it('restores a remounted inline trigger after closing a portaled dialog', async () => {
  function Toggle({ open }: { open: boolean }) {
    const trigger = useRef<HTMLButtonElement>(null)
    const restoreTrigger = useCallback(() => trigger.current, [])
    const dialog = useDialogKeyboard<HTMLDivElement>(
      () => {},
      open,
      '[data-testid="exit"]',
      true,
      restoreTrigger
    )
    return open ? (
      createPortal(
        <div ref={dialog} role="dialog" aria-modal="true" tabIndex={-1}>
          <button data-testid="exit">Exit</button>
        </div>,
        document.body
      )
    ) : (
      <button ref={trigger} data-testid="inline">
        Open
      </button>
    )
  }
  await act(async () => root.render(<Toggle open={false} />))
  const original = container.querySelector<HTMLButtonElement>('[data-testid="inline"]')!
  original.focus()
  await act(async () => root.render(<Toggle open />))
  expect(document.activeElement).toBe(document.querySelector('[data-testid="exit"]'))
  expect(original.isConnected).toBe(false)
  await act(async () => root.render(<Toggle open={false} />))
  const remounted = container.querySelector('[data-testid="inline"]')
  expect(remounted).not.toBe(original)
  expect(document.activeElement).toBe(remounted)
  const outside = document.createElement('button')
  document.body.append(outside)
  try {
    outside.focus()
    await act(async () => root.render(<Toggle open />))
    await act(async () => root.render(<Toggle open={false} />))
    expect(document.activeElement).toBe(container.querySelector('[data-testid="inline"]'))
    await act(async () => root.render(<Toggle open />))
    outside.focus()
    await act(async () => root.render(<Toggle open={false} />))
    expect(document.activeElement).toBe(outside)
  } finally {
    outside.remove()
  }
})

it('uses an explicit fallback selector only when the original opener is gone', async () => {
  const fallback = document.createElement('button')
  fallback.dataset.testid = 'fallback-opener'
  document.body.append(fallback)
  const restore = { fallbackSelector: '[data-testid="fallback-opener"]' }
  function Toggle({ open, removeOpener = false }: { open: boolean; removeOpener?: boolean }) {
    const dialog = useDialogKeyboard<HTMLDivElement>(() => {}, open, undefined, true, restore)
    return (
      <>
        {!(open && removeOpener) && <button data-testid="opener">Open</button>}
        {open && (
          <div ref={dialog} role="dialog" tabIndex={-1}>
            <input />
          </div>
        )}
      </>
    )
  }
  try {
    await act(async () => root.render(<Toggle open={false} />))
    const original = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!
    original.focus()
    await act(async () => root.render(<Toggle open />))
    await act(async () => root.render(<Toggle open={false} />))
    expect(document.activeElement).toBe(original)
    original.focus()
    await act(async () => root.render(<Toggle open removeOpener />))
    expect(original.isConnected).toBe(false)
    await act(async () => root.render(<Toggle open={false} />))
    expect(document.activeElement).toBe(fallback)
  } finally {
    fallback.remove()
  }
})
