import { createAgent } from '@ui-sdk/react/agent'
import { elementOf } from '@ui-sdk/core/observe'
import { act } from 'react'

const agent = createAgent()

export async function sdkSelectValue(element: HTMLElement, value?: string) {
  if (value !== undefined) {
    if (element.getAttribute('aria-expanded') !== 'true') await act(async () => element.click())
    const content = document.getElementById(element.getAttribute('aria-controls') ?? '')
    const option = Array.from(content?.querySelectorAll<HTMLElement>('[role="option"]') ?? []).find(
      candidate => candidate.getAttribute('data-value') === value
    )
    if (!option) throw new Error('Select option is missing: ' + value)
    await act(async () => option.click())
    return
  }
  const result = await agent.query({ kind: 'select' })
  if ('error' in result) throw new Error(result.error)
  const owner = result.find(candidate => elementOf(candidate.ref) === element)
  if (!owner) throw new Error('SDK select owner is missing')
  return String(owner.value ?? '')
}

export async function sdkSelectItems(element: HTMLElement) {
  const opened = element.getAttribute('aria-expanded') !== 'true'
  if (opened) await act(async () => element.click())
  const content = document.getElementById(element.getAttribute('aria-controls') ?? '')
  if (!content) throw new Error('Open SDK select listbox is missing')
  const items = Array.from(content.querySelectorAll<HTMLElement>('[role="option"]'), option => {
    const value = option.getAttribute('data-value')
    if (value === null) throw new Error('Select option business value is missing')
    return {
      value,
      label: option.getAttribute('aria-label') ?? option.textContent?.trim() ?? '',
    }
  })
  if (opened)
    await act(async () =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        })
      )
    )
  return items
}
