// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDesktopModelMenu } from './useDesktopModelMenu'
import { ReasoningSlider } from './ReasoningSlider'
import { createCollaborationTranslator } from '../i18n'

let root: Root
let container: HTMLDivElement
const close = vi.fn()
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  close.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function get(id: string) {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
}
function press(target: HTMLElement, key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
  act(() => target.dispatchEvent(event))
  return event
}
function Picker({ onClose }: { onClose: () => void }) {
  const { ref, ...keyboard } = useDesktopModelMenu(onClose, true)
  const [selected, setSelected] = useState('b')
  const [reasoning, setReasoning] = useState('medium')
  return (
    <div ref={ref} {...keyboard} role="dialog" aria-modal="true" aria-label="Models" tabIndex={-1}>
      <button data-testid="first">First</button>
      <div role="radiogroup" aria-label="Model choices">
        {['a', 'disabled', 'b', 'c'].map(value => (
          <button
            key={value}
            data-testid={value}
            role="radio"
            aria-checked={selected === value}
            aria-disabled={value === 'disabled'}
            tabIndex={-1}
            onClick={() => setSelected(value)}
          >
            {value}
          </button>
        ))}
      </div>
      <ReasoningSlider
        translate={createCollaborationTranslator('en')}
        control={{
          id: 'reasoning',
          label: 'Reasoning',
          defaultValue: 'medium',
          options: ['low', 'medium', 'high'].map((value, order) => ({
            value,
            label: value,
            order,
          })),
        }}
        selectedModelOptions={{ reasoning }}
        onSelectOption={(_id, value) => setReasoning(value)}
      />
      <input data-testid="input" aria-label="Other option" />
      <button data-testid="last">Last</button>
    </div>
  )
}
function Host() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button data-testid="opener" onClick={() => setOpen(true)}>
        Open models
      </button>
      {open && (
        <Picker
          onClose={() => {
            close()
            setOpen(false)
          }}
        />
      )}
    </>
  )
}
function mount() {
  act(() => root.render(<Host />))
  act(() => {
    get('opener').focus()
    get('opener').click()
  })
}
it('focuses the selected model, skips disabled choices, wraps arrows, and owns Home/End', () => {
  mount()
  expect(document.activeElement).toBe(get('b'))
  for (const [key, expected] of [
    ['End', 'c'],
    ['ArrowRight', 'a'],
    ['ArrowDown', 'b'],
    ['ArrowLeft', 'a'],
    ['ArrowUp', 'c'],
    ['Home', 'a'],
  ]) {
    expect(press(document.activeElement as HTMLElement, key).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(get(expected))
    expect(get(expected).getAttribute('aria-checked')).toBe('true')
    expect([...container.querySelectorAll('[role="radio"][tabindex="0"]')]).toEqual([get(expected)])
  }
  act(() => get('c').focus())
  expect([...container.querySelectorAll('[role="radio"][tabindex="0"]')]).toEqual([get('c')])
})
it('leaves slider values and text navigation to their controls', () => {
  mount()
  const slider = container.querySelector<HTMLElement>('[role="slider"]')!
  act(() => slider.focus())
  for (const [key, expected] of [
    ['End', '2'],
    ['Home', '0'],
    ['ArrowRight', '1'],
    ['ArrowLeft', '0'],
  ]) {
    press(slider, key)
    expect(slider.getAttribute('aria-valuenow')).toBe(expected)
    expect(document.activeElement).toBe(slider)
    expect(get('b').getAttribute('aria-checked')).toBe('true')
  }
  act(() => get('input').focus())
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End'])
    expect(press(get('input'), key).defaultPrevented).toBe(false)
  expect(document.activeElement).toBe(get('input'))
})
it('ignores composition and modified navigation without selecting another model', () => {
  mount()
  for (const extra of [
    { isComposing: true },
    { keyCode: 229 },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
  ])
    expect(press(get('b'), 'End', extra).defaultPrevented).toBe(false)
  expect(get('b').getAttribute('aria-checked')).toBe('true')
  expect(document.activeElement).toBe(get('b'))
})
it('traps Tab in its modal, isolates the background, and restores the opener after Escape', () => {
  mount()
  expect(get('opener').getAttribute('inert')).not.toBeNull()
  act(() => get('last').focus())
  expect(press(get('last'), 'Tab').defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(get('first'))
  expect(press(get('first'), 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(get('last'))
  expect(press(get('last'), 'Escape').defaultPrevented).toBe(true)
  expect(close).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(get('opener'))
  expect(get('opener').hasAttribute('inert')).toBe(false)
})
