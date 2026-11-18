import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMemo, useState, useSyncExternalStore } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import { createDesktopPaneContextSource } from './desktopPaneContextSource'

function usePaneExecutionContext(
  active: boolean,
  current: RuntimeTaskAddress | null | undefined,
  resolved: RuntimeTaskAddress | null | undefined,
  openTask: (address: RuntimeTaskAddress) => Promise<unknown>
) {
  const [source] = useState(() =>
    createDesktopPaneContextSource(new RuntimeTaskLifecycleStore('bound-pane-context'))
  )
  const view = useMemo(
    () => source.observe({ active, current, resolved, openTask, runtimeWork: null }),
    [source, active, current, resolved, openTask]
  )
  return useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot)
    .currentRuntimeConversationSource
}

afterEach(cleanup)

it('defers execution metadata navigation while the retained task pane is hidden', () => {
  const current = { deviceId: 'local', taskId: 'issue-task' }
  const resolved = { ...current, workspacePath: '/project', threadId: 'thread' }
  const open = vi.fn().mockResolvedValue(undefined)
  const { rerender } = renderHook(
    ({ active, address }) => usePaneExecutionContext(active, current, address, open),
    { initialProps: { active: false, address: resolved } }
  )
  expect(open).not.toHaveBeenCalled()
  rerender({ active: false, address: { ...resolved, threadId: 'updated-thread' } })
  expect(open).not.toHaveBeenCalled()
  rerender({ active: true, address: resolved })
  expect(open).toHaveBeenCalledExactlyOnceWith(resolved)
})

it('keeps an already resolved task in place when runtime objects refresh', () => {
  const address = { deviceId: 'local', taskId: 'issue-task', threadId: 'thread' }
  const open = vi.fn().mockResolvedValue(undefined)
  const { rerender } = renderHook(
    ({ current }) => usePaneExecutionContext(true, current, address, open),
    { initialProps: { current: address } }
  )
  rerender({ current: { ...address } })
  expect(open).not.toHaveBeenCalled()
})
