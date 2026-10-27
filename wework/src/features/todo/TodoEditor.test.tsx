import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { startTransition, Suspense, useState } from 'react'
import '@/i18n'
import type { CloudLoopItem, CloudProject, LoopItemTaskBinding } from '@/api/deliveries'
import { TodoEditor } from './TodoEditor'
import { markdownAttachmentRows } from './attachmentMarkdown'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('markdownAttachmentRows', () => {
  it('recognizes provider-native links through the unified attachment marker', () => {
    expect(
      markdownAttachmentRows(
        '[changes.patch](/group/project/uploads/hash/changes.patch)\n' +
          '<!-- wegent-attachment:gitlab-encoded -->'
      )
    ).toEqual([{ id: 'gitlab-encoded', display_name: 'changes.patch', size_bytes: 0 }])
  })

  it('keeps recognizing legacy Wegent attachment links', () => {
    expect(markdownAttachmentRows('[capture.png](wegent://attachments/local-id)')).toEqual([
      { id: 'local-id', display_name: 'capture.png', size_bytes: 0 },
    ])
  })
})

const api = {
  listDeliveries: vi.fn(async () => ({ items: [] })),
  listTaskBindings: vi.fn(async () => []),
  listLoopItemAttachments: vi.fn(async () => []),
  listLoopItemCollaborators: vi.fn(async () => []),
  listCloudProjectMembers: vi.fn(async () => []),
} as never

const baseItem = {
  id: 'WEG-1',
  cloud_project_id: '11',
  title: 'Inspect changes',
  description: 'Review the current diff',
  status: 'in_progress',
  priority: 'high',
  parent_id: null,
  due_at: null,
  tags: [],
  assignee_user_id: null,
  assignee_agent_id: 'agent-1',
  created_at: '2026-08-01T00:00:00',
  updated_at: '2026-08-01T00:00:00',
  version: 1,
  can_edit: true,
} as unknown as CloudLoopItem

const project = { id: '11', name: 'Wework' } as unknown as CloudProject

function editorElement(item: CloudLoopItem) {
  return (
    <TodoEditor
      mode="edit"
      item={item}
      project={project}
      allItems={[item]}
      onUpdated={vi.fn()}
      onAddChild={vi.fn()}
      onClose={vi.fn()}
      api={api}
      currentUserId={1}
    />
  )
}

