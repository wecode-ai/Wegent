import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { groupWorkContainer } from '@/api/groupWorkContainer'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import type { RuntimeTaskAddress } from '@/types/api'
import '@/i18n'
import { useTaskOriginAssociation } from './useTaskOriginAssociation'
import { cloudRuntimePort } from './workbenchCloudProjectContextTestFixtures'

const group: ChatGroup = {
  id: 'independent-group',
  project_key: 'G',
  name: 'Independent group',
  description: '',
  status: 'active',
  version: 1,
  role: 'Developer',
  created_by_user_id: 900,
  created_at: '2026-11-11T00:00:00Z',
  updated_at: '2026-11-11T00:00:00Z',
}
const owner = groupWorkContainer(group, 'local')
const item = {
  id: 'thread',
  cloud_project_id: group.id,
  group_id: group.id,
  title: 'Reviewed public title',
  description: 'Reviewed public scope',
  version: 1,
} as CloudLoopItem
const task = { deviceId: 'device', taskId: 'original-private-task' }

function setup(
  initialJoined = true,
  previous?: {
    project: CloudProject
    item: CloudLoopItem
    api: {
      bindTask: ReturnType<typeof vi.fn>
      unbindTask: ReturnType<typeof vi.fn>
    }
  }
) {
  let joined = initialJoined
  const participation = () => ({
    current_user_id: 0,
    participants: [],
    joined,
    can_comment: joined,
    show_in_sidebar: joined,
  })
  const groups = {
    get: vi.fn().mockResolvedValue({ group, members: [] }),
    participation: vi.fn(async () => participation()),
    setParticipation: vi.fn(async () => {
      joined = true
      return participation()
    }),
  }
  const api = {
    listLoopItems: vi.fn().mockResolvedValue({ items: [item] }),
    bindTask: vi.fn().mockResolvedValue(undefined),
    trackProjectTask: vi.fn().mockResolvedValue({ item }),
    createLoopItem: vi.fn(),
  }
  const services = {
    projectSpaceApis: { local: api },
    chatGroupApis: { local: groups as unknown as ChatGroupApi },
    ...(previous ? { workspaceRuntimePort: cloudRuntimePort(previous.api) } : {}),
  } as unknown as WorkbenchServices
  const runtimeRef = { current: task as RuntimeTaskAddress }
  const callbacks = {
    setPendingCloudContext: vi.fn(),
    setDismissedDefaultCloudProjectKey: vi.fn(),
    setTodoBindingError: vi.fn(),
    setCloudActionNotice: vi.fn(),
    onBound: vi.fn(),
    onLinkRecoveryFailed: vi.fn(),
  }
  const options = {
    paneKey: 'private-pane',
    services,
    runtimeTaskTitle: 'Private task title',
    runtimeTaskDescription: 'PRIVATE_FIRST_PROMPT_MUST_NOT_BECOME_PUBLIC',
    projectSpaceApiFor: () => api as unknown as ProjectSpaceApi,
    currentRuntimeTaskRef: runtimeRef,
    boundProject: previous?.project,
    boundItem: previous?.item,
    ...callbacks,
  }
  const view = renderHook(
    ({ accountScope, address }: { accountScope: string; address: RuntimeTaskAddress | null }) =>
      useTaskOriginAssociation({ ...options, accountScope, contextRuntimeTask: address }),
    { initialProps: { accountScope: 'account-a', address: task as RuntimeTaskAddress | null } }
  )
  const select = async () => {
    act(() => view.result.current.handleSelectCloudProject(owner))
    await waitFor(() => expect(view.result.current.taskBoardAssociation?.items).toEqual([item]))
  }
  return { ...view, api, groups, callbacks, runtimeRef, select }
}

