// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useIssueFieldSaves } from './useIssueFieldSaves'

type Issue = {
  id: string
  version: number
  start_at?: string | null
}

it('propagates a successful autosave after the editor unmounts', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const source: Issue = { id: 'issue-one', version: 1, start_at: null }
  const updated: Issue = { ...source, version: 2, start_at: '2026-11-16' }
  let finish!: () => void
  let markStarted!: () => void
  const started = new Promise<void>(resolve => {
    markStarted = resolve
  })
  let saves!: ReturnType<typeof useIssueFieldSaves<Issue>>
  const onSaved = vi.fn()

  function Harness() {
    saves = useIssueFieldSaves(source, onSaved)
    return null
  }

  const root = createRoot(document.createElement('div'))
  let unmounted = false
  try {
    await act(async () => root.render(<Harness />))
    let saving!: Promise<Issue | undefined>
    act(() => {
      saving = saves.save('schedule', async () => {
        markStarted()
        await new Promise<void>(resolve => {
          finish = resolve
        })
        return updated
      })
    })
    await started
    expect(saves.pending).toBe(true)
    act(() => root.unmount())
    unmounted = true
    await act(async () => {
      finish()
      await saving
    })
    expect(onSaved).toHaveBeenCalledOnce()
    expect(onSaved).toHaveBeenCalledWith(updated)
  } finally {
    if (!unmounted) act(() => root.unmount())
  }
})
