// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HoverEditableText } from './HoverEditableText'

let root: Root
let container: HTMLDivElement
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

it.each([
  { multiline: false, key: 'Enter' },
  { multiline: false, key: 'Escape' },
  { multiline: true, key: 'Escape' },
])(
  'restores an explicit $key exit from multiline=$multiline without leaving the dialog',
  async ({ multiline, key }) => {
    const parentKeyDown = vi.fn()
    await act(async () =>
      root.render(
        <section onKeyDown={parentKeyDown}>
          <HoverEditableText
            value="Draft"
            ariaLabel="Edit draft"
            multiline={multiline}
            onChange={vi.fn()}
          />
        </section>
      )
    )
    await act(async () => container.querySelector('button')!.click())
    const editor = container.querySelector('input, textarea')!
    expect(document.activeElement).toBe(editor)
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    })
    await act(async () => {
      editor.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(parentKeyDown).not.toHaveBeenCalled()
    expect(container.querySelector('input, textarea')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('button'))
  }
)

it('preserves multiline Enter and lets blur move focus to the next control', async () => {
  await act(async () =>
    root.render(
      <>
        <HoverEditableText value="Draft" ariaLabel="Edit draft" onChange={vi.fn()} />
        <button data-testid="next">Next</button>
      </>
    )
  )
  await act(async () => container.querySelector('button')!.click())
  const editor = container.querySelector('textarea')!
  const enter = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  })
  await act(async () => {
    editor.dispatchEvent(enter)
  })
  expect(enter.defaultPrevented).toBe(false)
  expect(document.activeElement).toBe(editor)
  const next = container.querySelector<HTMLButtonElement>('[data-testid="next"]')!
  await act(async () => next.focus())
  expect(container.querySelector('textarea')).toBeNull()
  expect(document.activeElement).toBe(next)
})
