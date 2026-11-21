// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { useEscapeKey } from '../markdown/useEscapeKey'
import { ProjectWorkBar } from './ProjectWorkBar'

let root: Root
let container: HTMLDivElement
let external: HTMLButtonElement
const closeParent = vi.fn()

function Host({ mobile = false, externallyOpened = false }) {
  const ref = useRef<HTMLDivElement>(null)
  useEscapeKey(closeParent, true, ref)
  return (
    <div ref={ref}>
      <input aria-label="Pending editor draft" defaultValue="Keep this draft" />
      <ProjectWorkBar
        translate={createCollaborationTranslator('en')}
        isMobile={mobile}
        projects={[{ id: 1, name: 'Project', tasks: [] }]}
        devices={[]}
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        projectMenuOpenSignal={externallyOpened ? 1 : undefined}
        projectMenuAnchorElement={externallyOpened ? external : null}
      />
    </div>
  )
}

function element(id: string) {
  const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!node) throw new Error(`Missing ${id}`)
  return node
}

function escape(composing = false) {
  act(() =>
    element('project-search-input').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        isComposing: composing,
      })
    )
  )
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  closeParent.mockClear()
  container = document.createElement('div')
  external = document.createElement('button')
  document.body.append(container, external)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  external.remove()
})

test.each([false, true])(
  'Escape dismisses only the project layer and preserves its host draft (mobile=%s)',
  async mobile => {
    act(() => root.render(<Host mobile={mobile} />))
    const draft = document.querySelector(
      'input[aria-label="Pending editor draft"]'
    ) as HTMLInputElement
    const trigger = element('project-work-button')
    await act(async () => trigger.click())
    await vi.waitFor(() =>
      expect(document.activeElement?.closest('[data-testid="project-work-menu"]')).not.toBeNull()
    )
    await act(async () => escape())
    expect(document.querySelector('[data-testid="project-work-menu"]')).toBeNull()
    expect(closeParent).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
    expect(draft.value).toBe('Keep this draft')
    act(() =>
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        })
      )
    )
    expect(closeParent).toHaveBeenCalledOnce()
  }
)

test('returns focus to the actual external anchor', () => {
  act(() => root.render(<Host externallyOpened />))
  escape()
  expect(closeParent).not.toHaveBeenCalled()
  expect(document.querySelector('[data-testid="project-work-menu"]')).toBeNull()
  expect(document.activeElement).toBe(external)
})

test('leaves IME Escape to composition, then closes only the menu on ordinary Escape', () => {
  act(() => root.render(<Host />))
  act(() => element('project-work-button').click())
  escape(true)
  expect(document.querySelector('[data-testid="project-work-menu"]')).not.toBeNull()
  expect(closeParent).not.toHaveBeenCalled()
  escape()
  expect(document.querySelector('[data-testid="project-work-menu"]')).toBeNull()
  expect(closeParent).not.toHaveBeenCalled()
})