describe('TodoEditor external item sync', () => {
  it.each(['draft', 'source'] as const)(
    'preserves newer %s status changes when a pending save is rejected',
    async change => {
      const user = userEvent.setup()
      const item = { ...baseItem, status: 'inbox' }
      const pending = deferred<CloudLoopItem>()
      const updateLoopItem = vi.fn(() => pending.promise)
      const editorApi = { ...api, updateLoopItem } as never
      const props = {
        mode: 'edit' as const,
        item,
        project,
        allItems: [item],
        onUpdated: vi.fn(),
        onClose: vi.fn(),
        api: editorApi,
        currentUserId: 1,
      }
      const view = render(<TodoEditor {...props} />)
      await user.selectOptions(screen.getByTestId('cloud-todo-detail-status'), 'in_progress')
      await user.click(screen.getByTestId('cloud-todo-save'))
      await waitFor(() => expect(updateLoopItem).toHaveBeenCalledOnce())
      if (change === 'draft') {
        await user.selectOptions(screen.getByTestId('cloud-todo-detail-status'), 'pending')
      } else {
        view.rerender(<TodoEditor {...props} item={{ ...item, status: 'in_review', version: 2 }} />)
      }
      await act(async () => {
        pending.reject(
          Object.assign(new Error('No authorized environment'), {
            detail: { error_code: 'RUNNER_ENVIRONMENT_UNAVAILABLE' },
          })
        )
      })
      expect(screen.getByTestId('cloud-todo-detail-status')).toHaveValue(
        change === 'draft' ? 'pending' : 'in_review'
      )
    }
  )

  it('restores rejected status changes without discarding the content draft', async () => {
    const user = userEvent.setup()
    const item = { ...baseItem, status: 'inbox' }
    const updateLoopItem = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('No execution environment is authorized for this selection'), {
        errorCode: 'RUNNER_ENVIRONMENT_UNAVAILABLE',
      })
    )
    const onUpdated = vi.fn()
    render(
      <TodoEditor
        mode="edit"
        item={item}
        project={project}
        allItems={[item]}
        onUpdated={onUpdated}
        onClose={vi.fn()}
        api={{ ...api, updateLoopItem } as never}
        currentUserId={1}
      />
    )
    await user.clear(screen.getByTestId('cloud-todo-detail-title'))
    await user.type(screen.getByTestId('cloud-todo-detail-title'), 'Keep my draft')
    await user.selectOptions(screen.getByTestId('cloud-todo-detail-status'), 'in_progress')
    await user.click(screen.getByTestId('cloud-todo-save'))

    expect(await screen.findByTestId('cloud-todo-save-error')).toHaveTextContent(
      '机器人没有符合配置且获项目授权的执行环境'
    )
    expect(screen.getByTestId('cloud-todo-detail-status')).toHaveValue('inbox')
    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveValue('Keep my draft')
    expect(onUpdated).not.toHaveBeenCalled()

    updateLoopItem.mockResolvedValueOnce({
      ...item,
      title: 'Keep my draft',
      status: 'in_progress',
      version: 2,
    })
    await user.selectOptions(screen.getByTestId('cloud-todo-detail-status'), 'in_progress')
    await user.click(screen.getByTestId('cloud-todo-save'))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce())
    expect(updateLoopItem).toHaveBeenLastCalledWith(item.id, {
      version: 1,
      title: 'Keep my draft',
      status: 'in_progress',
    })
    expect(screen.queryByTestId('cloud-todo-save-error')).not.toBeInTheDocument()
  })

  it('saves the status of a human assignment without a submission form', async () => {
    const user = userEvent.setup()
    const item = { ...baseItem, assignee_agent_id: '', assignee_user_id: 1 }
    const saved = { ...item, status: 'completed', version: 2 }
    const updateLoopItem = vi.fn(async () => saved)
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={item}
        project={project}
        allItems={[item]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={{ ...api, updateLoopItem } as never}
        currentUserId={1}
      />
    )
    expect(screen.queryByTestId('human-issue-work-panel')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByTestId('cloud-todo-detail-status'), 'completed')
    await user.click(screen.getByTestId('cloud-todo-save'))
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledExactlyOnceWith(item.id, {
        version: 1,
        status: 'completed',
      })
    )
    expect(screen.queryByTestId('human-issue-result')).not.toBeInTheDocument()
  })

  it('persists a title edit when execution changes the Issue version during saving', async () => {
    const user = userEvent.setup()
    const latest = { ...baseItem, version: 2, status: 'in_review' } as CloudLoopItem
    const saved = { ...latest, version: 3, title: 'Renamed while running' }
    const updateLoopItem = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('task changed'), { code: 'version_conflict' }))
      .mockResolvedValue(saved)
    const onUpdated = vi.fn()
    render(
      <TodoEditor
        mode="edit"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={onUpdated}
        onClose={vi.fn()}
        currentUserId={1}
        api={{ ...api, getLoopItem: vi.fn().mockResolvedValue(latest), updateLoopItem } as never}
      />
    )
    await user.clear(screen.getByTestId('cloud-todo-detail-title'))
    await user.paste(saved.title)
    await user.click(screen.getByTestId('cloud-todo-save'))
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledWith(saved))
    expect(updateLoopItem.mock.calls).toEqual([
      [baseItem.id, { version: 1, title: saved.title }],
      [baseItem.id, { version: 2, title: saved.title }],
    ])
  })

  it('retains the archive label and outside-click dismissal in the properties menu', async () => {
    const user = userEvent.setup()
    const onArchive = vi.fn()
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        onDelete={onArchive}
        deleteLabel="归档任务"
        api={api}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-more-properties'))
    expect(screen.getByTestId('cloud-todo-detail-delete')).toHaveTextContent('归档任务')
    await user.click(document.body)
    expect(screen.queryByTestId('cloud-todo-more-properties-popover')).not.toBeInTheDocument()
    expect(onArchive).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('cloud-todo-more-properties'))
    await user.click(screen.getByTestId('cloud-todo-detail-delete'))
    expect(onArchive).toHaveBeenCalledOnce()
  })

  it('keeps compact Issue properties unlabeled and explains the current status in a tooltip', async () => {
    const user = userEvent.setup()
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onAddChild={vi.fn()}
        onClose={vi.fn()}
        api={api}
        currentUserId={1}
      />
    )

    const summary = screen.getByTestId('cloud-todo-state-summary')
    expect(summary).not.toHaveTextContent('负责人')
    expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('agent-1')
    expect(screen.getByRole('button', { name: '时间范围' })).toHaveTextContent('添加日期')

    await user.hover(screen.getByTestId('cloud-todo-detail-status').parentElement!)

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '状态：进行中。表示 Issue 当前所处的处理阶段。'
    )
  })

  it('opens the due date picker from the bottom property row and saves the date', async () => {
    const user = userEvent.setup()
    const updateLoopItem = vi.fn(async (_itemId: string, values: Record<string, unknown>) => ({
      ...baseItem,
      ...values,
      version: 2,
    }))
    const editableApi = {
      ...api,
      updateLoopItem,
    } as never

    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={editableApi}
        currentUserId={1}
      />
    )

    await user.click(screen.getByRole('button', { name: '时间范围' }))
    const dueDateInput = await screen.findByTestId('cloud-todo-detail-due-date')
    const showPicker = vi.fn()
    Object.defineProperty(dueDateInput, 'showPicker', {
      configurable: true,
      value: showPicker,
    })

    await user.click(dueDateInput)
    expect(showPicker).toHaveBeenCalledOnce()

    await user.type(dueDateInput, '2026-10-31')
    await user.click(screen.getByTestId('cloud-todo-save'))

    await vi.waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith(
        baseItem.id,
        expect.objectContaining({ due_at: '2026-10-31' })
      )
    )
  })

  it('offers unused view tags and saves priority and tag edits from the properties menu', async () => {
    const user = userEvent.setup()
    const updateLoopItem = vi.fn(async (_itemId: string, values: Record<string, unknown>) => ({
      ...baseItem,
      ...values,
      version: 2,
    }))
    const editableApi = {
      ...api,
      updateLoopItem,
    } as never

    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={baseItem}
        project={{
          ...project,
          tags: ['bug'],
          board_views: {
            schema_version: 1,
            views: [
              {
                id: 'mixed',
                name: 'Mixed',
                columns: [
                  { id: 'release', type: 'tag', value: 'release' },
                  { id: 'test', type: 'tag', value: '测试' },
                ],
                filter: { tags: ['需求'] },
              },
            ],
          },
        }}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={editableApi}
        currentUserId={1}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-more-properties'))
    await user.selectOptions(screen.getByTestId('cloud-todo-detail-priority'), 'urgent')
    const tagInput = screen.getByTestId('cloud-todo-detail-tag-input')
    await user.click(tagInput)
    expect(tagInput).toHaveFocus()
    for (const tag of ['bug', 'release', '测试', '需求'])
      expect(screen.getByTestId(`cloud-todo-detail-tag-suggestion-${tag}`)).toBeVisible()
    await user.type(tagInput, 'release{Enter}')
    await user.click(screen.getByTestId('cloud-todo-save'))

    await vi.waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith(
        baseItem.id,
        expect.objectContaining({
          priority: 'urgent',
          tags: ['release'],
        })
      )
    )
  })

  it('keeps the more-properties menu actions operable', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    const addLoopItemCollaborator = vi.fn(async () => ({
      id: 'collaborator-7',
      loop_item_id: baseItem.id,
      user_id: 7,
      user_name: '张三',
      email: null,
      source: 'manual',
      added_by_user_id: 1,
      created_at: '2026-10-09T00:00:00Z',
    }))
    const menuApi = {
      ...api,
      listCloudProjectMembers: vi.fn(async () => [
        {
          id: 7,
          user_id: 7,
          user_name: '张三',
          email: null,
          role: 'Developer',
        },
      ]),
      addLoopItemCollaborator,
    } as never

    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        onDelete={onDelete}
        api={menuApi}
        currentUserId={1}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-more-properties'))
    await user.click(screen.getByTestId('cloud-todo-add-collaborator'))
    await user.selectOptions(screen.getByTestId('cloud-todo-collaborator-select'), '7')
    await user.click(screen.getByTestId('cloud-todo-confirm-collaborator'))

    await vi.waitFor(() => expect(addLoopItemCollaborator).toHaveBeenCalledWith(baseItem.id, 7))
    expect(await screen.findByRole('button', { name: '移除参与者 张三' })).toBeInTheDocument()

    await user.click(screen.getByTestId('cloud-todo-detail-delete'))
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it('retains an uncommitted tag draft when Escape closes the properties popover', async () => {
    const user = userEvent.setup()
    const updateLoopItem = vi.fn(async (_id: string, values: Record<string, unknown>) => ({
      ...baseItem,
      ...values,
      version: 2,
    }))
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={{ ...api, updateLoopItem } as never}
        currentUserId={1}
      />
    )

    const trigger = screen.getByTestId('cloud-todo-more-properties')
    await user.click(trigger)
    await user.type(screen.getByTestId('cloud-todo-detail-tag-input'), 'draft-tag')
    await user.keyboard('{Escape}')

    expect(screen.queryByTestId('cloud-todo-more-properties-popover')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    await user.click(trigger)
    expect(screen.getByTestId('cloud-todo-detail-tag-tag-draft-tag')).toBeInTheDocument()
    await user.click(screen.getByTestId('cloud-todo-save'))
    await vi.waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith(
        baseItem.id,
        expect.objectContaining({ tags: ['draft-tag'] })
      )
    )
  })

  it('exposes metadata without editable controls for a read-only Issue', async () => {
    const user = userEvent.setup()
    const item = { ...baseItem, can_edit: false, project_store: 'backend' } as CloudLoopItem
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={item}
        project={project}
        allItems={[item]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        api={api}
        currentUserId={1}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-more-properties'))
    expect(screen.getByRole('dialog', { name: '更多信息' })).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-detail-priority')).toBeDisabled()
    expect(screen.getByTestId('cloud-todo-add-collaborator')).toBeDisabled()
    expect(screen.queryByTestId('cloud-todo-detail-tag-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-detail-delete')).not.toBeInTheDocument()
  })

  it('uses collaboration translations for runtime configuration notices', async () => {
    const item = {
      ...baseItem,
      execution_id: 627,
      execution_state: 'waiting_runtime',
      assignee_agent_name: '检查智能体',
    } as CloudLoopItem
    render(
      <TodoEditor
        mode="edit"
        item={item}
        project={project}
        allItems={[item]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={api}
        presentation="workspace-panel"
      />
    )

    expect(await screen.findByText(/缺少设备或模型配置/)).toBeInTheDocument()
    expect(screen.queryByText('runtimeSettings.executionBlocked')).not.toBeInTheDocument()
    expect(screen.queryByText('runtimeSettings.ownerRequired')).not.toBeInTheDocument()
  })

  it('preserves shared detail translation interpolation options', async () => {
    const deliveryApi = {
      ...api,
      listDeliveries: vi.fn(async () => ({
        items: [
          {
            id: 'delivery-1',
            loop_item_id: baseItem.id,
            created_by_user_id: 1,
            source_task_binding_id: null,
            source_task_snapshot: null,
            status: 'delivered',
            created_at: '2026-09-12T00:00:00Z',
            delivered_at: '2026-09-12T00:00:00Z',
            assets: [
              {
                id: 'asset-1',
                kind: 'file',
                display_name: 'result.txt',
                relative_path: 'result.txt',
                content_type: 'text/plain',
                size_bytes: 6,
                sha256: 'sha256',
              },
            ],
            fulfillments: [],
          },
        ],
      })),
    } as never

    render(
      <TodoEditor
        mode="edit"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={deliveryApi}
        currentUserId={1}
        presentation="workspace-panel"
      />
    )

    expect(await screen.findByTestId('todo-detail-deliveries')).toHaveTextContent('1 个附件')
  })

  it('fails closed for cloud Issue editing when can_edit is missing', async () => {
    const updateLoopItem = vi.fn()
    const readOnlyApi = {
      ...api,
      updateLoopItem,
    } as never

    render(
      <TodoEditor
        mode="edit"
        item={{ ...baseItem, can_edit: undefined, project_store: 'backend' }}
        project={{ ...project, project_store: 'backend' }}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={readOnlyApi}
        currentUserId={1}
      />
    )

    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveAttribute('readonly')
    expect(screen.getByTestId('cloud-todo-detail-status')).toBeDisabled()
    expect(screen.getByTestId('cloud-todo-detail-priority')).toBeDisabled()
    expect(screen.queryByTestId('cloud-todo-attachment-input')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-todo-detail'))
    expect(updateLoopItem).not.toHaveBeenCalled()
  })

  it('does not add a manual execution entry to the Issue drawer', async () => {
    const onCreateTask = vi.fn()
    const assignedToSomeoneElse = {
      ...baseItem,
      can_view_detail: true,
      can_edit: false,
      assignee_user_id: 42,
      assignee_agent_id: null,
      project_store: 'backend' as const,
    }

    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={assignedToSomeoneElse}
        project={{ ...project, project_store: 'backend' }}
        allItems={[assignedToSomeoneElse]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        onCreateTask={onCreateTask}
        api={api}
        currentUserId={1}
      />
    )

    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveAttribute('readonly')
    expect(screen.queryByTestId('cloud-todo-create-task')).not.toBeInTheDocument()
    expect(onCreateTask).not.toHaveBeenCalled()
  })

  it('shows a private task action for an Issue assigned to the current user', async () => {
    const onCreateTask = vi.fn()
    const assignedToCurrentUser = {
      ...baseItem,
      can_view_detail: true,
      can_edit: false,
      assignee_user_id: 1,
      assignee_agent_id: null,
      project_store: 'backend' as const,
    }

    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={assignedToCurrentUser}
        project={{ ...project, project_store: 'backend' }}
        allItems={[assignedToCurrentUser]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        onCreateTask={onCreateTask}
        api={api}
        currentUserId={1}
      />
    )

    expect(screen.getByTestId('cloud-todo-personal-task-action')).toHaveTextContent(
      '让 AI 帮我处理'
    )
    expect(screen.getByTestId('cloud-todo-personal-task-action')).toHaveTextContent(
      '基于当前 Issue 创建任务，并在当前电脑上运行'
    )
    await userEvent.click(screen.getByTestId('cloud-todo-personal-task-start'))
    expect(onCreateTask).toHaveBeenCalledOnce()
  })

  it.each([
    { binding_type: 'system', task_user_id: 1, continuation: false },
    { binding_type: 'user', task_user_id: null, continuation: false },
    { binding_type: 'user', task_user_id: 1, continuation: false },
  ] as const)(
    'keeps AI assist available with $binding_type binding and user $task_user_id',
    async binding => {
      const onCreateTask = vi.fn()
      const onOpenTaskConversation = vi.fn()
      const item = {
        ...baseItem,
        assignee_user_id: 1,
        assignee_agent_id: null,
        can_view_detail: true,
      }
      const taskBinding = {
        id: 99,
        ...binding,
        device_id: 'local-device',
        task_id: 'bound-task',
        task_title: 'Bound task',
        linked_at: '2026-10-14T08:00:00Z',
        loop_item_id: item.id,
      }
      render(
        <TodoEditor
          mode="edit"
          presentation="workspace-panel"
          item={item}
          project={project}
          allItems={[item]}
          api={api}
          currentUserId={1}
          onUpdated={vi.fn()}
          onClose={vi.fn()}
          onCreateTask={onCreateTask}
          onOpenTaskConversation={onOpenTaskConversation}
          initialTaskBindings={[taskBinding as unknown as LoopItemTaskBinding]}
        />
      )
      if (binding.task_user_id === 1) {
        await screen.findByTestId('cloud-todo-tasks')
      } else {
        expect(screen.queryByTestId('cloud-todo-tasks')).not.toBeInTheDocument()
      }
      await userEvent.click(screen.getByTestId('cloud-todo-personal-task-start'))
      expect(onCreateTask).toHaveBeenCalledOnce()
      expect(onOpenTaskConversation).not.toHaveBeenCalled()
      expect(screen.getByTestId('cloud-todo-personal-task-start')).toHaveTextContent('创建任务')
    }
  )

  it('shows running and recent tasks directly and uses expand only for the remaining tasks', async () => {
    const onCreateTask = vi.fn()
    const assignedToCurrentUser = {
      ...baseItem,
      can_view_detail: true,
      can_edit: false,
      assignee_user_id: 1,
      assignee_agent_id: null,
      project_store: 'backend' as const,
    }

    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={assignedToCurrentUser}
        project={{ ...project, project_store: 'backend' }}
        allItems={[assignedToCurrentUser]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        onCreateTask={onCreateTask}
        initialTaskBindings={[
          {
            id: 1,
            task_user_id: 1,
            device_id: 'local-device',
            task_id: 'running-task',
            task_title: '仍在运行的任务',
            linked_at: '2026-10-08T08:00:00Z',
          },
          {
            id: 2,
            task_user_id: 1,
            device_id: 'local-device',
            task_id: 'older-task',
            task_title: '较早完成的任务',
            linked_at: '2026-10-08T09:00:00Z',
          },
          {
            id: 3,
            task_user_id: 1,
            device_id: 'local-device',
            task_id: 'recent-task',
            task_title: '最近完成的任务',
            linked_at: '2026-10-08T10:00:00Z',
          },
        ]}
        taskExecutionStates={{
          '1': { status: 'running' },
          '2': { status: 'succeeded' },
          '3': { status: 'succeeded' },
        }}
        api={api}
        currentUserId={1}
      />
    )

    expect(await screen.findByText('仍在运行的任务')).toBeInTheDocument()
    expect(screen.getByText('最近完成的任务')).toBeInTheDocument()
    expect(screen.queryByText('较早完成的任务')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-personal-task-action')).toBeInTheDocument()

    const toggle = screen.getByTestId('cloud-todo-toggle-tasks')
    expect(toggle).toHaveTextContent('查看全部 3 个')
    expect(screen.getByTestId('cloud-todo-tasks')).toContainElement(toggle)
    expect(screen.getByTestId('cloud-todo-state-summary')).not.toContainElement(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)

    expect(screen.getByText('较早完成的任务')).toBeInTheDocument()
    expect(toggle).toHaveTextContent('收起')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(screen.getByTestId('cloud-todo-create-task'))
    expect(onCreateTask).toHaveBeenCalledOnce()
  })

  it('uses the Issue assignee when older active assignment records still exist', () => {
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={{
          ...baseItem,
          assignee_user_id: 1,
          assignee_agent_id: null,
          project_store: 'backend',
        }}
        project={{ ...project, project_store: 'backend' }}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        onCreateTask={vi.fn()}
        currentAssignment={{
          id: 'assignment-agent',
          issue_id: baseItem.id,
          target_type: 'agent',
          target_id: 'agent-1',
          target_name: 'Agent',
          body: null,
          comment_id: null,
          created_by_user_id: 2,
          created_by_user_name: 'Manager',
          status: 'active',
          created_at: '2026-10-08T10:00:00Z',
          updated_at: '2026-10-08T10:00:00Z',
        }}
        api={api}
        currentUserId={1}
      />
    )

    expect(screen.getByTestId('cloud-todo-personal-task-action')).toBeInTheDocument()
  })

  it('does not add a default-assistant execution entry to the Issue drawer', async () => {
    const onCreateTask = vi.fn()

    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={{ ...baseItem, project_store: 'local' }}
        project={{ ...project, project_store: 'local' }}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        onCreateTask={onCreateTask}
        defaultAssistant={{
          name: '本机助手',
          description: '在“我的 Mac”上运行，使用设备当前可用能力',
          capabilitySummary: '2 个插件 · 3 个 Skill · 本地文件与桌面操作',
        }}
        api={api}
        currentUserId={1}
      />
    )

    expect(screen.queryByTestId('cloud-todo-default-assistant')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-create-task')).not.toBeInTheDocument()
    expect(onCreateTask).not.toHaveBeenCalled()
  })

  it('keeps trusted local Issue editing enabled through an explicit local marker', async () => {
    const user = userEvent.setup()
    const localItem = {
      ...baseItem,
      can_edit: undefined,
      project_store: 'local' as const,
    }
    const updateLoopItem = vi.fn(async (_itemId, values) => ({
      ...localItem,
      ...values,
      version: 2,
    }))
    const localApi = {
      ...api,
      updateLoopItem,
    } as never

    render(
      <TodoEditor
        mode="edit"
        item={localItem}
        project={{ ...project, project_store: 'local' }}
        allItems={[localItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={localApi}
        currentUserId={1}
      />
    )

    expect(screen.getByTestId('cloud-todo-detail-title')).not.toHaveAttribute('readonly')
    expect(screen.getByTestId('cloud-todo-detail-status')).not.toBeDisabled()
    expect(screen.getByTestId('cloud-todo-detail-priority')).not.toBeDisabled()
    expect(screen.getByTestId('cloud-todo-attachment-input')).toBeInTheDocument()

    await user.clear(screen.getByTestId('cloud-todo-detail-title'))
    await user.paste('Local editable Issue')
    await user.click(screen.getByTestId('cloud-todo-save'))

    await vi.waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith(
        localItem.id,
        expect.objectContaining({ title: 'Local editable Issue' })
      )
    )
  })

  it('renders local task bindings without waiting for independent remote directories', async () => {
    const never = new Promise<never>(() => undefined)
    const fastBindingsApi = {
      listDeliveries: vi.fn(() => never),
      listTaskBindings: vi.fn(async () => [
        {
          id: 7,
          device_id: 'local-device',
          task_user_id: 1,
          task_id: 'local-task',
          task_title: '立即显示的本地任务',
        },
      ]),
      listLoopItemAttachments: vi.fn(() => never),
      listLoopItemCollaborators: vi.fn(() => never),
      listCloudProjectMembers: vi.fn(() => never),
    } as never
    const projectChatAgentApi = {
      list: vi.fn(() => never),
    } as never
    const teamApi = {
      listTeams: vi.fn(() => never),
    } as never

    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onAddChild={vi.fn()}
        onClose={vi.fn()}
        api={fastBindingsApi}
        projectChatAgentApi={projectChatAgentApi}
        teamApi={teamApi}
        deviceNamesById={{ 'local-device': '开发设备' }}
        selectedTaskId="local-task"
        taskExecutionStates={{ '7': { status: 'running' } }}
        currentUserId={1}
      />
    )

    const taskRow = await screen.findByTestId('cloud-todo-open-task-conversation-7')
    expect(screen.queryByTestId('cloud-todo-toggle-tasks')).not.toBeInTheDocument()
    expect(taskRow).toHaveTextContent('立即显示的本地任务')
    expect(taskRow).toHaveTextContent('开发设备')
    expect(taskRow).toHaveTextContent('执行中')
    expect(taskRow).toHaveTextContent('当前会话')
    expect(taskRow).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('cloud-todo-task-status-7')).toHaveAttribute('data-status', 'running')
    expect(taskRow).not.toHaveTextContent('local-device')
  })

  it('shows board task bindings immediately while the detail refresh is pending', async () => {
    const never = new Promise<never>(() => undefined)
    const pendingBindings = deferred<LoopItemTaskBinding[]>()
    const pendingBindingsApi = {
      listDeliveries: vi.fn(() => never),
      listTaskBindings: vi.fn(() => pendingBindings.promise),
      listLoopItemAttachments: vi.fn(() => never),
      listLoopItemCollaborators: vi.fn(() => never),
      listCloudProjectMembers: vi.fn(() => never),
    } as never
    const projectChatAgentApi = {
      list: vi.fn(() => never),
    } as never
    const teamApi = {
      listTeams: vi.fn(() => never),
    } as never

    const { rerender } = render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={pendingBindingsApi}
        projectChatAgentApi={projectChatAgentApi}
        teamApi={teamApi}
        currentUserId={1}
      />
    )

    expect(screen.queryByTestId('cloud-todo-toggle-tasks')).not.toBeInTheDocument()

    rerender(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={pendingBindingsApi}
        projectChatAgentApi={projectChatAgentApi}
        teamApi={teamApi}
        initialTaskBindings={[
          {
            id: 8,
            device_id: 'local-device',
            task_user_id: 1,
            task_id: 'board-task',
            task_title: '看板已加载的任务',
          },
        ]}
        currentUserId={1}
      />
    )

    expect(await screen.findByTestId('cloud-todo-open-task-conversation-8')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-toggle-tasks')).not.toBeInTheDocument()

    await act(async () => {
      pendingBindings.resolve([])
      await pendingBindings.promise
    })

    expect(screen.getByTestId('cloud-todo-open-task-conversation-8')).toHaveTextContent(
      '看板已加载的任务'
    )
  })

  it('uses refreshed board binding context instead of the stale detail copy', async () => {
    const never = new Promise<never>(() => undefined)
    const onOpenTaskConversation = vi.fn()
    const pendingBindingsApi = {
      listDeliveries: vi.fn(() => never),
      listTaskBindings: vi.fn(() => never),
      listLoopItemAttachments: vi.fn(() => never),
      listLoopItemCollaborators: vi.fn(() => never),
      listCloudProjectMembers: vi.fn(() => never),
    } as never
    const initialBinding = {
      id: 8,
      device_id: 'local-device',
      task_user_id: 1,
      task_id: 'board-task',
      task_title: '看板任务',
    }
    const renderEditor = (executionContext?: { workspacePath: string; workspaceKind: string }) => (
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={pendingBindingsApi}
        initialTaskBindings={[
          {
            ...initialBinding,
            executionContext,
          },
        ]}
        onOpenTaskConversation={onOpenTaskConversation}
        currentUserId={1}
      />
    )
    const view = render(renderEditor())

    view.rerender(
      renderEditor({
        workspacePath: '/tmp/issue-worktree',
        workspaceKind: 'worktree',
      })
    )
    await userEvent.click(screen.getByTestId('cloud-todo-open-task-conversation-8'))

    expect(onOpenTaskConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        executionContext: {
          workspacePath: '/tmp/issue-worktree',
          workspaceKind: 'worktree',
        },
      })
    )
  })

  it('keeps same-item data during refresh and clears it when switching items', async () => {
    const staleRefresh = deferred<LoopItemTaskBinding[]>()
    const switchingApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: 8,
            device_id: 'local-device',
            task_user_id: 1,
            task_id: 'first-task',
            task_title: '第一个 Issue 的任务',
          },
        ])
        .mockImplementationOnce(() => staleRefresh.promise)
        .mockResolvedValueOnce([
          {
            id: 9,
            device_id: 'local-device',
            task_user_id: 1,
            task_id: 'second-task',
            task_title: '第二个 Issue 的任务',
          },
        ]),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => []),
    } as never
    const secondItem = {
      ...baseItem,
      id: 'WEG-2',
      title: 'Second issue',
    } as unknown as CloudLoopItem
    const renderEditor = (item: CloudLoopItem, taskRefreshKey: number) => (
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={item}
        project={project}
        allItems={[baseItem, secondItem]}
        onUpdated={vi.fn()}
        onAddChild={vi.fn()}
        onClose={vi.fn()}
        api={switchingApi}
        taskRefreshKey={taskRefreshKey}
        currentUserId={1}
      />
    )
    const view = render(renderEditor(baseItem, 0))

    expect(await screen.findByText('第一个 Issue 的任务')).toBeInTheDocument()

    view.rerender(renderEditor(baseItem, 1))
    expect(screen.getByText('第一个 Issue 的任务')).toBeInTheDocument()

    view.rerender(renderEditor(secondItem, 1))
    expect(await screen.findByText('第二个 Issue 的任务')).toBeInTheDocument()
    expect(screen.queryByText('第一个 Issue 的任务')).not.toBeInTheDocument()

    await act(async () => {
      staleRefresh.resolve([
        {
          id: 10,
          device_id: 'local-device',
          task_user_id: 1,
          task_id: 'stale-task',
          task_title: '过期刷新结果',
        },
      ])
      await staleRefresh.promise
    })

    expect(screen.queryByText('过期刷新结果')).not.toBeInTheDocument()
  })

  it('preserves loaded collaboration groups while the same Issue refreshes', async () => {
    const pendingRefresh = deferred<never[]>()
    const collaborationGroup = {
      id: 'group-1',
      name: '性能诊断协作小组',
      members: [],
      stages: [],
    }
    const listCollaborationGroups = vi
      .fn()
      .mockResolvedValueOnce([collaborationGroup])
      .mockImplementationOnce(() => pendingRefresh.promise)
    const sharedApi = {
      projects: { listCollaborationGroups },
      issues: { update: vi.fn(), assign: vi.fn() },
      attachments: {
        list: vi.fn(async () => []),
        upload: vi.fn(),
        read: vi.fn(),
        download: vi.fn(),
        remove: vi.fn(),
      },
      collaborators: {
        list: vi.fn(async () => []),
        add: vi.fn(),
        remove: vi.fn(),
      },
      taskBindings: { list: vi.fn(async () => []) },
      members: { list: vi.fn(async () => []) },
      agents: { list: vi.fn(async () => []) },
      deliveries: {
        list: vi.fn(async () => []),
        get: vi.fn(),
      },
    } as never
    const renderEditor = (taskRefreshKey: number) => (
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={baseItem}
        project={{ ...project, access_role: 'Owner', collaboration_groups: [] }}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        sharedApi={sharedApi}
        taskRefreshKey={taskRefreshKey}
        currentUserId={1}
      />
    )
    const view = render(renderEditor(0))

    await waitFor(() => expect(listCollaborationGroups).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByTestId('cloud-todo-detail-assignee'))
    expect(
      await screen.findByTestId('cloud-todo-detail-assignee-option-group:group-1')
    ).toHaveTextContent('性能诊断协作小组')

    view.rerender(renderEditor(1))

    expect(listCollaborationGroups).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('cloud-todo-detail-assignee-option-group:group-1')).toHaveTextContent(
      '性能诊断协作小组'
    )

    await act(async () => {
      pendingRefresh.resolve([])
      await pendingRefresh.promise
    })
    expect(
      screen.queryByTestId('cloud-todo-detail-assignee-option-group:group-1')
    ).not.toBeInTheDocument()
  })

  it('shows the automation provenance on a generated task', () => {
    render(
      editorElement({
        ...baseItem,
        automation: {
          rule_id: 'rule-1',
          run_id: 'run-1',
          trigger: 'scheduled',
        },
      })
    )

    expect(screen.getByTestId('cloud-todo-automation-source')).toHaveTextContent(
      '自动化 · 定时触发'
    )
  })

  it('adopts an external version update in place instead of remounting', () => {
    const view = render(editorElement(baseItem))
    expect(screen.getByTestId('cloud-todo-detail-status')).toHaveValue('in_progress')

    view.rerender(editorElement({ ...baseItem, version: 2, status: 'in_review' }))

    expect(screen.getByTestId('cloud-todo-detail-status')).toHaveValue('in_review')
    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveValue('Inspect changes')
  })

  it.each([false, true])(
    'hydrates the current delivery without discarding a delayed list (history=%s)',
    async includeHistory => {
      const currentDelivery = {
        id: 'delivery-1',
        loop_item_id: baseItem.id,
        created_by_user_id: 1,
        source_task_binding_id: null,
        source_task_snapshot: null,
        status: 'delivered',
        created_at: '2026-09-15T13:55:16Z',
        delivered_at: '2026-09-15T13:55:16Z',
        markdown: '',
        chat: {
          scope: 'selected',
          messages: [
            { role: 'user', content: '请分析下载原因' },
            { role: 'assistant', content: '**结论**：来自定时任务。' },
          ],
        },
        assets: [
          {
            id: 'asset-1',
            kind: 'file',
            display_name: 'result.txt',
            relative_path: 'result.txt',
            content_type: 'text/plain',
            size_bytes: 6,
            sha256: 'sha256',
          },
        ],
        fulfillments: [],
      }
      const initialDeliveryList = deferred<{ items: (typeof currentDelivery)[] }>()
      const historicalDelivery = { ...currentDelivery, id: 'delivery-older', markdown: '此前交付' }
      const deliveryApi = {
        ...api,
        listDeliveries: vi.fn(() => initialDeliveryList.promise),
        getDelivery: vi.fn(async () => currentDelivery),
      } as never
      const renderEditor = (item: CloudLoopItem) => (
        <TodoEditor
          mode="edit"
          presentation="workspace-panel"
          item={item}
          project={project}
          allItems={[item]}
          onUpdated={vi.fn()}
          onClose={vi.fn()}
          api={deliveryApi}
          currentUserId={1}
        />
      )
      const view = render(renderEditor(baseItem))

      view.rerender(
        renderEditor({
          ...baseItem,
          status: 'completed',
          current_delivery_id: currentDelivery.id,
          version: 2,
        })
      )

      expect(await screen.findByTestId('todo-detail-deliveries')).toHaveTextContent('1 个附件')
      expect(deliveryApi.getDelivery).toHaveBeenCalledWith(currentDelivery.id)

      await act(async () => {
        initialDeliveryList.resolve({ items: includeHistory ? [historicalDelivery] : [] })
        await initialDeliveryList.promise
      })

      expect(screen.getByTestId('todo-detail-deliveries')).toHaveTextContent('1 个附件')

      if (includeHistory) {
        expect(screen.getByTestId('todo-detail-open-delivery-delivery-older')).toHaveTextContent(
          '此前交付'
        )
      }

      await userEvent.click(screen.getByTestId('todo-detail-open-delivery-delivery-1'))
      const chat = await screen.findByTestId('todo-detail-delivery-chat')
      const deliveryPanel = screen.getByTestId('todo-detail-delivery-panel')
      expect(deliveryPanel).toHaveClass('task-detail-workspace-panel-shell', 'relative', 'h-full')
      expect(deliveryPanel).not.toHaveClass('fixed')
      expect(screen.queryByText('无交付说明')).not.toBeInTheDocument()
      expect(chat).toHaveTextContent('请分析下载原因')
      expect(chat).toHaveTextContent('结论：来自定时任务。')
      expect(within(chat).getByText('结论').tagName).toBe('STRONG')
      expect(screen.getByText('result.txt')).toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: '返回' }))
      await userEvent.click(screen.getByTestId('todo-detail-open-delivery-delivery-1'))
      expect(await screen.findByTestId('todo-detail-delivery-chat')).toHaveTextContent(
        '结论：来自定时任务。'
      )
    }
  )

  it('retains the committed delivery when a newer render suspends', async () => {
    const currentDelivery = {
      id: 'delivery-current',
      loop_item_id: baseItem.id,
      created_by_user_id: 1,
      source_task_binding_id: null,
      source_task_snapshot: null,
      status: 'delivered',
      created_at: '2026-09-15T13:55:16Z',
      delivered_at: '2026-09-15T13:55:16Z',
      markdown: 'Committed delivery',
      chat: null,
      assets: [],
      fulfillments: [],
    }
    const olderDelivery = { ...currentDelivery, id: 'delivery-older', markdown: 'Older delivery' }
    const deliveryList = deferred<{ items: (typeof currentDelivery)[] }>()
    const suspended = deferred<void>()
    const deliveryApi = {
      ...api,
      listDeliveries: vi.fn(() => deliveryList.promise),
      getDelivery: vi.fn(async () => currentDelivery),
    } as never
    let beginUpdate = () => {}
    let attemptedSuspendedRender = false
    function SuspendGate({ pending }: { pending: boolean }) {
      if (pending) {
        attemptedSuspendedRender = true
        throw suspended.promise
      }
      return null
    }
    function Harness() {
      const [pending, setPending] = useState(false)
      beginUpdate = () => startTransition(() => setPending(true))
      const item = {
        ...baseItem,
        current_delivery_id: pending ? 'delivery-uncommitted' : currentDelivery.id,
      }
      return (
        <Suspense fallback={<div data-testid="pending-delivery-render" />}>
          <TodoEditor
            mode="edit"
            presentation="workspace-panel"
            item={item}
            project={project}
            allItems={[item]}
            onUpdated={vi.fn()}
            onClose={vi.fn()}
            api={deliveryApi}
          />
          <SuspendGate pending={pending} />
        </Suspense>
      )
    }
    render(<Harness />)
    expect(
      await screen.findByTestId('todo-detail-open-delivery-delivery-current')
    ).toHaveTextContent('Committed delivery')
    await act(async () => beginUpdate())
    expect(attemptedSuspendedRender).toBe(true)
    expect(screen.queryByTestId('pending-delivery-render')).not.toBeInTheDocument()
    await act(async () => {
      deliveryList.resolve({ items: [olderDelivery] })
      await deliveryList.promise
    })
    expect(screen.getByTestId('todo-detail-open-delivery-delivery-current')).toHaveTextContent(
      'Committed delivery'
    )
    expect(screen.getByTestId('todo-detail-open-delivery-delivery-older')).toHaveTextContent(
      'Older delivery'
    )
  })

  it('hydrates placeholder fields when the same issue version finishes loading', () => {
    const placeholder = { ...baseItem, title: '', description: '' }
    const view = render(editorElement(placeholder))
    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveValue('')

    view.rerender(editorElement(baseItem))

    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveValue('Inspect changes')
  })

  it('keeps user edits when an external version update arrives', async () => {
    const user = userEvent.setup()
    const view = render(editorElement(baseItem))
    await user.type(screen.getByTestId('cloud-todo-detail-title'), ' 手工补充')

    view.rerender(editorElement({ ...baseItem, version: 2, status: 'completed' }))

    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveValue('Inspect changes 手工补充')
    expect(screen.getByTestId('cloud-todo-detail-status')).toHaveValue('completed')
  })

  it.each([true, false])('assigns a member with notification choice %s', async notify => {
    const user = userEvent.setup()
    const assignApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => [
        {
          id: 5,
          user_id: 5,
          user_name: '张三',
          email: null,
          role: 'Developer',
        },
      ]),
      updateLoopItem: vi.fn(async () => ({ ...baseItem, version: 2 })),
      assignLoopItem: vi.fn(async () => ({
        ...baseItem,
        version: 2,
        assignee_user_id: 5,
        assignee_agent_id: null,
      })),
    } as never
    const ownerProject = { ...project, access_role: 'Owner' } as unknown as CloudProject
    render(
      <TodoEditor
        mode="edit"
        item={baseItem}
        project={ownerProject}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onAddChild={vi.fn()}
        onClose={vi.fn()}
        api={assignApi}
        currentUserId={1}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-detail-assignee-option-user:5'))
    expect(screen.queryByText('是否通知负责人')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-save')).toHaveTextContent('保存并通知')
    if (notify) {
      await user.click(screen.getByTestId('cloud-todo-save'))
    } else {
      await user.click(screen.getByTestId('cloud-todo-save-options'))
      await user.click(screen.getByRole('menuitem', { name: '仅保存不通知' }))
    }

    await vi.waitFor(() => {
      expect(assignApi.assignLoopItem).toHaveBeenCalledWith('11', 'WEG-1', {
        version: 1,
        assigneeType: 'user',
        assigneeId: '5',
        notifyAssignee: notify,
      })
    })
  })

  it('clears a member assignee through the update route instead of the assign route', async () => {
    const user = userEvent.setup()
    const memberItem = {
      ...baseItem,
      assignee_user_id: 5,
      assignee_agent_id: null,
    }
    const clearApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => [
        {
          id: 5,
          user_id: 5,
          user_name: '张三',
          email: null,
          role: 'Developer',
        },
      ]),
      updateLoopItem: vi.fn(async () => ({
        ...memberItem,
        version: 2,
        assignee_user_id: null,
        assignee_agent_id: null,
      })),
      assignLoopItem: vi.fn(async () => memberItem),
    } as never
    const ownerProject = { ...project, access_role: 'Owner' } as unknown as CloudProject
    render(
      <TodoEditor
        mode="edit"
        item={memberItem}
        project={ownerProject}
        allItems={[memberItem]}
        onUpdated={vi.fn()}
        onAddChild={vi.fn()}
        onClose={vi.fn()}
        api={clearApi}
        currentUserId={1}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-detail-assignee-option-empty'))
    await user.click(screen.getByTestId('cloud-todo-save'))

    await vi.waitFor(() => {
      expect(clearApi.updateLoopItem).toHaveBeenLastCalledWith('WEG-1', {
        version: 1,
        assignee_user_id: null,
        assignee_agent_id: null,
        assignee_team_id: null,
      })
    })
    expect(clearApi.assignLoopItem).not.toHaveBeenCalled()
  })

  it('assigns an accessible Wegent agent as a Team target', async () => {
    const user = userEvent.setup()
    const teamApi = {
      listTeams: vi.fn(async () => [
        {
          id: 42,
          name: 'review-team',
          namespace: 'default',
          displayName: '评审智能体',
          is_active: true,
        },
      ]),
    } as never
    const assignApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => []),
      updateLoopItem: vi.fn(async () => ({ ...baseItem, version: 2 })),
      assignLoopItem: vi.fn(async () => ({
        ...baseItem,
        version: 2,
        assignee_agent_id: null,
        assignee_team_id: 42,
        assignee_team_name: '评审智能体',
      })),
    } as never
    const ownerProject = { ...project, access_role: 'Owner' } as unknown as CloudProject
    render(
      <TodoEditor
        mode="edit"
        item={baseItem}
        project={ownerProject}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onAddChild={vi.fn()}
        onClose={vi.fn()}
        api={assignApi}
        teamApi={teamApi}
        projectChatAgentApi={
          {
            list: vi.fn(async () => [
              { id: 'enabled-42', name: 'Project binding', status: 'active', wegentTeamId: 42 },
            ]),
          } as never
        }
        currentUserId={1}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-detail-assignee-option-team:42'))
    await user.click(screen.getByTestId('cloud-todo-save'))

    await vi.waitFor(() => {
      expect(assignApi.assignLoopItem).toHaveBeenCalledWith('11', 'WEG-1', {
        version: 1,
        assigneeType: 'team',
        assigneeId: '42',
      })
    })
  })
})

