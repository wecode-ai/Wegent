// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Bot } from 'lucide-react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AutomaticProcessingTargetPicker } from './AutomaticProcessingTargetPicker'
import { createCollaborationTranslator } from '../i18n'
import { useDialogKeyboard } from '../controls/useDialogKeyboard'

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
    const ref = useDialogKeyboard<HTMLDivElement>(closeDialog)
    return (
      <div role="dialog" ref={ref}>
        <AutomaticProcessingTargetPicker
          kind="agent" kindLabel="Agent" icon={Bot}
          options={[{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]}
          selectedId="a" onSelect={select} translate={createCollaborationTranslator('en')}
        />
      </div>
    )
  }
  await act(async () => root.render(<Dialog />))
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="automatic-processing-target"]')!
  const option = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="automatic-processing-target-option-agent-${id}"]`)!
  const key = async (value: string) => act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
  })
  await act(async () => trigger.click())
  expect(document.activeElement).toBe(container.querySelector('input'))
  await key('ArrowDown')
  expect(document.activeElement).toBe(option('a'))
  await key('ArrowDown')
  expect(document.activeElement).toBe(option('b'))
  expect(option('b').tabIndex).toBe(0)
  expect(option('a').tabIndex).toBe(-1)
  await key('Home')
  expect(document.activeElement).toBe(option('a'))
  await key('End')
  expect(document.activeElement).toBe(option('b'))
  await key('ArrowUp')
  expect(document.activeElement).toBe(option('a'))
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
