import { useRef } from 'react'
import { DialogSurface } from '../controls/DialogSurface'
// @vitest-environment jsdom
import { Bot } from 'lucide-react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { AutomaticProcessingTargetPicker } from './AutomaticProcessingTargetPicker'

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

it('navigates multiple options, contains Escape in the picker and restores its trigger', async () => {
  const select = vi.fn()
  const closeDialog = vi.fn()
  function Dialog() {
    const ref = useRef<HTMLDivElement>(null)
    return (
      <DialogSurface onClose={closeDialog} render={<div role="dialog" ref={ref} />}>
        <AutomaticProcessingTargetPicker
          kind="agent"
          kindLabel="Agent"
          icon={Bot}
          options={[
            { id: 'a', name: 'Alpha' },
            { id: 'b', name: 'Beta' },
          ]}
          selectedId="a"
          onSelect={select}
          translate={createCollaborationTranslator('en')}
        />
      </DialogSurface>
    )
  }
  await act(async () => root.render(<Dialog />))
  const trigger = container.querySelector<HTMLButtonElement>(
    '[data-testid="automatic-processing-target"]'
  )!
  const option = (id: string) =>
    container.querySelector<HTMLButtonElement>(
      `[data-testid="automatic-processing-target-option-agent-${id}"]`
    )!
  const key = async (value: string) =>
    act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
      )
    })
  await act(async () => trigger.click())
  const input = container.querySelector('input')!
  const highlighted = (id: string) => {
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-activedescendant')).toBe(option(id).id)
  }
  expect(document.activeElement).toBe(input)
  await key('ArrowDown')
  highlighted('a')
  await key('ArrowDown')
  highlighted('b')
  expect(option('b').tabIndex).toBe(-1)
  expect(option('a').tabIndex).toBe(-1)
  await key('Home')
  highlighted('b')
  await key('End')
  highlighted('b')
  await key('ArrowUp')
  highlighted('a')
  expect(select).not.toHaveBeenCalled()
  await key('Escape')
  expect(container.querySelector('[role="listbox"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(closeDialog).not.toHaveBeenCalled()
  await act(async () => trigger.click())
  await act(async () => option('b').click())
  expect(select).toHaveBeenCalledExactlyOnceWith('b')
  expect(document.activeElement).toBe(trigger)
  await key('Escape')
  expect(closeDialog).toHaveBeenCalledOnce()
})