describe('TodoEditor assignment chain', () => {
  async function openWorkspaceHistory(canEdit = true) {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const item = {
      ...baseItem,
      can_edit: canEdit,
      project_store: 'backend',
      assignment_history: [
        {
          by_user_id: 1,
          to_type: 'user',
          to_id: '2',
          to_name: '李四',
          action: 'assign',
          at: '2026-08-01T10:00:00Z',
        },
        {
          by_user_id: 2,
          to_type: 'agent',
          to_id: 'agent-1',
          to_name: '智能体A',
          action: 'reassign',
          at: '2026-08-02T11:30:00Z',
        },
      ],
    } as CloudLoopItem
    const updateLoopItem = vi.fn(async (_id: string, values: Record<string, unknown>) => ({
      ...item,
      ...values,
      version: 2,
    }))
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={item}
        project={project}
        allItems={[item]}
        onUpdated={vi.fn()}
        onClose={onClose}
        currentUserId={1}
        api={
          {
            ...api,
            updateLoopItem,
            listCloudProjectMembers: vi.fn(async () => [
              { user_id: 1, user_name: '张三', role: 'Developer' },
              { user_id: 2, user_name: '李四', role: 'Developer' },
            ]),
          } as never
        }
      />
    )
    const moreTrigger = screen.getByTestId('cloud-todo-more-properties')
    await user.click(moreTrigger)
    const properties = screen.getByTestId('cloud-todo-more-properties-popover')
    const historyTrigger = within(properties).getByTestId('cloud-todo-assignment-chain-trigger')
    return { user, item, properties, moreTrigger, historyTrigger, onClose, updateLoopItem }
  }

  it.each([true, false])(
    'expands history inside the same properties surface with can_edit=%s',
    async canEdit => {
      const { user, properties, moreTrigger, historyTrigger, onClose } =
        await openWorkspaceHistory(canEdit)
      const details = historyTrigger.closest('details')!
      const history = within(properties).getByTestId('cloud-todo-assignment-chain-popover')
      expect(details).not.toHaveAttribute('open')
      expect(history).not.toBeVisible()

      await user.click(historyTrigger)

      expect(details).toHaveAttribute('open')
      expect(history).toBeVisible()
      expect(screen.getByTestId('cloud-todo-more-properties-popover')).toBe(properties)
      expect(moreTrigger).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getAllByRole('dialog')).toHaveLength(1)
      expect(history).toHaveAttribute('role', 'region')
      expect(await within(history).findByText('张三')).toBeVisible()
      expect(history).toHaveTextContent('李四')
      expect(history).toHaveTextContent('智能体A')
      expect(history).toHaveTextContent('转派')
      expect(historyTrigger).toHaveTextContent('收起指派详情')

      await user.click(within(history).getByText('智能体A'))
      expect(moreTrigger).toHaveAttribute('aria-expanded', 'true')
      await user.click(historyTrigger)
      expect(details).not.toHaveAttribute('open')
      expect(history).not.toBeVisible()
      expect(properties).toBeVisible()
      expect(onClose).not.toHaveBeenCalled()
    }
  )

  it('preserves tag drafts while expanding and collapsing assignment history', async () => {
    const { user, item, properties, historyTrigger, updateLoopItem } = await openWorkspaceHistory()
    await user.type(within(properties).getByTestId('cloud-todo-detail-tag-input'), '保留草稿')
    await user.click(historyTrigger)
    await user.click(historyTrigger)
    expect(within(properties).getByTestId('cloud-todo-detail-tag-tag-保留草稿')).toBeVisible()

    await user.click(screen.getByTestId('cloud-todo-save'))
    await vi.waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({ tags: ['保留草稿'] })
      )
    )
  })

  it('dismisses the properties surface on Escape or outside click without closing the Issue', async () => {
    const { user, historyTrigger, moreTrigger, onClose } = await openWorkspaceHistory()
    await user.click(historyTrigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('cloud-todo-more-properties-popover')).not.toBeInTheDocument()
    expect(moreTrigger).toHaveFocus()
    expect(screen.getByTestId('cloud-todo-detail')).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()

    await user.click(moreTrigger)
    const nextTrigger = screen.getByTestId('cloud-todo-assignment-chain-trigger')
    expect(nextTrigger.closest('details')).not.toHaveAttribute('open')
    await user.click(nextTrigger)
    await user.click(screen.getByTestId('cloud-todo-detail-title'))
    expect(screen.queryByTestId('cloud-todo-more-properties-popover')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the assignment details in a popover triggered next to the assignee', async () => {
    const user = userEvent.setup()
    const chainApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => [
        { id: 1, user_id: 1, user_name: '张三', email: null, role: 'Developer' },
        { id: 2, user_id: 2, user_name: '李四', email: null, role: 'Developer' },
      ]),
    } as never
    const chainItem = {
      ...baseItem,
      assignment_history: [
        {
          by_user_id: 1,
          to_type: 'user' as const,
          to_id: '2',
          to_name: '李四',
          action: 'assign' as const,
          at: '2026-08-01T10:00:00',
        },
        {
          by_user_id: 2,
          to_type: 'agent' as const,
          to_id: 'agent-1',
          to_name: '智能体A',
          action: 'reassign' as const,
          at: '2026-08-02T11:30:00',
        },
      ],
    } as unknown as CloudLoopItem
    const onClose = vi.fn()
    render(
      <TodoEditor
        mode="edit"
        item={chainItem}
        project={project}
        allItems={[chainItem]}
        onUpdated={vi.fn()}
        onAddChild={vi.fn()}
        onClose={onClose}
        api={chainApi}
        currentUserId={1}
      />
    )

    expect(screen.queryByTestId('cloud-todo-assignment-chain')).not.toBeInTheDocument()
    const trigger = screen.getByTestId('cloud-todo-assignment-chain-trigger')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)

    const popover = screen.getByTestId('cloud-todo-assignment-chain-popover')
    expect(popover).toHaveTextContent('指派详情')
    expect(popover).toHaveTextContent('张三')
    expect(popover).toHaveTextContent('李四')
    expect(popover).toHaveTextContent('智能体A')
    expect(popover).toHaveTextContent('指派')
    expect(popover).toHaveTextContent('转派')

    await user.keyboard('{Escape}')

    expect(screen.queryByTestId('cloud-todo-assignment-chain-popover')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it.each(['modal', 'workspace-panel'] as const)(
    'does not render the trigger without assignment history in %s',
    async presentation => {
      const user = userEvent.setup()
      render(
        <TodoEditor
          mode="edit"
          presentation={presentation}
          item={baseItem}
          project={project}
          allItems={[baseItem]}
          onUpdated={vi.fn()}
          onClose={vi.fn()}
          api={api}
        />
      )
      if (presentation === 'workspace-panel') {
        await user.click(screen.getByTestId('cloud-todo-more-properties'))
      }
      expect(screen.queryByTestId('cloud-todo-assignment-chain-trigger')).not.toBeInTheDocument()
    }
  )
})

