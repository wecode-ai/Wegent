// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { EMPTY_DRAFT } from './automaticProcessing'
import { AutomaticProcessingTriggerFields } from './AutomaticProcessingTriggerFields'

it('opens the advanced cron editor and focuses its input when validation changes', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const scroll = vi.fn()
  const previous = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = scroll
  function Harness({ error }: { error?: string }) {
    return (
      <AutomaticProcessingTriggerFields
        draft={{ ...EMPTY_DRAFT, trigger: 'schedule' }}
        cronError={error}
        updateDraft={vi.fn()}
        selectTrigger={vi.fn()}
        locale="en"
        translate={(_key, fallback) => fallback ?? _key}
        hooks={[]}
        hooksLoading={false}
        hooksError=""
        hasIncomingHooks={false}
        refreshHooks={vi.fn()}
        statuses={[]}
      />
    )
  }
  try {
    await act(async () => root.render(<Harness />))
    const details = node.querySelector('details')!
    expect(details.open).toBe(false)
    await act(async () => root.render(<Harness error="Invalid cron" />))
    expect(details.open).toBe(true)
    expect(details.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.tagName).toBe('INPUT')
    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' })
    await act(async () => root.render(<Harness />))
    expect(details.open).toBe(true)
  } finally {
    await act(async () => root.unmount())
    node.remove()
    HTMLElement.prototype.scrollIntoView = previous
  }
})
