import type { CloudLoopItem, CloudProject, LoopItemTaskBinding } from '@/api/deliveries'
import '@/i18n'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { startTransition, Suspense, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TodoEditor } from './TodoEditor'

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

function versionedIssueUpdates(initial: CloudLoopItem) {
  let persisted = initial
  return vi.fn(async (_id: string, values: Partial<CloudLoopItem>) => {
    persisted = { ...persisted, ...values, version: persisted.version + 1 }
    return persisted
  })
}

describe('TodoEditor external item sync', () => {
  it.each(['draft', 'source'] as const)(
    'preserves newer %s status changes when a pending save is rejected',
    async change => {
      const user = userEvent.setup()
      const item = { ...baseItem, status: 'inbox' }
      const pending = deferred<CloudLoopItem>()
      const newer = deferred<CloudLoopItem>()
      const updateLoopItem = vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockImplementationOnce(() => newer.promise)
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
      if (change === 'draft') {
        await act(async () => {
          newer.resolve({ ...item, status: 'pending', version: 2 })
          await newer.promise
        })
      }
    }
  )

  it('restores rejected status changes without discarding the content draft', async () => {
    // Text-entry pacing is irrelevant here; avoid a timed-out interaction leaking into the next test.
    const user = userEvent.setup({ delay: null })
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
    const description = await screen.findByTestId('cloud-todo-detail-description')
    await user.click(description)
    await user.keyboard(' Keep my draft')
    await user.selectOptions(screen.getByTestId('cloud-todo-detail-status'), 'in_progress')

    expect(await screen.findByTestId('cloud-todo-save-error')).toHaveTextContent(
      '机器人没有符合配置且获项目授权的执行环境'
    )
    expect(screen.getByTestId('cloud-todo-detail-status')).toHaveValue('inbox')
    expect(description).toHaveTextContent('Keep my draft')
    expect(onUpdated).not.toHaveBeenCalled()

    updateLoopItem.mockResolvedValueOnce({
      ...item,
      status: 'in_progress',
      version: 2,
    })
    await user.selectOptions(screen.getByTestId('cloud-todo-detail-status'), 'in_progress')
    await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce())
    expect(updateLoopItem).toHaveBeenLastCalledWith(item.id, {
      version: 1,
      status: 'in_progress',
    })
    expect(description).toHaveTextContent('Keep my draft')
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
    await user.keyboard('{Enter}')
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledWith(saved))
    expect(updateLoopItem.mock.calls).toEqual([
      [baseItem.id, { version: 1, title: saved.title }],
      [baseItem.id, { version: 2, title: saved.title }],
    ])
  })

  it('retains a rejected title for another blur without entering description editing', async () => {
    const user = userEvent.setup()
    const updateLoopItem = versionedIssueUpdates(baseItem)
    updateLoopItem.mockRejectedValueOnce(new Error('Title update unavailable'))
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
        api={{ ...api, updateLoopItem } as never}
      />
    )
    const title = screen.getByTestId('cloud-todo-detail-title')
    await user.clear(title)
    await user.type(title, 'Retry this title')
    expect(updateLoopItem).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    expect(await screen.findByTestId('cloud-todo-save-error')).toHaveTextContent(
      'Title update unavailable'
    )
    expect(title).toHaveValue('Retry this title')
    expect(screen.queryByTestId('cloud-todo-cancel-content-edit')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-save')).not.toBeInTheDocument()

    await user.click(title)
    await user.tab()

    await waitFor(() =>
      expect(updateLoopItem.mock.calls).toEqual([
        [baseItem.id, { version: 1, title: 'Retry this title' }],
        [baseItem.id, { version: 1, title: 'Retry this title' }],
      ])
    )
    expect(screen.queryByTestId('cloud-todo-save-error')).not.toBeInTheDocument()
  })

  it('opens an empty description explicitly and saves its content manually', async () => {
    const user = userEvent.setup({ delay: null })
    const item = { ...baseItem, description: '' }
    const updateLoopItem = versionedIssueUpdates(item)
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
        api={{ ...api, updateLoopItem } as never}
      />
    )
    expect(screen.queryByTestId('cloud-todo-save')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('cloud-todo-add-description'))
    const description = await screen.findByTestId('cloud-todo-detail-description')
    await user.click(description)
    await user.keyboard('Write the first description')

    expect(description).toHaveTextContent('Write the first description')
    expect(updateLoopItem).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('cloud-todo-save'))

    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledExactlyOnceWith(item.id, {
        version: 1,
        description: expect.stringContaining('Write the first description'),
      })
    )
    expect(screen.queryByTestId('cloud-todo-cancel-content-edit')).not.toBeInTheDocument()
  })

  it('keeps the owner and schedule compact and explains the header status in a tooltip', async () => {
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
    expect(summary).toHaveTextContent('负责人')
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

    await vi.waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith(
        baseItem.id,
        expect.objectContaining({ due_at: '2026-10-31' })
      )
    )
  })

  it('offers unused view tags and saves priority and tag edits from the properties menu', async () => {
    const user = userEvent.setup()
    const updateLoopItem = versionedIssueUpdates(baseItem)
    const editableApi = {
      ...api,
      updateLoopItem,
    } as never

    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        readFirst
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

    await vi.waitFor(() =>
      expect(updateLoopItem.mock.calls).toEqual([
        [baseItem.id, { version: 1, priority: 'urgent' }],
        [baseItem.id, { version: 2, tags: ['release'] }],
      ])
    )
    expect(screen.queryByTestId('cloud-todo-save')).not.toBeInTheDocument()
  })

  it('saves a valid date range together after rejecting an invalid intermediate range', async () => {
    const user = userEvent.setup()
    const item = {
      ...baseItem,
      start_at: '2026-11-02',
      due_at: '2026-11-04',
    }
    const updateLoopItem = versionedIssueUpdates(item)
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
        api={{ ...api, updateLoopItem } as never}
      />
    )
    await user.click(screen.getByRole('button', { name: '时间范围' }))
    fireEvent.change(screen.getByTestId('cloud-todo-detail-start-date'), {
      target: { value: '2026-11-05' },
    })
    expect(screen.getByText('开始时间不能晚于结束时间')).toBeVisible()
    expect(updateLoopItem).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('cloud-todo-detail-due-date'), {
      target: { value: '2026-11-06' },
    })
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenNthCalledWith(1, item.id, {
        version: 1,
        start_at: '2026-11-05',
        due_at: '2026-11-06',
      })
    )
    fireEvent.change(screen.getByTestId('cloud-todo-detail-due-date'), {
      target: { value: '' },
    })
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenNthCalledWith(2, item.id, {
        version: 2,
        due_at: null,
      })
    )
    expect(screen.queryByTestId('cloud-todo-cancel-content-edit')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-save')).not.toBeInTheDocument()
  })

  it('persists the original start date when it is restored during a pending automatic save', async () => {
    const user = userEvent.setup()
    const item = {
      ...baseItem,
      start_at: '2026-11-02',
      due_at: '2026-11-06',
    }
    let persisted: CloudLoopItem = item
    const pending = deferred<void>()
    const updateLoopItem = vi.fn(async (_id: string, values: Partial<CloudLoopItem>) => {
      if (values.start_at === '2026-11-03') await pending.promise
      persisted = { ...persisted, ...values, version: persisted.version + 1 }
      return persisted
    })
    const onUpdated = vi.fn()
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        readFirst
        item={item}
        project={project}
        allItems={[item]}
        onUpdated={onUpdated}
        onClose={vi.fn()}
        api={{ ...api, updateLoopItem } as never}
      />
    )
    await user.click(screen.getByRole('button', { name: '时间范围' }))
    const startDate = screen.getByTestId('cloud-todo-detail-start-date')
    fireEvent.change(startDate, { target: { value: '2026-11-03' } })
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledExactlyOnceWith(item.id, {
        version: 1,
        start_at: '2026-11-03',
      })
    )
    fireEvent.change(startDate, { target: { value: item.start_at } })
    expect(startDate).toHaveValue(item.start_at)
    expect(updateLoopItem).toHaveBeenCalledOnce()

    await act(async () => {
      pending.resolve()
      await pending.promise
    })

    await waitFor(() =>
      expect(updateLoopItem.mock.calls).toEqual([
        [item.id, { version: 1, start_at: '2026-11-03' }],
        [item.id, { version: 2, start_at: item.start_at }],
      ])
    )
    await waitFor(() =>
      expect(onUpdated).toHaveBeenLastCalledWith(
        expect.objectContaining({ start_at: item.start_at, due_at: item.due_at, version: 3 })
      )
    )
    expect(persisted).toEqual({ ...item, version: 3 })
    expect(startDate).toHaveValue(item.start_at)
    expect(screen.getByTestId('cloud-todo-detail-due-date')).toHaveValue(item.due_at)
  })

  it('refreshes conflicting priority without a parent rerender and saves the next choice at the fetched version', async () => {
    const user = userEvent.setup()
    const item = { ...baseItem, priority: 'none' as const }
    const latest = { ...item, priority: 'urgent' as const, version: 2 }
    let persisted: CloudLoopItem = latest
    const updateLoopItem = vi
      .fn(async (_id: string, values: Partial<CloudLoopItem>) => {
        persisted = { ...persisted, ...values, version: persisted.version + 1 }
        return persisted
      })
      .mockRejectedValueOnce(Object.assign(new Error('task changed'), { code: 'version_conflict' }))
    const getLoopItem = vi.fn(async () => latest)
    const onUpdated = vi.fn()
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        readFirst
        item={item}
        project={project}
        allItems={[item]}
        onUpdated={onUpdated}
        onClose={vi.fn()}
        api={{ ...api, getLoopItem, updateLoopItem } as never}
      />
    )
    await user.click(screen.getByTestId('cloud-todo-more-properties'))
    const priority = screen.getByTestId('cloud-todo-detail-priority')
    await user.selectOptions(priority, 'high')

    await waitFor(() => expect(priority).toHaveValue('urgent'))
    expect(getLoopItem).toHaveBeenCalledExactlyOnceWith(item.id)
    expect(updateLoopItem).toHaveBeenCalledExactlyOnceWith(item.id, {
      version: 1,
      priority: 'high',
    })
    await user.selectOptions(priority, 'low')

    await waitFor(() =>
      expect(updateLoopItem.mock.calls).toEqual([
        [item.id, { version: 1, priority: 'high' }],
        [item.id, { version: 2, priority: 'low' }],
      ])
    )
    await waitFor(() =>
      expect(onUpdated).toHaveBeenLastCalledWith(
        expect.objectContaining({ priority: 'low', version: 3 })
      )
    )
    expect(priority).toHaveValue('low')
    expect(persisted).toEqual({ ...latest, priority: 'low', version: 3 })
  })

  it('rolls back a failed start date while preserving and saving a newer due date', async () => {
    const user = userEvent.setup()
    const item = {
      ...baseItem,
      start_at: '2026-11-02',
      due_at: '2026-11-04',
    }
    let persisted: CloudLoopItem = item
    const pending = deferred<CloudLoopItem>()
    const updateLoopItem = vi
      .fn(async (_id: string, values: Partial<CloudLoopItem>) => {
        persisted = { ...persisted, ...values, version: persisted.version + 1 }
        return persisted
      })
      .mockImplementationOnce(() => pending.promise)
    const onUpdated = vi.fn()
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        readFirst
        item={item}
        project={project}
        allItems={[item]}
        onUpdated={onUpdated}
        onClose={vi.fn()}
        api={{ ...api, updateLoopItem } as never}
      />
    )
    await user.click(screen.getByRole('button', { name: '时间范围' }))
    const startDate = screen.getByTestId('cloud-todo-detail-start-date')
    const dueDate = screen.getByTestId('cloud-todo-detail-due-date')
    fireEvent.change(startDate, { target: { value: '2026-11-03' } })
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledExactlyOnceWith(item.id, {
        version: 1,
        start_at: '2026-11-03',
      })
    )
    fireEvent.change(dueDate, { target: { value: '2026-11-06' } })
    expect(startDate).toHaveValue('2026-11-03')
    expect(dueDate).toHaveValue('2026-11-06')
    expect(updateLoopItem).toHaveBeenCalledOnce()

    await act(async () => {
      pending.reject(new Error('Start date update unavailable'))
    })

    await waitFor(() =>
      expect(updateLoopItem.mock.calls).toEqual([
        [item.id, { version: 1, start_at: '2026-11-03' }],
        [item.id, { version: 1, due_at: '2026-11-06' }],
      ])
    )
    await waitFor(() =>
      expect(onUpdated).toHaveBeenLastCalledWith(
        expect.objectContaining({ start_at: item.start_at, due_at: '2026-11-06', version: 2 })
      )
    )
    expect(persisted).toEqual({ ...item, due_at: '2026-11-06', version: 2 })
    expect(startDate).toHaveValue(item.start_at)
    expect(dueDate).toHaveValue('2026-11-06')
  })

  it('saves metadata independently before manually saving description and notifying the selected owner', async () => {
    const user = userEvent.setup({ delay: null })
    let persisted = baseItem
    const updateLoopItem = vi.fn(async (_id: string, values: Partial<CloudLoopItem>) => {
      persisted = { ...persisted, ...values, version: persisted.version + 1 }
      return persisted
    })
    const assignLoopItem = vi.fn(async () => {
      persisted = {
        ...persisted,
        assignee_agent_id: null,
        assignee_user_id: 7,
        assignee_name: '张三',
        version: persisted.version + 1,
      }
      return persisted
    })
    render(
      <TodoEditor
        mode="edit"
        presentation="workspace-panel"
        readFirst
        item={baseItem}
        project={{ ...project, access_role: 'Developer' }}
        allItems={[baseItem]}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
        currentUserId={1}
        api={
          {
            ...api,
            updateLoopItem,
            assignLoopItem,
            listCloudProjectMembers: vi.fn(async () => [
              { id: 7, user_id: 7, user_name: '张三', role: 'Developer' },
            ]),
          } as never
        }
      />
    )
    const description = await screen.findByTestId('cloud-todo-detail-description')
    await user.click(description)
    await user.keyboard(' Manual description')
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-detail-assignee-option-user:7'))
    await user.selectOptions(screen.getByTestId('cloud-todo-detail-status'), 'completed')
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledExactlyOnceWith(baseItem.id, {
        version: 1,
        status: 'completed',
      })
    )
    expect(assignLoopItem).not.toHaveBeenCalled()
    expect(description).toHaveTextContent('Manual description')
    expect(screen.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute('data-value', 'user:7')
    await user.click(screen.getByTestId('cloud-todo-save'))
    await waitFor(() =>
      expect(assignLoopItem).toHaveBeenCalledWith('11', baseItem.id, {
        version: 3,
        assigneeType: 'user',
        assigneeId: '7',
        notifyAssignee: true,
      })
    )
    expect(updateLoopItem).toHaveBeenLastCalledWith(baseItem.id, {
      version: 2,
      description: expect.stringContaining('Manual description'),
    })
    expect(screen.getByTestId('cloud-todo-detail-status')).toHaveValue('completed')
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
    await userEvent.click(screen.getByTestId('cloud-todo-personal-task-start'))
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
    await user.keyboard('{Enter}')

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

    await vi.waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({ tags: ['保留草稿'] })
      )
    )
  })
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

    const attachments = await screen.findByTestId('cloud-todo-attachment-toggle')
    expect(attachments).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('design.png')).not.toBeInTheDocument()
    await user.click(attachments)
    expect(attachments).toHaveAttribute('aria-expanded', 'true')
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
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(updateIssue).toHaveBeenCalledWith(
        'WEG-1',
        expect.objectContaining({ version: 1, title: '共享编辑' })
      )
    )
  })
})
