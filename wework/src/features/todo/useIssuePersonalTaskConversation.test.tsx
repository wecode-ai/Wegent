import { act, renderHook, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CollaborationIssue,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { AiChatModal } from './AiChatModal'
import {
  useIssuePersonalTaskConversation,
  useIssuePersonalTaskState,
} from './useIssuePersonalTaskConversation'

const modal = vi.hoisted(() => ({ current: null as ComponentProps<typeof AiChatModal> | null }))
vi.mock('./AiChatModal', () => ({
  AiChatModal: (props: ComponentProps<typeof AiChatModal>) => {
    modal.current = props
    return null
  },
}))
vi.mock('./humanTaskDispatch', () => ({
  resolveHumanTaskDispatch: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./issueTaskAvailability', () => ({
  requireIssueTaskAvailable: vi.fn(async binding => binding),
}))
import { resolveHumanTaskDispatch } from './humanTaskDispatch'

const item = {
  id: 'thread',
  title: 'Personal task',
  status: 'in_progress',
  tags: [],
  version: 1,
} as unknown as CollaborationIssue
const project = {
  id: 'group',
  project_key: 'GROUP',
  project_store: 'local',
  resource_type: 'chat_group',
} as CollaborationProject
const address = { deviceId: 'device', taskId: 'task' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}
function setup() {
  const get = vi.fn().mockResolvedValue(item)
  const update = vi.fn()
  const list = vi.fn().mockResolvedValue([])
  const api = { issues: { get, update }, taskBindings: { list } } as unknown as SharedWorkspaceApi
  const bindTask = vi.fn().mockResolvedValue(undefined)
  const unbindTask = vi.fn().mockResolvedValue(undefined)
  const beforeStart = vi.fn().mockResolvedValue(undefined)
  const notify = vi.fn()
  const onOpenIssue = vi.fn()
  const onChanged = vi.fn()
  const services = {} as WorkbenchServices
  const latestProjectRef = { current: project }
  const hook = renderHook(
    ({ currentApi = api, open = true }) => {
      const state = useIssuePersonalTaskState()
      const controller = useIssuePersonalTaskConversation({
        state,
        project,
        latestProjectRef,
        api: currentApi,
        services,
        runtimePort: { bindTask, unbindTask },
        userId: 0,
        taskOwnerUserId: 0,
        localProjects: [],
        onOpenIssue,
        locationIssueId: item.id,
        notify,
        clearNotice: vi.fn(),
        onChanged,
        beforeStart,
        embedded: false,
        open,
      })
      return { ...controller, state }
    },
    { initialProps: { currentApi: api, open: true } }
  )
  return {
    ...hook,
    api,
    get,
    list,
    bindTask,
    unbindTask,
    beforeStart,
    notify,
    onOpenIssue,
    onChanged,
  }
}
afterEach(() => {
  vi.clearAllMocks()
  modal.current = null
  localStorage.clear()
})

describe('personal conversation ownership and preparation', () => {
  it('uses the Group container, preserves the composer while hidden, and invalidates it on close', async () => {
    const hook = setup()
    await act(() => hook.result.current.openNewTaskConversation(item))
    expect(resolveHumanTaskDispatch).toHaveBeenCalledWith(
      undefined,
      'group',
      'thread',
      0,
      'chat_group'
    )
    const composer = hook.result.current.state.taskComposer
    hook.rerender({ currentApi: hook.api, open: false })
    expect(hook.result.current.state.taskComposer).toBe(composer)
    act(() => hook.result.current.state.closeTaskConversation())
    expect(hook.result.current.state.taskComposer).toBeNull()
  })

  it('does not open a private pane after its source was replaced during a binding read', async () => {
    const hook = setup()
    const lookup = deferred<never[]>()
    hook.list.mockReturnValueOnce(lookup.promise)
    let opening!: Promise<void>
    act(() => {
      opening = hook.result.current.openBoundTaskConversation(item, address)
    })
    hook.rerender({ currentApi: { ...hook.api }, open: true })
    await act(async () => {
      lookup.resolve([])
      await opening
    })
    expect(hook.result.current.state.taskComposer).toBeNull()
    expect(hook.onOpenIssue).not.toHaveBeenCalled()
    expect(hook.notify).not.toHaveBeenCalled()
  })

  it('does not navigate or report a stale error after unmount', async () => {
    const hook = setup()
    const lookup = deferred<never[]>()
    hook.list.mockReturnValueOnce(lookup.promise)
    const opening = hook.result.current.openBoundTaskConversation(item, address)
    hook.unmount()
    await act(async () => {
      lookup.resolve([])
      await opening
    })
    expect(hook.onOpenIssue).not.toHaveBeenCalled()
    expect(hook.notify).not.toHaveBeenCalled()
  })

  it('rechecks authorization before binding and does not mutate the item when denied', async () => {
    const hook = setup()
    await act(() => hook.result.current.openNewTaskConversation(item))
    // Render the returned element to obtain the real editor preparation contract.
    const { render } = await import('@testing-library/react')
    const view = render(hook.result.current.conversationPanel)
    await waitFor(() => expect(modal.current).not.toBeNull())
    hook.beforeStart.mockRejectedValueOnce(new Error('revoked'))
    await expect(modal.current!.prepareTask!(address)).rejects.toThrow('revoked')
    expect(hook.bindTask).not.toHaveBeenCalled()
    expect(hook.get).not.toHaveBeenCalled()
    view.unmount()
  })

  it('rolls back a binding if the conversation closes before binding completes', async () => {
    const hook = setup()
    await act(() => hook.result.current.openNewTaskConversation(item))
    const { render } = await import('@testing-library/react')
    const view = render(hook.result.current.conversationPanel)
    const pending = deferred<void>()
    hook.bindTask.mockReturnValueOnce(pending.promise)
    const preparing = modal.current!.prepareTask!(address)
    await waitFor(() => expect(hook.bindTask).toHaveBeenCalledOnce())
    act(() => hook.result.current.state.closeTaskConversation())
    pending.resolve()
    await expect(preparing).rejects.toThrow()
    expect(hook.unbindTask).toHaveBeenCalledWith('thread', expect.objectContaining(address))
    expect(hook.get).not.toHaveBeenCalled()
    view.unmount()
  })

  it('binds before updating status and returns the rollback used when runtime startup fails', async () => {
    const hook = setup()
    await act(() => hook.result.current.openNewTaskConversation(item))
    const { render } = await import('@testing-library/react')
    const view = render(hook.result.current.conversationPanel)
    const rollback = await modal.current!.prepareTask!(address)
    expect(hook.beforeStart.mock.invocationCallOrder[0]).toBeLessThan(
      hook.bindTask.mock.invocationCallOrder[0]
    )
    expect(hook.bindTask.mock.invocationCallOrder[0]).toBeLessThan(
      hook.get.mock.invocationCallOrder[0]
    )
    await rollback!()
    expect(hook.unbindTask).toHaveBeenCalledOnce()
    view.unmount()
  })
})
