import type { CloudLoopItem, CloudProject, LoopItemTaskBinding } from '@/api/deliveries'
import i18n from '@/i18n'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { startTransition, Suspense, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoEditor } from './TodoEditor'
import { CollaborationTheme } from '@wegent/collaboration/theme'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const api = {
  getIssueAssignmentReceipts: vi.fn(async () => []),
  acknowledgeIssueAssignment: vi.fn(async () => ({ acknowledged: true })),
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

describe('TodoEditor external item sync', () => {
  it('keeps a wrapped title fully visible when typography changes without remounting', async () => {
    const originalFont = document.documentElement.style.getPropertyValue('--text-heading-lg')
    let measuredHeight = 44
    const height = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.dataset.testid === 'cloud-todo-detail-title' ? measuredHeight : 0
    })
    const editor = (fontSize: string) => (
      <CollaborationTheme mode="light" variables={{ '--text-heading-lg': fontSize }}>
        <TodoEditor
          mode="edit"
          item={baseItem}
          project={project}
          allItems={[baseItem]}
          presentation="workspace-panel"
          readFirst
          onUpdated={vi.fn()}
          onClose={vi.fn()}
          api={api}
        />
      </CollaborationTheme>
    )
    try {
      const view = render(editor('24px'))
      const title = screen.getByTestId('cloud-todo-detail-title')
      expect(title).toHaveStyle({ height: '44px' })
      title.focus()
      measuredHeight = 73
      view.rerender(editor('27px'))
      expect(title).toHaveStyle({ height: '73px' })
      measuredHeight = 90
      act(() => document.documentElement.style.setProperty('--text-heading-lg', '30px'))
      await waitFor(() => expect(title).toHaveStyle({ height: '90px' }))
      expect(screen.getByTestId('cloud-todo-detail-title')).toBe(title)
      expect(title).toHaveFocus()
      expect(title).toHaveValue(baseItem.title)
    } finally {
      if (originalFont)
        document.documentElement.style.setProperty('--text-heading-lg', originalFont)
      else document.documentElement.style.removeProperty('--text-heading-lg')
      height.mockRestore()
    }
  })
  it.each([false, true])(
    'explains local participant availability (workspace panel: %s)',
    async workspacePanel => {
      const add = vi.fn()
      render(
        <TodoEditor
          mode="edit"
          item={baseItem}
          project={{ ...project, project_store: 'local' }}
          allItems={[baseItem]}
          {...(workspacePanel ? { presentation: 'workspace-panel' as const, readFirst: true } : {})}
          onUpdated={vi.fn()}
          onClose={vi.fn()}
          api={{ ...(api as object), addLoopItemCollaborator: add } as never}
        />
      )
      const button = screen.getByTestId('cloud-todo-add-collaborator')
      expect(button).toBeDisabled()
      expect(button).toHaveAccessibleDescription('此项目暂不支持编辑参与者')
      expect(screen.getByTestId('issue-collaborators-unavailable')).toBeVisible()
      await userEvent.click(button)
      expect(screen.queryByTestId('cloud-todo-collaborator-select')).not.toBeInTheDocument()
      expect(add).not.toHaveBeenCalled()
      await act(async () => {
        await i18n.changeLanguage('en')
      })
      try {
        expect(button).toHaveAccessibleDescription(
          'Editing participants is not available for this project yet'
        )
      } finally {
        await act(async () => {
          await i18n.changeLanguage('zh-CN')
        })
      }
    }
  )
  it.each([false, true])(
    'accepts a zero-id participant when editing is supported (workspace panel: %s)',
    async workspacePanel => {
      const add = vi.fn(async () => ({ id: 1, user_id: 0, user_name: 'Local owner' }))
      const memberApi = {
        ...(api as object),
        listCloudProjectMembers: vi.fn(async () => [
          { id: 1, user_id: 0, user_name: 'Local owner', role: 'Owner' },
        ]),
        addLoopItemCollaborator: add,
      }
      render(
        <TodoEditor
          mode="edit"
          item={baseItem}
          project={project}
          allItems={[baseItem]}
          {...(workspacePanel ? { presentation: 'workspace-panel' as const, readFirst: true } : {})}
          onUpdated={vi.fn()}
          onClose={vi.fn()}
          api={memberApi as never}
        />
      )
      await userEvent.click(screen.getByTestId('cloud-todo-add-collaborator'))
      const select = await screen.findByTestId('cloud-todo-collaborator-select')
      await userEvent.click(await screen.findByTestId('cloud-todo-collaborator-option-0'))
      expect(screen.getByTestId('cloud-todo-confirm-collaborator')).toBeEnabled()
      expect(select).toHaveAccessibleName('搜索并选择参与者')
      await userEvent.click(screen.getByTestId('cloud-todo-confirm-collaborator'))
      await waitFor(() => expect(add).toHaveBeenCalledWith('WEG-1', 0))
    }
  )
  it('confirms outside assignees before saving, including cached search results', async () => {
    const assign = vi.fn(async () => ({
      ...baseItem,
      version: 2,
      assignee_user_id: 42,
      assignee_name: 'Outside person',
    }))
    const search = vi.fn(async () => ({
      users: [{ id: 42, user_name: 'Outside person', is_active: true }],
    }))
    render(
      <TodoEditor
        mode="edit"
        item={baseItem}
        project={{ ...project, access_role: 'Owner' }}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={
          { ...(api as object), searchCloudProjectUsers: search, assignLoopItem: assign } as never
        }
      />
    )
    await userEvent.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await userEvent.type(screen.getByTestId('cloud-todo-detail-assignee-search'), 'Outside')
    const option = await screen.findByTestId('cloud-todo-detail-assignee-option-user:42')
    expect(option).toHaveTextContent('非项目成员')
    await userEvent.click(option)
    expect(assign).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('issue-outside-assignee-cancel'))
    expect(assign).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await userEvent.type(screen.getByTestId('cloud-todo-detail-assignee-search'), 'Outside')
    await userEvent.click(await screen.findByTestId('cloud-todo-detail-assignee-option-user:42'))
    await userEvent.click(screen.getByTestId('issue-outside-assignee-confirm'))
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await userEvent.click(await screen.findByTestId('cloud-todo-detail-assignee-option-user:42'))
    expect(screen.getByTestId('issue-outside-assignee-dialog')).toBeVisible()
    expect(assign).toHaveBeenCalledTimes(1)
  })
  it('shows the persisted none priority without relabelling it as medium', () => {
    const item = { ...baseItem, priority: 'none' as const }
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        readFirst
        item={item}
        project={project}
        allItems={[item]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={api}
      />
    )
    const priority = screen.getByTestId('cloud-todo-detail-priority')
    expect(priority).toHaveValue('none')
    expect(
      priority.closest('.task-detail-rail-value')?.querySelector('.task-detail-workspace-tag')
    ).toHaveTextContent(/^无$/)
  })

  it('uses English accessible names throughout Issue reading controls', async () => {
    const language = i18n.language
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    try {
      render(
        <TodoEditor
          mode="edit"
          presentation="workspace-panel"
          readFirst
          showPanelControls
          showFullscreenControl
          item={baseItem}
          project={project}
          allItems={[baseItem]}
          onUpdated={vi.fn()}
          onClose={vi.fn()}
          api={api}
        />
      )
      expect(screen.getByTestId('cloud-todo-detail-fullscreen')).toHaveAccessibleName(
        'Expand details'
      )
      expect(screen.getByTestId('cloud-todo-state-summary')).toHaveAccessibleName('Current status')
      expect(screen.getByTestId('cloud-todo-more-properties-popover')).toHaveAttribute(
        'aria-label',
        'More properties'
      )
      expect(await screen.findByRole('textbox', { name: 'Description' })).toBeVisible()
    } finally {
      await act(async () => {
        await i18n.changeLanguage(language)
      })
    }
  })

  it('offers a keyboard action for editing a read-only description', async () => {
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        readFirst
        item={baseItem}
        project={project}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={api}
      />
    )
    const editor = await screen.findByTestId('cloud-todo-detail-description')
    expect(editor).toHaveAttribute('contenteditable', 'false')
    const edit = screen.getByRole('button', { name: '编辑描述' })
    edit.focus()
    await userEvent.keyboard('{Enter}')
    expect(editor).toHaveAttribute('contenteditable', 'true')
    expect(editor).toHaveFocus()
    expect(screen.getByTestId('cloud-todo-save')).toBeDisabled()
  })

  it.each([true, false])('shows an empty description hint with can_edit=%s', async canEdit => {
    const item = { ...baseItem, description: '', can_edit: canEdit }
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        readFirst
        item={item}
        project={project}
        allItems={[item]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        api={api}
      />
    )
    const hint = canEdit ? '添加描述，说明背景、目标或处理要求…' : '暂无描述'
    expect(await screen.findByText(hint)).toBeVisible()
    if (canEdit) {
      await userEvent.click(screen.getByTestId('cloud-todo-detail-description'))
      expect(screen.queryByTestId('cloud-todo-detail-description-empty')).not.toBeInTheDocument()
    }
  })

  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps human ownership and opens assistant settings only for that owner', async () => {
    const user = userEvent.setup()
    const configure = vi.fn()
    const item: CloudLoopItem = {
      ...baseItem,
      assignee_agent_id: null,
      assignee_user_id: 1,
      assignee_name: 'Ada',
      direct_human_assignment_receipt: {
        projectId: String(baseItem.cloud_project_id),
        issueId: baseItem.id,
        humanAssignmentId: 'human-1',
        dispatchId: 'dispatch-1',
        ownerUserId: 1,
        state: 'blocked_policy',
        runtimeTaskId: null,
        deliveryId: null,
        executionId: null,
        reasonCode: 'no_authorized_assistant',
        assignmentId: 'assignment-1',
        assignmentVersion: 1,
        createdAt: '2026-11-16T00:00:00Z',
        updatedAt: '2026-11-16T00:00:00Z',
      },
    }
    const props = {
      mode: 'edit' as const,
      presentation: 'workspace-panel' as const,
      item,
      project,
      allItems: [item],
      onUpdated: vi.fn(),
      onClose: vi.fn(),
      api,
      onConfigureAssistant: configure,
    }
    const { rerender } = render(<TodoEditor {...props} currentUserId={1} />)
    expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('Ada')
    expect(screen.getByTestId(`human-assistant-dispatch-${item.id}`)).toHaveAttribute(
      'data-receipt-state',
      'blocked_policy'
    )
    await user.click(screen.getByTestId(`human-assistant-configure-${item.id}`))
    expect(configure).toHaveBeenCalledOnce()
    rerender(<TodoEditor {...props} currentUserId={2} />)
    expect(screen.queryByTestId(`human-assistant-configure-${item.id}`)).not.toBeInTheDocument()
    expect(screen.getByTestId(`human-assistant-dispatch-${item.id}`)).toBeInTheDocument()
  })

  it.each([
    { viewer: 1, humanAssignmentId: 'human-1', canOpen: true },
    { viewer: 2, humanAssignmentId: 'human-1', canOpen: false },
    { viewer: 1, humanAssignmentId: 'human-2', canOpen: false },
  ])(
    'gates receipt work for viewer $viewer and assignment $humanAssignmentId',
    async ({ viewer, humanAssignmentId, canOpen }) => {
      const user = userEvent.setup()
      const onOpenTaskConversation = vi.fn()
      const receipt = {
        projectId: '11',
        issueId: baseItem.id,
        humanAssignmentId,
        dispatchId: 'dispatch-1',
        ownerUserId: 1,
        state: 'waiting_user' as const,
        reasonCode: null,
        runtimeTaskId: 'private-task',
        deliveryId: null,
        updatedAt: '2026-11-16T00:00:00Z',
      }
      const item: CloudLoopItem = {
        ...baseItem,
        assignee_agent_id: null,
        assignee_user_id: 1,
        direct_human_assignment_receipt: receipt,
      }
      const binding = {
        id: 8,
        device_id: 'owner-device',
        task_user_id: 1,
        task_id: 'private-task',
        human_assignment_id: 'human-1',
        loop_item_id: item.id,
        task_title: 'Assistant work',
        backend_task_id: null,
        linked_at: '2026-11-16T00:00:00Z',
      }
      const props = {
        mode: 'edit' as const,
        presentation: 'workspace-panel' as const,
        item,
        project,
        allItems: [item],
        onUpdated: vi.fn(),
        onClose: vi.fn(),
        api,
        initialTaskBindings: [binding],
        onOpenTaskConversation,
      }
      render(<TodoEditor {...props} currentUserId={viewer} />)
      const action = `human-assistant-execution-${item.id}`
      if (canOpen) {
        await user.click(screen.getByTestId(action))
        expect(onOpenTaskConversation).toHaveBeenCalledWith(expect.objectContaining(binding))
      } else {
        expect(screen.queryByTestId(action)).not.toBeInTheDocument()
        expect(onOpenTaskConversation).not.toHaveBeenCalled()
      }
      expect(screen.getByTestId(`human-assistant-dispatch-${item.id}`)).toHaveAttribute(
        'data-receipt-state',
        'waiting_user'
      )
    }
  )

  it('clears a deleted draft milestone only after a successful catalog read', async () => {
    const key = 'wework-todo-draft:11:inbox'
    localStorage.setItem(key, JSON.stringify({ title: 'Keep this draft', milestoneId: 'deleted' }))
    const pending = deferred<[]>()
    const createApi = { ...api, listMilestones: vi.fn(() => pending.promise) } as never
    render(
      <TodoEditor
        mode="create"
        project={{ ...project, task_provider: 'local', access_role: 'Owner' }}
        initialParent={null}
        initialStatus="inbox"
        allItems={[]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        api={createApi}
        currentUserId={1}
      />
    )
    expect(screen.getByTestId('issue-milestone')).toHaveAttribute('data-value', 'deleted')
    await act(async () => pending.resolve([]))
    await waitFor(() =>
      expect(screen.getByTestId('issue-milestone')).toHaveAttribute('data-value', '')
    )
    expect(screen.getByTestId('cloud-todo-title')).toHaveValue('Keep this draft')
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ milestoneId: null })
    )
    localStorage.removeItem(key)
  })

  it('restores a selected milestone when reopening an Issue creation draft', async () => {
    const user = userEvent.setup({ delay: null })
    const createApi = {
      ...api,
      listMilestones: vi.fn(async () => [
        {
          id: 'ms-draft',
          project_id: '11',
          title: 'Draft release',
          state: 'open',
          version: 1,
          open_issues: 0,
          closed_issues: 0,
        },
      ]),
    } as never
    const props = {
      mode: 'create' as const,
      project: { ...project, task_provider: 'local', access_role: 'Owner' },
      initialParent: null,
      initialStatus: 'inbox' as const,
      allItems: [],
      onCreated: vi.fn(),
      onClose: vi.fn(),
      api: createApi,
      currentUserId: 1,
    }
    const first = render(<TodoEditor {...props} />)
    await waitFor(() => expect(screen.getByTestId('issue-milestone')).toBeEnabled())
    await user.click(screen.getByTestId('issue-milestone'))
    await user.type(screen.getByTestId('issue-milestone-search'), 'Draft')
    await user.click(screen.getByRole('option', { name: 'Draft release' }))
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('wework-todo-draft:11:inbox')!)).toMatchObject({
        milestoneId: 'ms-draft',
      })
    )
    first.unmount()
    render(<TodoEditor {...props} />)
    await waitFor(() =>
      expect(screen.getByTestId('issue-milestone')).toHaveTextContent('Draft release')
    )
    expect(screen.getByTestId('issue-milestone')).toHaveAttribute('data-value', 'ms-draft')
    localStorage.removeItem('wework-todo-draft:11:inbox')
  })

  it.each(['draft', 'source'] as const)(
    'preserves newer %s status changes when a pending save is rejected',
    async change => {
      const user = userEvent.setup()
      const item = { ...baseItem, status: 'inbox' }
      const pending = deferred<CloudLoopItem>()
      const updateLoopItem = vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockImplementation(async (_id: string, values: Partial<CloudLoopItem>) => ({
          ...item,
          ...values,
          version: 2,
        }))
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

  it('restores a rejected status without reverting an immediately saved title', async () => {
    const user = userEvent.setup({ delay: null })
    const item = { ...baseItem, status: 'inbox' }
    let current = item
    const failure = Object.assign(new Error('No execution environment'), {
      errorCode: 'RUNNER_ENVIRONMENT_UNAVAILABLE',
    })
    const updateLoopItem = vi.fn(async (_id: string, values: Partial<CloudLoopItem>) => {
      if (values.status) throw failure
      current = { ...current, ...values, version: current.version + 1 }
      return current
    })
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
    const title = screen.getByTestId('cloud-todo-detail-title')
    await user.clear(title)
    await user.type(title, 'Keep my title')
    await user.selectOptions(screen.getByTestId('cloud-todo-detail-status'), 'in_progress')
    expect(await screen.findByTestId('cloud-todo-save-error')).toHaveTextContent(
      '请到项目设置 → 执行环境添加或授权设备'
    )
    expect(screen.getByTestId('cloud-todo-detail-status')).toHaveValue('inbox')
    expect(title).toHaveValue('Keep my title')
    expect(onUpdated).toHaveBeenCalledOnce()
    updateLoopItem.mockResolvedValueOnce({ ...current, status: 'in_progress', version: 3 })
    await user.click(screen.getByTestId('cloud-todo-field-retry'))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(2))
    expect(updateLoopItem).toHaveBeenLastCalledWith(item.id, { version: 2, status: 'in_progress' })
    expect(title).toHaveValue('Keep my title')
    expect(screen.queryByTestId('cloud-todo-save-error')).toBeNull()
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
    await user.tab()

    await vi.waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith(
        baseItem.id,
        expect.objectContaining({ due_at: '2026-10-31' })
      )
    )
  })

  it('offers unused view tags and saves inline priority and tag edits', async () => {
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
    await user.tab()

    expect(updateLoopItem).toHaveBeenCalledWith(baseItem.id, { version: 1, priority: 'urgent' })
    await vi.waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith(
        baseItem.id,
        expect.objectContaining({
          tags: ['release'],
        })
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
    expect(screen.getByRole('region', { name: '更多信息' })).toBeVisible()
    expect(screen.getByTestId('cloud-todo-detail-priority')).toBeDisabled()
    expect(screen.getByTestId('cloud-todo-add-collaborator')).toBeDisabled()
    expect(screen.queryByTestId('cloud-todo-detail-tag-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-detail-delete')).not.toBeInTheDocument()
  })

  it('keeps the archive action in its menu and metadata in the title area', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
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
        api={api}
        currentUserId={1}
      />
    )
    await user.click(screen.getByRole('button', { name: '操作' }))
    const actions = screen.getByTestId('cloud-todo-issue-actions-popover')
    expect(within(actions).queryByText('标签')).not.toBeInTheDocument()
    expect(within(actions).queryByText('参与者')).not.toBeInTheDocument()
    expect(within(actions).queryByText('优先级')).not.toBeInTheDocument()
    await user.click(within(actions).getByTestId('cloud-todo-detail-delete'))
    expect(onDelete).toHaveBeenCalledOnce()
    expect(screen.getByTestId('issue-primary-metadata')).toBeVisible()
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

  it('preserves creating another personal task when the Issue has been reassigned', async () => {
    const onCreateTask = vi.fn()
    const reassigned = { ...baseItem, assignee_user_id: 42, assignee_agent_id: null }
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={reassigned}
        project={project}
        allItems={[reassigned]}
        api={api}
        currentUserId={1}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        onCreateTask={onCreateTask}
        initialTaskBindings={[
          {
            id: 1,
            task_user_id: 1,
            device_id: 'local-device',
            task_id: 'my-existing-task',
            linked_at: '2026-10-08T08:00:00Z',
          },
        ]}
      />
    )
    await userEvent.click(screen.getByTestId('cloud-todo-create-task'))
    expect(onCreateTask).toHaveBeenCalledOnce()
  })

  it.each([true, false])(
    'shows existing-task linking only for editable Issues (%s)',
    async canEdit => {
      const item = {
        ...baseItem,
        project_store: 'backend' as const,
        can_edit: canEdit,
        can_view_detail: true,
      }
      const onLink = vi.fn().mockResolvedValue(undefined)
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
          existingTaskSource={{ port: { bindTask: onLink, unbindTask: vi.fn() } }}
        />
      )
      if (canEdit) expect(await screen.findByTestId('issue-link-existing-task')).toBeVisible()
      else expect(screen.queryByTestId('issue-link-existing-task')).not.toBeInTheDocument()
    }
  )

  it('shows only the linked-task create button until that section scrolls above the viewport', async () => {
    let anchorBottom = 1000
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return {
        top: 0,
        bottom: this.dataset.testid === 'cloud-todo-create-task' ? anchorBottom : 0,
      } as DOMRect
    })
    let onIntersection!: IntersectionObserverCallback
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          onIntersection = callback
        }
        observe = observe
        disconnect = disconnect
      }
    )
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

    const createTask = screen.getByTestId('cloud-todo-create-task')
    expect(screen.getByTestId('cloud-todo-tasks')).toContainElement(createTask)
    expect(createTask).toHaveTextContent('创建任务')
    expect(screen.queryByTestId('cloud-todo-personal-task-action')).not.toBeInTheDocument()
    expect(screen.queryByTestId('issue-persistent-task-action')).not.toBeInTheDocument()
    expect(observe).toHaveBeenCalledWith(createTask)
    await userEvent.click(createTask)
    expect(onCreateTask).toHaveBeenCalledOnce()
    onCreateTask.mockClear()

    const reportPosition = (bottom: number) =>
      act(() => {
        anchorBottom = bottom
        onIntersection(
          [
            {
              boundingClientRect: { bottom },
              rootBounds: { top: 0 },
            } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver
        )
      })
    reportPosition(1000)
    expect(screen.queryByTestId('issue-persistent-task-action')).not.toBeInTheDocument()
    // Jump from below to above without an intersection notification.
    act(() => {
      anchorBottom = -1
      fireEvent.scroll(screen.getByTestId('cloud-todo-detail-scroll'))
    })
    expect(screen.getByTestId('cloud-todo-personal-task-start')).toHaveAccessibleName('创建任务')
    expect(screen.getByTestId('cloud-todo-personal-task-start')).toHaveAttribute(
      'title',
      '让 AI 帮我处理 · 基于当前 Issue 创建任务，并在当前电脑上运行'
    )
    const persistentAction = screen.getByTestId('issue-persistent-task-action')
    expect(persistentAction).toContainElement(screen.getByTestId('cloud-todo-personal-task-start'))
    expect(screen.getByTestId('cloud-todo-detail-scroll')).not.toContainElement(persistentAction)
    expect(persistentAction.closest('header')).not.toBeNull()
    expect(screen.getAllByTestId('cloud-todo-personal-task-start')).toHaveLength(1)
    await userEvent.click(screen.getByTestId('cloud-todo-personal-task-start'))
    expect(onCreateTask).toHaveBeenCalledOnce()
    reportPosition(20)
    expect(screen.queryByTestId('issue-persistent-task-action')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-tasks')).toContainElement(createTask)
    vi.unstubAllGlobals()
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
      await screen.findByTestId('cloud-todo-tasks')
      if (binding.task_user_id !== 1) {
        expect(screen.queryByTestId('cloud-todo-open-task-conversation-99')).not.toBeInTheDocument()
      }
      await userEvent.click(screen.getByTestId('cloud-todo-create-task'))
      expect(onCreateTask).toHaveBeenCalledOnce()
      expect(onOpenTaskConversation).not.toHaveBeenCalled()
      expect(screen.getByTestId('cloud-todo-create-task')).toHaveTextContent('创建任务')
    }
  )

  it('keeps local Runtime task ownership independent from the assigned cloud user', async () => {
    const item = { ...baseItem, assignee_user_id: 1, assignee_agent_id: null }
    const onCreateTask = vi.fn()
    const binding = {
      id: 99,
      task_user_id: 0,
      device_id: 'local-device',
      task_id: 'local-task',
      task_title: 'Local task',
      linked_at: '2026-10-14T08:00:00Z',
      loop_item_id: item.id,
    } as LoopItemTaskBinding
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        item={item}
        project={{ ...project, project_store: 'local' }}
        allItems={[item]}
        api={{ ...api, listTaskBindings: vi.fn(async () => [binding]) }}
        currentUserId={1}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        onCreateTask={onCreateTask}
        initialTaskBindings={[binding]}
      />
    )
    expect(await screen.findByTestId('cloud-todo-open-task-conversation-99')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-todo-create-task'))
    expect(onCreateTask).toHaveBeenCalledOnce()
  })

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
    expect(screen.queryByTestId('cloud-todo-personal-task-action')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-create-task')).toBeInTheDocument()

    const toggle = screen.getByTestId('cloud-todo-toggle-tasks')
    expect(toggle).toHaveTextContent('查看全部 3 个')
    expect(screen.getByTestId('cloud-todo-tasks')).toContainElement(toggle)
    expect(screen.getByTestId('cloud-todo-state-summary')).not.toContainElement(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)

    expect(screen.getByText('较早完成的任务')).toBeInTheDocument()
    expect(toggle).toHaveTextContent('收起')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByTestId('issue-persistent-task-action')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-tasks')).toContainElement(
      screen.getByTestId('cloud-todo-create-task')
    )
    await userEvent.click(screen.getByTestId('cloud-todo-create-task'))
    expect(onCreateTask).toHaveBeenCalledOnce()
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
    await user.tab()

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
    await user.tab()

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
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
})