describe('Task association with independent group Threads', () => {
  it('reports a failed cross-store recovery and clears only the current derived link UI', async () => {
    const previous = {
      project: groupWorkContainer({ ...group, id: 'old-cloud-group' }, 'cloud'),
      item: {
        ...item,
        id: 'old-cloud-thread',
        group_id: 'old-cloud-group',
        cloud_project_id: 'old-cloud-group',
      },
      api: {
        bindTask: vi.fn().mockRejectedValue(new Error('Old source revoked')),
        unbindTask: vi.fn().mockResolvedValue(undefined),
      },
    }
    const view = setup(true, previous)
    view.api.bindTask.mockRejectedValue(new Error('Target unavailable'))
    await view.select()
    act(() => view.result.current.associateRuntimeTaskWithExistingItem(item))
    await waitFor(() => expect(view.callbacks.onLinkRecoveryFailed).toHaveBeenCalledOnce())
    expect(previous.api.unbindTask).toHaveBeenCalledExactlyOnceWith(previous.item.id, task)
    expect(previous.api.bindTask).toHaveBeenCalledExactlyOnceWith(
      previous.item.id,
      task,
      'Private task title'
    )
    expect(view.callbacks.onBound).not.toHaveBeenCalled()
    expect(view.callbacks.setCloudActionNotice).not.toHaveBeenCalled()
    expect(view.callbacks.setTodoBindingError).toHaveBeenCalledWith(
      '关联失败，原有关联也未能恢复。请重新选择要关联的事项。'
    )
    expect(view.result.current.taskBoardAssociation?.pending).toBe(false)
  })
  it('binds the exact existing private task to a joined Thread without requiring a project', async () => {
    const { result, api, callbacks, select } = setup()
    await select()
    act(() => result.current.associateRuntimeTaskWithExistingItem(item))
    await waitFor(() =>
      expect(api.bindTask).toHaveBeenCalledExactlyOnceWith(item.id, task, 'Private task title')
    )
    expect(callbacks.onBound).toHaveBeenCalledWith({ task, project: owner, item })
    expect(api.createLoopItem).not.toHaveBeenCalled()
    expect(api.trackProjectTask).not.toHaveBeenCalled()
  })

  it('opens a public form for a new unclassified Thread instead of copying the private prompt', async () => {
    const { result, api, callbacks, select } = setup()
    act(() => result.current.openTaskOriginCreation())
    expect(result.current.taskOriginCreation?.target).toBeUndefined()
    expect(result.current.taskOriginCreation).not.toBeNull()
    act(() => result.current.closeTaskOriginCreation())
    await select()
    act(() => result.current.associateRuntimeTaskWithNewItem())
    expect(result.current.taskOriginCreation?.target).toEqual(owner)
    expect(api.trackProjectTask).not.toHaveBeenCalled()
    expect(api.bindTask).not.toHaveBeenCalled()
    await act(() => result.current.associateCreatedTaskOrigin(item, owner))
    expect(api.bindTask).toHaveBeenCalledExactlyOnceWith(item.id, task, 'Private task title')
    expect(callbacks.onBound).toHaveBeenCalledWith({ task, project: owner, item })
    expect(api.createLoopItem).not.toHaveBeenCalled()
  })

  it('requires an explicit join, supports cancellation, then joins only the current actor before binding', async () => {
    const { result, api, groups, select } = setup(false)
    await select()
    act(() => result.current.associateRuntimeTaskWithExistingItem(item))
    await waitFor(() => expect(result.current.taskOriginJoinRequest?.item).toEqual(item))
    expect(groups.setParticipation).not.toHaveBeenCalled()
    expect(api.bindTask).not.toHaveBeenCalled()
    act(() => result.current.cancelTaskOriginJoin())
    expect(result.current.taskOriginJoinRequest).toBeNull()
    expect(api.bindTask).not.toHaveBeenCalled()
    act(() => result.current.associateRuntimeTaskWithExistingItem(item))
    await waitFor(() => expect(result.current.taskOriginJoinRequest).not.toBeNull())
    await act(() => result.current.confirmTaskOriginJoin())
    expect(groups.setParticipation).toHaveBeenCalledExactlyOnceWith(item.id, { joined: true })
    expect(api.bindTask).toHaveBeenCalledExactlyOnceWith(item.id, task, 'Private task title')
  })

  it('retains an actionable join error without implicitly linking or changing the private task', async () => {
    const { result, api, groups, callbacks, select } = setup(false)
    groups.setParticipation.mockRejectedValue(new Error('Join could not be saved'))
    await select()
    act(() => result.current.associateRuntimeTaskWithExistingItem(item))
    await waitFor(() => expect(result.current.taskOriginJoinRequest).not.toBeNull())
    await act(() => result.current.confirmTaskOriginJoin())
    expect(result.current.taskOriginJoinRequest).toMatchObject({
      pending: false,
      error: 'Join could not be saved',
    })
    expect(api.bindTask).not.toHaveBeenCalled()
    expect(callbacks.onBound).not.toHaveBeenCalled()
    act(() => result.current.cancelTaskOriginJoin())
    expect(result.current.taskOriginJoinRequest).toBeNull()
  })

  it('does not grant a Viewer execution authority from an older writable card', async () => {
    const { result, api, groups, callbacks, select } = setup()
    groups.get.mockResolvedValue({ group: { ...group, role: 'Viewer' }, members: [] })
    await select()
    act(() => result.current.associateRuntimeTaskWithExistingItem(item))
    await waitFor(() =>
      expect(callbacks.setTodoBindingError).toHaveBeenCalledWith('当前群为只读，仍可查看历史记录。')
    )
    expect(groups.setParticipation).not.toHaveBeenCalled()
    expect(api.bindTask).not.toHaveBeenCalled()
  })

  it('hides the old selection immediately on account change and rejects its late response without revival', async () => {
    const view = setup()
    let resolve!: (value: { group: ChatGroup; members: never[] }) => void
    const pending = new Promise<{ group: ChatGroup; members: never[] }>(done => {
      resolve = done
    })
    view.groups.get.mockReturnValue(pending)
    await view.select()
    act(() => view.result.current.associateRuntimeTaskWithExistingItem(item))
    view.rerender({ accountScope: 'account-b', address: task })
    expect(view.result.current.taskBoardAssociation).toBeNull()
    expect(view.result.current.taskOriginJoinRequest).toBeNull()
    await act(async () => {
      resolve({ group, members: [] })
      await pending
    })
    view.rerender({ accountScope: 'account-a', address: task })
    expect(view.result.current.taskBoardAssociation).toBeNull()
    expect(view.api.bindTask).not.toHaveBeenCalled()
    expect(view.callbacks.onBound).not.toHaveBeenCalled()
  })

  it('retains a same-task public draft across address enrichment and binds its latest original-task handle', async () => {
    const view = setup()
    await view.select()
    act(() => view.result.current.associateRuntimeTaskWithNewItem())
    const scope = view.result.current.scopeKey
    const enriched = {
      ...task,
      runtime: 'codex',
      threadId: 'original-session',
      runtimeHandle: {
        modelSelection: {
          modelName: 'private-selected-model',
          modelType: 'private',
          options: { reasoning: 'high' },
        },
      },
    } as RuntimeTaskAddress
    view.runtimeRef.current = enriched
    view.rerender({ accountScope: 'account-a', address: enriched })
    expect(view.result.current.scopeKey).toBe(scope)
    expect(view.result.current.taskOriginCreation?.target).toEqual(owner)
    await act(() => view.result.current.associateCreatedTaskOrigin(item, owner))
    expect(view.api.bindTask).toHaveBeenCalledExactlyOnceWith(
      item.id,
      enriched,
      'Private task title'
    )
  })

  it('keeps an already created public item available for retry when linking fails', async () => {
    const { result, api, select } = setup()
    await select()
    act(() => result.current.associateRuntimeTaskWithNewItem())
    api.bindTask.mockRejectedValueOnce(new Error('Binding failed'))
    await act(async () => {
      await expect(result.current.associateCreatedTaskOrigin(item, owner)).rejects.toThrow(
        'Binding failed'
      )
    })
    expect(result.current.taskOriginCreation?.target).toEqual(owner)
    await act(() => result.current.associateCreatedTaskOrigin(item, owner))
    expect(api.bindTask).toHaveBeenCalledTimes(2)
    expect(api.createLoopItem).not.toHaveBeenCalled()
    expect(api.trackProjectTask).not.toHaveBeenCalled()
  })
})