describe('TodoEditor status history', () => {
  it('shows status changes in the collaboration drawer timeline without a duplicate popover', async () => {
    const item = {
      ...baseItem,
      status_history: [
        {
          from_status: 'pending',
          from_status_name: '待处理',
          to_status: 'in_progress',
          to_status_name: '进行中',
          trigger: 'user_update',
          by_user_id: null,
          at: '2026-08-01T10:00:00Z',
        },
      ],
    } as unknown as CloudLoopItem
    render(
      <TodoEditor
        mode="edit"
        item={item}
        project={project}
        allItems={[item]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={api}
        presentation="workspace-panel"
      />
    )

    expect(await screen.findByTestId('cloud-task-status-event-0')).toHaveTextContent('待处理')
    expect(screen.getByTestId('cloud-task-status-event-0')).toHaveTextContent('进行中')
    expect(screen.queryByTestId('cloud-todo-status-history-trigger')).not.toBeInTheDocument()
  })

  it('shows status history in a popover triggered next to the status', async () => {
    const user = userEvent.setup()
    const historyItem = {
      ...baseItem,
      status_history: [
        {
          from_status: 'inbox',
          from_status_name: '收集箱',
          to_status: 'in_progress',
          to_status_name: '进行中',
          trigger: 'user_update',
          by_user_id: 1,
          at: '2026-08-01T10:00:00',
        },
        {
          from_status: 'in_progress',
          from_status_name: '进行中',
          to_status: 'in_review',
          to_status_name: '待确认',
          trigger: 'ai_completed',
          by_user_id: null,
          at: '2026-08-02T11:30:00',
        },
      ],
    } as unknown as CloudLoopItem
    render(editorElement(historyItem))

    const trigger = screen.getByTestId('cloud-todo-status-history-trigger')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)

    const popover = screen.getByTestId('cloud-todo-status-history-popover')
    expect(popover).toHaveTextContent('状态历史')
    expect(popover).toHaveTextContent('收集箱')
    expect(popover).toHaveTextContent('进行中')
    expect(popover).toHaveTextContent('待确认')
    expect(popover).toHaveTextContent('用户更新')
    expect(popover).toHaveTextContent('AI 完成')

    await user.keyboard('{Escape}')

    expect(screen.queryByTestId('cloud-todo-status-history-popover')).not.toBeInTheDocument()
  })

  it('does not render the trigger when the item has no status history', () => {
    render(editorElement(baseItem))
    expect(screen.queryByTestId('cloud-todo-status-history-trigger')).not.toBeInTheDocument()
  })

  it('renders fallbacks for empty status names and null actors', async () => {
    const user = userEvent.setup()
    const historyItem = {
      ...baseItem,
      status_history: [
        {
          from_status: '',
          from_status_name: null,
          to_status: 'in_progress',
          to_status_name: '进行中',
          trigger: 'ai_started',
          by_user_id: null,
          at: '2026-08-01T10:00:00',
        },
      ],
    } as unknown as CloudLoopItem
    render(editorElement(historyItem))

    await user.click(screen.getByTestId('cloud-todo-status-history-trigger'))

    const popover = screen.getByTestId('cloud-todo-status-history-popover')
    expect(popover).toHaveTextContent('未设置')
    expect(popover).toHaveTextContent('系统/机器人')
  })

  it('renders the initial create entry without an unset from-status', async () => {
    const user = userEvent.setup()
    const historyItem = {
      ...baseItem,
      status_history: [
        {
          from_status: '',
          from_status_name: null,
          to_status: 'inbox',
          to_status_name: '收集箱',
          trigger: 'create',
          by_user_id: 1,
          at: '2026-08-01T10:00:00',
        },
      ],
    } as unknown as CloudLoopItem
    render(editorElement(historyItem))

    await user.click(screen.getByTestId('cloud-todo-status-history-trigger'))

    const popover = screen.getByTestId('cloud-todo-status-history-popover')
    expect(popover).toHaveTextContent('初始状态')
    expect(popover).toHaveTextContent('收集箱')
    expect(popover).not.toHaveTextContent('未设置')
  })

  it('labels an in-review to completed user update as accept', async () => {
    const user = userEvent.setup()
    const historyItem = {
      ...baseItem,
      status_history: [
        {
          from_status: 'in_review',
          from_status_name: '待确认',
          to_status: 'completed',
          to_status_name: '已完成',
          trigger: 'user_update',
          by_user_id: 1,
          at: '2026-08-01T10:00:00',
        },
      ],
    } as unknown as CloudLoopItem
    render(editorElement(historyItem))

    await user.click(screen.getByTestId('cloud-todo-status-history-trigger'))

    const popover = screen.getByTestId('cloud-todo-status-history-popover')
    expect(popover).toHaveTextContent('验收')
    expect(popover).not.toHaveTextContent('用户更新')
  })
})