describe('TodoEditor create parent resolution', () => {
  it.each([{ mode: 'create' as const, accessRole: 'Viewer' }])(
    'hides create-only assignee management actions: %j',
    async values => {
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
    }
  )

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

it.each(['modal', 'workspace-panel'] as const)(
  'groups milestone properties and puts child Issues after the description in %s',
  async presentation => {
    render(
      <TodoEditor
        mode="edit"
        item={baseItem}
        project={{ ...project, task_provider: 'local' }}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        presentation={presentation}
        onOpenRelatedIssue={vi.fn()}
        onAddChild={vi.fn()}
        api={{ ...api, listMilestones: vi.fn(async () => []) } as never}
      />
    )
    const picker = await screen.findByTestId('issue-milestone')
    expect(screen.getByTestId('issue-title-properties').contains(picker)).toBe(true)
    expect(picker.closest('header')).toBeNull()
    if (presentation === 'workspace-panel') {
      const metadata = screen.getByTestId('issue-primary-metadata')
      expect(within(metadata).getByText('标签')).toBeVisible()
      expect(within(metadata).getByText('参与者')).toBeVisible()
      expect(within(metadata).getByTestId('cloud-todo-collaborators')).toBeVisible()
      expect(screen.getByTestId('cloud-todo-more-properties')).toHaveAttribute(
        'aria-expanded',
        'false'
      )
      expect(screen.getByTestId('cloud-todo-more-properties-popover')).not.toBeVisible()
      await userEvent.click(screen.getByRole('button', { name: '展开更多属性' }))
      expect(screen.getByTestId('cloud-todo-more-properties-popover')).toBeVisible()
      expect(screen.getByTestId('issue-title-properties')).toContainElement(
        screen.getByTestId('cloud-todo-more-properties-popover')
      )
      await userEvent.click(screen.getByRole('button', { name: '收起更多属性' }))
      expect(screen.getByTestId('cloud-todo-more-properties-popover')).not.toBeVisible()
      expect(within(metadata).getByText('标签')).toBeVisible()
      expect(within(metadata).getByTestId('cloud-todo-collaborators')).toBeVisible()
      const grid = screen.getByTestId('issue-property-grid')
      expect(Array.from(grid.querySelectorAll('dt')).map(label => label.textContent)).toEqual([
        '状态',
        '负责人',
        '里程碑',
        '时间范围',
      ])
      expect(grid.contains(picker)).toBe(true)
    }
    const description = screen.getByTestId('cloud-todo-detail-description')
    const children = screen.getByTestId('issue-hierarchy-summary')
    expect(
      description.compareDocumentPosition(children) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  }
)
