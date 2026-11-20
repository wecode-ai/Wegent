// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AssistantPlanCard } from './AssistantPlanCard'
import { ConversationTranslationProvider } from './ConversationTranslation'
import { createCollaborationTranslator } from '../i18n'
import { CollaborationTheme } from '../theme'

let root: Root
let container: HTMLDivElement
let clipboard: PropertyDescriptor | undefined
const writeText = vi.fn(async () => {})
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  writeText.mockClear()
  vi.useRealTimers()
})

test('copy feedback expires after its original interval even when copied again', async () => {
  await act(async () =>
    root.render(
      <CollaborationTheme mode="light">
        <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
          <AssistantPlanCard content="Implementation plan" />
        </ConversationTranslationProvider>
      </CollaborationTheme>
    )
  )
  const copy = container.querySelector<HTMLButtonElement>(
    '[data-testid="assistant-plan-copy-button"]'
  )!
  await act(async () => copy.click())
  expect(container.querySelector('[data-testid="assistant-plan-copy-success"]')).not.toBeNull()
  act(() => vi.advanceTimersByTime(1000))
  await act(async () => copy.click())
  expect(writeText).toHaveBeenCalledTimes(2)
  expect(writeText).toHaveBeenLastCalledWith('Implementation plan')
  act(() => vi.advanceTimersByTime(399))
  expect(container.querySelector('[data-testid="assistant-plan-copy-success"]')).not.toBeNull()
  act(() => vi.advanceTimersByTime(1))
  expect(container.querySelector('[data-testid="assistant-plan-copy-success"]')).toBeNull()
})
