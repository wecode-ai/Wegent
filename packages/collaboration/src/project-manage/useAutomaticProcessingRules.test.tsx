// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi, WorkspaceAutomationRule } from '../ports/SharedWorkspaceApi'
import { useAutomaticProcessingRules } from './useAutomaticProcessingRules'

it('revalidates cached rules, retains them on failure and isolates project and API sessions', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.createElement('div'))
  let controls!: ReturnType<typeof useAutomaticProcessingRules>
  let finish!: (rules: WorkspaceAutomationRule[]) => void
  const saved = [{ id: 'saved' }] as WorkspaceAutomationRule[]
  const list = vi
    .fn()
    .mockResolvedValueOnce(saved)
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
  const api = { list } as unknown as SharedWorkspaceApi['automations']
  function Harness({ projectId, source = api }: { projectId: string; source?: typeof api }) {
    controls = useAutomaticProcessingRules(source, projectId)
    return null
  }
  try {
    await act(async () => root.render(<Harness projectId="one" />))
    expect(controls.rules).toEqual(saved)
    expect(controls.loading).toBe(false)
    await act(async () => root.render(null))
    await act(async () => root.render(<Harness projectId="one" />))
    expect(controls.rules).toEqual(saved)
    expect(controls.loading).toBe(false)
    expect(list).toHaveBeenCalledTimes(2)
    await act(async () => finish([{ id: 'fresh' }] as WorkspaceAutomationRule[]))
    expect(controls.rules[0].id).toBe('fresh')
    list.mockRejectedValueOnce(new Error('offline'))
    await act(() => controls.load())
    expect(controls.rules[0].id).toBe('fresh')
    expect(controls.error).toEqual(new Error('offline'))
    list.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    await act(async () => root.render(<Harness projectId="two" />))
    expect(controls.rules).toEqual([])
    expect(controls.loading).toBe(true)
    const otherApi = {
      list: vi.fn().mockResolvedValue([{ id: 'other-api' }]),
    } as unknown as typeof api
    await act(async () => root.render(<Harness projectId="two" source={otherApi} />))
    expect(controls.rules[0].id).toBe('other-api')
    await act(async () => finish([{ id: 'late' }] as WorkspaceAutomationRule[]))
    expect(controls.rules[0].id).toBe('other-api')
    await act(async () => root.render(null))
    await controls.load()
    expect(otherApi!.list).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
  }
})