describe('TodoEditor create parent resolution', () => {
  it('centers create content, options, and footer in one column when fullscreen', async () => {
    const user = userEvent.setup()
    render(
      <TodoEditor
        mode="create"
        project={project}
        initialParent={null}
        initialStatus="inbox"
        allItems={[]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        api={api}
        currentUserId={1}
        createOptions={<span data-testid="test-create-options">开始执行</span>}
      />
    )

    const content = screen.getByTestId('cloud-todo-create-content')
    const footer = screen.getByTestId('cloud-todo-create-footer')
    const options = screen.getByTestId('cloud-todo-create-options')
    const footerSection = footer.parentElement as HTMLElement
    const optionsSection = options.parentElement as HTMLElement
    expect(content).not.toHaveClass('max-w-[768px]')
    expect(footer).not.toHaveClass('max-w-[768px]')
    expect(options).not.toHaveClass('max-w-[768px]')
    expect(footerSection).not.toHaveClass('px-14')
    expect(optionsSection).not.toHaveClass('px-14')

    await user.click(screen.getByTestId('cloud-todo-create-fullscreen'))

    expect(content).toHaveClass('mx-auto', 'w-full', 'max-w-[768px]')
    expect(footer).toHaveClass('mx-auto', 'w-full', 'max-w-[768px]')
    expect(options).toHaveClass('mx-auto', 'w-full', 'max-w-[768px]')
    expect(footerSection).toHaveClass('px-14')
    expect(optionsSection).toHaveClass('px-14')
  })

  it('keeps assignee management actions visible while search filters options', async () => {
    const user = userEvent.setup()
    const onAddAssigneeMember = vi.fn()
    const onAddAssigneeAgent = vi.fn()
    const createApi = {
      listCloudProjectMembers: vi.fn(async () => [
        {
          id: 7,
          user_id: 7,
          user_name: 'Alice',
          email: null,
          role: 'Developer',
        },
      ]),
    } as never

    render(
      <TodoEditor
        mode="create"
        project={{ ...project, access_role: 'Owner' }}
        initialParent={null}
        initialStatus="inbox"
        allItems={[]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        onAddAssigneeMember={onAddAssigneeMember}
        onAddAssigneeAgent={onAddAssigneeAgent}
        api={createApi}
        currentUserId={1}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-create-assignee'))
    await user.type(screen.getByTestId('cloud-todo-create-assignee-search'), 'missing')

    expect(screen.getByText('没有匹配的负责人')).toBeVisible()
    expect(screen.getByTestId('cloud-todo-create-assignee-add-member')).toBeVisible()
    expect(screen.getByTestId('cloud-todo-create-assignee-add-agent')).toBeVisible()
    expect(screen.getByRole('listbox', { name: '负责人' })).not.toContainElement(
      screen.getByTestId('cloud-todo-create-assignee-add-member')
    )

    await user.click(screen.getByTestId('cloud-todo-create-assignee-add-member'))
    expect(onAddAssigneeMember).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('cloud-todo-create-assignee-menu')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('cloud-todo-create-assignee'))
    await user.click(screen.getByTestId('cloud-todo-create-assignee-add-agent'))
    expect(onAddAssigneeAgent).toHaveBeenCalledTimes(1)
  })

  it('offers the assignee selector to a Developer creating an Issue', () => {
    render(
      <TodoEditor
        mode="create"
        project={{ ...project, access_role: 'Developer' }}
        initialParent={null}
        initialStatus="inbox"
        allItems={[]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        api={api}
        currentUserId={1}
      />
    )

    expect(screen.getByTestId('cloud-todo-create-assignee')).not.toHaveAttribute('disabled')
  })

  it.each([
    { mode: 'create' as const, accessRole: 'Viewer' },
    { mode: 'edit' as const, accessRole: 'Owner' },
    { mode: 'edit' as const, accessRole: 'Developer' },
  ])('hides create-only assignee management actions: %j', async values => {
    const user = userEvent.setup()
    render(
      values.mode === 'create' ? (
        <TodoEditor
          mode="create"
          project={{ ...project, access_role: values.accessRole }}
          initialParent={null}
          initialStatus="inbox"
          allItems={[]}
          onCreated={vi.fn()}
          onClose={vi.fn()}
          onAddAssigneeMember={vi.fn()}
          onAddAssigneeAgent={vi.fn()}
          api={api}
          currentUserId={1}
        />
      ) : (
        <TodoEditor
          mode="edit"
          item={baseItem}
          project={{ ...project, access_role: values.accessRole }}
          allItems={[baseItem]}
          onUpdated={vi.fn()}
          onClose={vi.fn()}
          onAddAssigneeMember={vi.fn()}
          onAddAssigneeAgent={vi.fn()}
          api={api}
          currentUserId={1}
        />
      )
    )

    const trigger = screen.getByTestId(
      values.mode === 'create' ? 'cloud-todo-create-assignee' : 'cloud-todo-detail-assignee'
    )
    if (!trigger.hasAttribute('disabled')) await user.click(trigger)

    expect(screen.queryByTestId('cloud-todo-create-assignee-add-member')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-create-assignee-add-agent')).not.toBeInTheDocument()
  })

  it('creates a human-assigned Issue atomically without a follow-up assignment', async () => {
    const user = userEvent.setup()
    const createLoopItem = vi.fn(async () => ({
      ...baseItem,
      assignee_user_id: 7,
      assignee_agent_id: null,
      version: 1,
    }))
    const assignLoopItem = vi.fn()
    const createApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => [
        {
          id: 7,
          user_id: 7,
          user_name: 'Alice',
          email: null,
          role: 'Developer',
        },
      ]),
      createLoopItem,
      assignLoopItem,
    } as never

    render(
      <TodoEditor
        mode="create"
        project={{ ...project, access_role: 'Owner' }}
        initialParent={null}
        initialStatus="inbox"
        allItems={[]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        api={createApi}
        currentUserId={1}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-create-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-create-assignee-option-user:7'))
    expect(screen.queryByText('是否通知负责人')).not.toBeInTheDocument()
    await user.type(screen.getByTestId('cloud-todo-title'), 'Human-owned Issue')
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))

    await vi.waitFor(() => {
      expect(createLoopItem).toHaveBeenCalledWith('11', {
        title: 'Human-owned Issue',
        description: '',
        priority: 'none',
        status: 'inbox',
        tags: [],
        assignee_user_id: 7,
        notify_assignee: true,
      })
    })
    expect(assignLoopItem).not.toHaveBeenCalled()
  })

  it('creates an Issue from content only with a task-style generated title', async () => {
    const user = userEvent.setup()
    localStorage.setItem(
      'wework-todo-draft:11:inbox',
      JSON.stringify({
        title: '',
        markdown: 'Verify release\nCover creation flow',
        priority: 'none',
        parentId: '',
        dueDate: '',
        assigneeTarget: '',
        notifyAssignee: true,
        tags: [],
      })
    )
    const createLoopItem = vi.fn(async () => ({ ...baseItem, version: 1 }))
    const createApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => []),
      createLoopItem,
    } as never

    render(
      <TodoEditor
        mode="create"
        project={project}
        initialParent={null}
        initialStatus="inbox"
        allItems={[]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        api={createApi}
        currentUserId={1}
      />
    )

    expect(screen.getByTestId('cloud-todo-create-confirm')).toBeEnabled()
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))

    await vi.waitFor(() => {
      expect(createLoopItem).toHaveBeenCalledWith('11', {
        title: 'Verify release Cover creation flow',
        description: 'Verify release\nCover creation flow',
        priority: 'none',
        status: 'inbox',
        tags: [],
      })
    })
  })

  it('lists project collaboration groups and assigns the created task to the selected group', async () => {
    const user = userEvent.setup()
    const createLoopItem = vi.fn(async () => ({ ...baseItem, version: 1 }))
    const updateLoopItem = vi.fn(async (_id, values) => ({
      ...baseItem,
      ...values,
      assignee_group_name: '项目协作小组',
      version: 2,
    }))
    const assignLoopItem = vi.fn()
    const createApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => []),
      createLoopItem,
      updateLoopItem,
      assignLoopItem,
    } as never

    render(
      <TodoEditor
        mode="create"
        project={
          {
            ...project,
            access_role: 'Owner',
            collaboration_groups: [
              {
                id: 'group-1',
                name: '项目协作小组',
              },
            ],
            execution_environment: {
              repositories: [],
              setup_steps: [],
              devices: {
                'local-device': {
                  status: 'ready',
                  workspace_path: '/workspace/project',
                  prepared_at: '2026-09-26T00:00:00Z',
                  error: '',
                },
              },
            },
          } as CloudProject
        }
        initialParent={null}
        initialStatus="inbox"
        allItems={[]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        api={createApi}
        currentUserId={1}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-create-assignee'))
    const groupOption = await screen.findByTestId('cloud-todo-create-assignee-option-group:group-1')
    expect(groupOption).toHaveTextContent('项目协作小组')
    await user.click(groupOption)
    await user.type(screen.getByTestId('cloud-todo-title'), '交给协作小组')
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))

    await vi.waitFor(() => {
      expect(updateLoopItem).toHaveBeenCalledWith('WEG-1', {
        version: 1,
        assignee_group_id: 'group-1',
      })
    })
    expect(assignLoopItem).not.toHaveBeenCalled()
  })

  it('allows AI assignment before the first automatic project preparation', async () => {
    const user = userEvent.setup()
    const createLoopItem = vi.fn(async () => ({ ...baseItem, id: 'WEG-1', version: 1 }))
    const updateLoopItem = vi.fn(async () => ({ ...baseItem, id: 'WEG-1', version: 2 }))
    const createApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => []),
      createLoopItem,
      updateLoopItem,
    } as never

    render(
      <TodoEditor
        mode="create"
        project={
          {
            ...project,
            access_role: 'Owner',
            collaboration_groups: [{ id: 'group-1', name: '项目协作小组' }],
            execution_environment: {
              repositories: [],
              setup_steps: [],
              devices: {},
            },
          } as CloudProject
        }
        initialParent={null}
        initialStatus="inbox"
        allItems={[]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        api={createApi}
        currentUserId={1}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-create-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-create-assignee-option-group:group-1'))
    await user.type(screen.getByTestId('cloud-todo-title'), '交给协作小组')

    expect(
      screen.queryByTestId('cloud-todo-create-execution-environment-required')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-create-confirm')).toBeEnabled()
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))
    await vi.waitFor(() => expect(createLoopItem).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith('WEG-1', {
        version: 1,
        assignee_group_id: 'group-1',
      })
    )
  })

  it.each([true, false])(
    'restores the assignee before atomic creation with notify=%s',
    async notify => {
      const user = userEvent.setup()
      const attachment = new File(['draft context'], 'draft-context.txt', { type: 'text/plain' })
      const createLoopItem = vi.fn(async () => ({
        ...baseItem,
        assignee_user_id: 7,
        assignee_agent_id: null,
        version: 1,
      }))
      const assignLoopItem = vi.fn()
      const addLoopItemAttachment = vi.fn(async () => ({
        id: 'draft-attachment',
        loop_item_id: baseItem.id,
        display_name: attachment.name,
        content_type: attachment.type,
        size_bytes: attachment.size,
        sha256: 'draft-hash',
        created_by_user_id: 1,
        created_at: '2026-09-21T00:00:00Z',
        markdown_url: 'wegent://attachments/draft-attachment',
        markdown: '',
      }))
      const createApi = {
        listDeliveries: vi.fn(async () => ({ items: [] })),
        listTaskBindings: vi.fn(async () => []),
        listLoopItemAttachments: vi.fn(async () => []),
        listLoopItemCollaborators: vi.fn(async () => []),
        listCloudProjectMembers: vi.fn(async () => [
          {
            id: 7,
            user_id: 7,
            user_name: 'Alice',
            email: null,
            role: 'Developer',
          },
        ]),
        createLoopItem,
        assignLoopItem,
        addLoopItemAttachment,
      } as never
      const editor = (
        <TodoEditor
          mode="create"
          project={{ ...project, access_role: 'Owner' }}
          initialParent={null}
          initialStatus="inbox"
          allItems={[]}
          onCreated={vi.fn()}
          onClose={vi.fn()}
          api={createApi}
          currentUserId={1}
        />
      )
      const firstView = render(editor)

      await user.click(screen.getByTestId('cloud-todo-create-assignee'))
      await user.click(await screen.findByTestId('cloud-todo-create-assignee-option-user:7'))
      await user.type(screen.getByTestId('cloud-todo-title'), 'Restored human owner')
      await user.upload(screen.getByTestId('cloud-todo-attachment-input'), attachment)
      expect(screen.getByText('draft-context.txt')).toBeInTheDocument()
      await vi.waitFor(() => {
        expect(localStorage.getItem('wework-todo-draft:11:inbox')).toContain('"user:7"')
      })
      firstView.unmount()

      render(editor)
      expect(screen.getByTestId('cloud-todo-title')).toHaveValue('Restored human owner')
      expect(screen.getByTestId('cloud-todo-create-assignee')).toHaveAttribute(
        'data-value',
        'user:7'
      )
      expect(screen.getByText('draft-context.txt')).toBeInTheDocument()
      expect(screen.getByTestId('cloud-todo-create-confirm')).toHaveTextContent('保存并通知')
      if (notify) {
        await user.click(screen.getByTestId('cloud-todo-create-confirm'))
      } else {
        await user.click(screen.getByTestId('cloud-todo-create-confirm-options'))
        await user.click(screen.getByRole('menuitem', { name: '仅保存不通知' }))
      }

      await vi.waitFor(() => {
        expect(createLoopItem).toHaveBeenCalledWith('11', {
          title: 'Restored human owner',
          description: '',
          priority: 'none',
          status: 'inbox',
          tags: [],
          assignee_user_id: 7,
          notify_assignee: notify,
        })
      })
      expect(assignLoopItem).not.toHaveBeenCalled()
      await vi.waitFor(() => {
        expect(addLoopItemAttachment).toHaveBeenCalledWith(baseItem.id, attachment)
        expect(localStorage.getItem('wework-todo-draft:11:inbox')).toBeNull()
      })
    }
  )
  it('keeps Wegent Teams available when the member directory fails', async () => {
    const createApi = {
      listCloudProjectMembers: vi.fn(async () => {
        throw new Error('member directory unavailable')
      }),
    } as never
    const teamApi = {
      listTeams: vi.fn(async () => [
        {
          id: 42,
          name: 'review-team',
          namespace: 'default',
          displayName: '评审智能体',
          is_active: true,
        },
      ]),
    } as never

    render(
      <TodoEditor
        mode="create"
        project={{ ...project, access_role: 'Owner' }}
        initialParent={null}
        initialStatus="inbox"
        allItems={[]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        api={createApi}
        teamApi={teamApi}
        projectChatAgentApi={
          {
            list: vi.fn(async () => [
              { id: 'enabled-42', name: 'Project binding', status: 'active', wegentTeamId: 42 },
            ]),
          } as never
        }
        currentUserId={1}
      />
    )

    await userEvent.click(screen.getByTestId('cloud-todo-create-assignee'))
    expect(
      await screen.findByTestId('cloud-todo-create-assignee-option-team:42')
    ).toHaveTextContent('评审智能体')
  })

  it('searches assignees and parent issues before selecting them', async () => {
    const user = userEvent.setup()
    const createApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => [
        {
          id: 7,
          user_id: 7,
          user_name: 'Alice',
          email: null,
          role: 'Developer',
        },
        {
          id: 8,
          user_id: 8,
          user_name: 'Bob',
          email: null,
          role: 'Developer',
        },
      ]),
    } as never
    const release = {
      ...baseItem,
      id: 'WEG-20',
      title: 'Release checklist',
    } as unknown as CloudLoopItem
    const onboarding = {
      ...baseItem,
      id: 'WEG-21',
      title: 'Onboarding',
    } as unknown as CloudLoopItem

    render(
      <TodoEditor
        mode="create"
        project={{ ...project, access_role: 'Owner' }}
        initialParent={null}
        initialStatus="inbox"
        allItems={[release, onboarding]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        api={createApi}
        currentUserId={7}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-create-assignee'))
    const assigneeSearch = screen.getByTestId('cloud-todo-create-assignee-search')
    expect(assigneeSearch).toHaveFocus()
    await user.type(assigneeSearch, 'ali')
    expect(await screen.findByRole('option', { name: 'Alice' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'Bob' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'Alice' }))
    expect(screen.getByTestId('cloud-todo-create-assignee')).toHaveAttribute('data-value', 'user:7')

    await user.click(screen.getByTestId('cloud-todo-create-parent'))
    const parentSearch = screen.getByTestId('cloud-todo-create-parent-search')
    expect(parentSearch).toHaveFocus()
    await user.type(parentSearch, 'release')
    expect(screen.getByRole('option', { name: 'WEG-20 · Release checklist' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'WEG-21 · Onboarding' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'WEG-20 · Release checklist' }))
    expect(screen.getByTestId('cloud-todo-create-parent')).toHaveAttribute('data-value', 'WEG-20')
  })

  it('keeps the assignee search focused while its options finish loading', async () => {
    const user = userEvent.setup()
    const members = deferred<
      Array<{
        id: number
        user_id: number
        user_name: string
        email: null
        role: string
      }>
    >()
    const createApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(() => members.promise),
    } as never

    render(
      <TodoEditor
        mode="create"
        project={{ ...project, access_role: 'Owner' }}
        initialParent={null}
        initialStatus="inbox"
        allItems={[]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        api={createApi}
        currentUserId={7}
      />
    )

    await user.click(screen.getByTestId('cloud-todo-create-assignee'))
    const search = screen.getByTestId('cloud-todo-create-assignee-search')
    expect(search).toHaveFocus()

    await act(async () => {
      members.resolve([
        {
          id: 7,
          user_id: 7,
          user_name: 'Alice',
          email: null,
          role: 'Developer',
        },
      ])
      await members.promise
    })

    expect(await screen.findByRole('option', { name: 'Alice' })).toBeVisible()
    expect(search).toHaveFocus()
  })

  it('drops a parent that no longer exists and creates a top-level task', async () => {
    const user = userEvent.setup()
    const createApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => []),
      createLoopItem: vi.fn(async () => ({ ...baseItem, version: 1 })),
    } as never
    const staleParent = { ...baseItem, id: 'STALE-1' } as unknown as CloudLoopItem
    const liveParent = { ...baseItem, id: 'LIVE-1' } as unknown as CloudLoopItem
    render(
      <TodoEditor
        mode="create"
        project={project}
        initialParent={staleParent}
        initialStatus="inbox"
        allItems={[liveParent]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        api={createApi}
        currentUserId={1}
      />
    )

    await user.type(screen.getByTestId('cloud-todo-title'), '新的顶层任务')
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))

    await vi.waitFor(() => {
      expect(createApi.createLoopItem).toHaveBeenCalledWith('11', {
        title: '新的顶层任务',
        description: '',
        priority: 'none',
        status: 'inbox',
        tags: [],
      })
    })
  })

  it('keeps a live parent in the create payload', async () => {
    const user = userEvent.setup()
    const createApi = {
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listTaskBindings: vi.fn(async () => []),
      listLoopItemAttachments: vi.fn(async () => []),
      listLoopItemCollaborators: vi.fn(async () => []),
      listCloudProjectMembers: vi.fn(async () => []),
      createLoopItem: vi.fn(async () => ({ ...baseItem, version: 1 })),
    } as never
    const liveParent = { ...baseItem, id: 'LIVE-1' } as unknown as CloudLoopItem
    render(
      <TodoEditor
        mode="create"
        project={project}
        initialParent={liveParent}
        initialStatus="inbox"
        allItems={[liveParent]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        api={createApi}
        currentUserId={1}
      />
    )

    await user.type(screen.getByTestId('cloud-todo-title'), '子任务')
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))

    await vi.waitFor(() => {
      expect(createApi.createLoopItem).toHaveBeenCalledWith('11', {
        title: '子任务',
        description: '',
        priority: 'none',
        status: 'inbox',
        tags: [],
        parent_id: 'LIVE-1',
      })
    })
  })
})

