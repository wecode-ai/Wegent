import { settle } from '@ui-sdk/core/testing'
// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { DialogSurface } from './DialogSurface'
import { Radio, RadioGroup } from './RadioGroup'
import { ReasoningSlider } from './ReasoningSlider'

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
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
}
function press(target: HTMLElement, key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
  act(() => target.dispatchEvent(event))
  return event
}
function Picker({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState('b')
  const [reasoning, setReasoning] = useState('medium')
  return (
    <DialogSurface
      onClose={onClose}
      initialFocus='[role="radio"][aria-checked="true"]'
      render={<div aria-label="Models" tabIndex={-1} />}
    >
      <button data-testid="first">First</button>
      <RadioGroup
        value={selected}
        onValueChange={value => {
          if (value) setSelected(value)
        }}
        aria-label="Model choices"
      >
        {['a', 'disabled', 'b', 'c'].map(value => (
          <Radio value={value} key={value} data-testid={value} disabled={value === 'disabled'}>
            {value}
          </Radio>
        ))}
      </RadioGroup>
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
    </DialogSurface>
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
async function mount() {
  await act(async () => root.render(<Host />))
  await act(async () => {
    get('opener').focus()
    get('opener').click()
    await settle()
  })
}
it('focuses the selected model, skips disabled choices, wraps arrows, and owns Home/End', async () => {
  await mount()
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
    expect([...document.querySelectorAll('[role="radio"][tabindex="0"]')]).toEqual([get(expected)])
  }
  act(() => get('c').focus())
  expect(document.activeElement).toBe(get('c'))
  expect([...document.querySelectorAll('[role="radio"][tabindex="0"]')]).toEqual([get('a')])
})
it('leaves slider values and text navigation to their controls', async () => {
  await mount()
  const slider = document.querySelector<HTMLElement>('[role="slider"]')!
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
it('ignores composition and modified navigation without selecting another model', async () => {
  await mount()
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
it('traps Tab in its modal, isolates the background, and restores the opener after Escape', async () => {
  await mount()
  expect(get('opener').getAttribute('inert')).not.toBeNull()
  act(() => get('last').focus())
  expect(press(get('last'), 'Tab').defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(get('first'))
  expect(press(get('first'), 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(get('last'))
  expect(press(get('last'), 'Escape').defaultPrevented).toBe(true)
  await act(async () => {
    await settle()
  })
  expect(close).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(get('opener'))
  expect(get('opener').hasAttribute('inert')).toBe(false)
})