describe('TodoEditor comments by provider', () => {
  it('closes task comments for DingTalk AI Table tasks', () => {
    const aitableProject = {
      ...project,
      task_provider: 'dingtalk_aitable' as const,
    } as unknown as CloudProject
    render(
      <TodoEditor
        mode="edit"
        item={baseItem}
        project={aitableProject}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onAddChild={vi.fn()}
        onClose={vi.fn()}
        api={api}
        currentUserId={1}
      />
    )

    expect(screen.queryByTestId('cloud-todo-detail-activity-rail-empty')).not.toBeInTheDocument()
    expect(screen.queryByText('评论 / 动态')).not.toBeInTheDocument()
  })

  it('keeps the comment rail for local tasks without a chat client', () => {
    render(editorElement(baseItem))

    expect(screen.getByTestId('cloud-todo-detail-activity-rail-empty')).toBeInTheDocument()
    expect(screen.getByText('动态')).toBeInTheDocument()
  })
})

describe('TodoEditor shared attachments', () => {
  it('uses SharedWorkspaceApi domains without a legacy DeliveryApi', async () => {
    const removeAttachment = vi.fn(async () => undefined)
    const updateIssue = vi.fn(async () => ({ ...baseItem, title: '共享编辑', version: 2 }))
    const sharedApi = {
      issues: {
        update: updateIssue,
      },
      attachments: {
        list: vi.fn(async () => [
          {
            id: 'attachment-1',
            loop_item_id: baseItem.id,
            display_name: 'design.png',
            content_type: 'image/png',
            size_bytes: 1536,
            created_by_user_id: 1,
            created_at: '2026-09-10T00:00:00Z',
            markdown_url: 'wegent://attachments/attachment-1',
          },
        ]),
        remove: removeAttachment,
      },
      collaborators: {
        list: vi.fn(async () => []),
      },
      taskBindings: {
        list: vi.fn(async () => []),
      },
      members: {
        list: vi.fn(async () => []),
      },
      agents: {
        list: vi.fn(async () => []),
      },
      deliveries: {
        list: vi.fn(async () => []),
      },
    } as never
    const user = userEvent.setup()

    render(
      <TodoEditor
        mode="edit"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        sharedApi={sharedApi}
        currentUserId={1}
      />
    )

    expect(await screen.findByText('design.png')).toBeInTheDocument()
    expect(sharedApi.deliveries.list).toHaveBeenCalledWith('WEG-1')
    expect(sharedApi.taskBindings.list).toHaveBeenCalledWith('WEG-1', '11')
    expect(sharedApi.collaborators.list).toHaveBeenCalledWith('WEG-1')
    expect(sharedApi.members.list).toHaveBeenCalledWith('11')
    expect(sharedApi.agents.list).toHaveBeenCalledWith('11')
    expect(screen.queryByText('1.5 KB')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-attachment-input')).toBeInTheDocument()

    await user.click(screen.getByTestId('cloud-todo-attachment-delete-attachment-1'))

    expect(removeAttachment).toHaveBeenCalledWith('attachment-1')
    expect(screen.queryByText('design.png')).not.toBeInTheDocument()

    await user.clear(screen.getByTestId('cloud-todo-detail-title'))
    await user.type(screen.getByTestId('cloud-todo-detail-title'), '共享编辑')
    await user.click(screen.getByTestId('cloud-todo-save'))

    expect(updateIssue).toHaveBeenCalledWith(
      'WEG-1',
      expect.objectContaining({
        version: 1,
        title: '共享编辑',
      })
    )
  })

  it('does not reload issue resources when its parent rerenders', async () => {
    const sharedApi = {
      issues: {
        update: vi.fn(),
      },
      attachments: {
        list: vi.fn(async () => []),
      },
      collaborators: {
        list: vi.fn(async () => []),
      },
      taskBindings: {
        list: vi.fn(async () => []),
      },
      members: {
        list: vi.fn(async () => []),
      },
      agents: {
        list: vi.fn(async () => []),
      },
      deliveries: {
        list: vi.fn(async () => []),
      },
    } as never
    const teamApi = {
      listTeams: vi.fn(async () => []),
    } as never
    const onUpdated = vi.fn()
    const onClose = vi.fn()
    const renderEditor = () => (
      <TodoEditor
        mode="edit"
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={onUpdated}
        onClose={onClose}
        sharedApi={sharedApi}
        teamApi={teamApi}
        currentUserId={1}
      />
    )
    const view = render(renderEditor())

    await vi.waitFor(() => {
      expect(sharedApi.attachments.list).toHaveBeenCalledTimes(1)
      expect(sharedApi.collaborators.list).toHaveBeenCalledTimes(1)
      expect(sharedApi.taskBindings.list).toHaveBeenCalledTimes(1)
      expect(sharedApi.members.list).toHaveBeenCalledTimes(1)
      expect(sharedApi.agents.list).toHaveBeenCalledTimes(1)
      expect(sharedApi.deliveries.list).toHaveBeenCalledTimes(1)
      expect(teamApi.listTeams).toHaveBeenCalledTimes(1)
    })

    view.rerender(renderEditor())

    await vi.waitFor(() => {
      expect(sharedApi.attachments.list).toHaveBeenCalledTimes(1)
      expect(sharedApi.collaborators.list).toHaveBeenCalledTimes(1)
      expect(sharedApi.taskBindings.list).toHaveBeenCalledTimes(1)
      expect(sharedApi.members.list).toHaveBeenCalledTimes(1)
      expect(sharedApi.agents.list).toHaveBeenCalledTimes(1)
      expect(sharedApi.deliveries.list).toHaveBeenCalledTimes(1)
      expect(teamApi.listTeams).toHaveBeenCalledTimes(1)
    })
  })
})
