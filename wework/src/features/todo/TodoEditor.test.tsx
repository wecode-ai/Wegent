import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { TodoEditor } from './TodoEditor'
import { markdownAttachmentRows } from './attachmentMarkdown'

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

  it('keeps user edits when an external version update arrives', async () => {
    const user = userEvent.setup()
    const view = render(editorElement(baseItem))
    await user.type(screen.getByTestId('cloud-todo-detail-title'), ' 手工补充')

    view.rerender(editorElement({ ...baseItem, version: 2, status: 'completed' }))

    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveValue('Inspect changes 手工补充')
    expect(screen.getByTestId('cloud-todo-detail-status')).toHaveValue('completed')
  })

  it('assigns a member through the assign route with a string user id', async () => {
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

    await screen.findByRole('option', { name: '张三' })
    await user.selectOptions(screen.getByTestId('cloud-todo-detail-assignee'), 'user:5')
    await user.click(screen.getByTestId('cloud-todo-save'))

    await vi.waitFor(() => {
      expect(assignApi.assignLoopItem).toHaveBeenCalledWith('11', 'WEG-1', {
        version: 2,
        assigneeType: 'user',
        assigneeId: '5',
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

    await screen.findByRole('option', { name: '张三' })
    await user.selectOptions(screen.getByTestId('cloud-todo-detail-assignee'), '')
    await user.click(screen.getByTestId('cloud-todo-save'))

    await vi.waitFor(() => {
      expect(clearApi.updateLoopItem).toHaveBeenLastCalledWith('WEG-1', {
        version: 2,
        assignee_user_id: null,
        assignee_agent_id: null,
      })
    })
    expect(clearApi.assignLoopItem).not.toHaveBeenCalled()
  })
})

describe('TodoEditor assignment chain', () => {
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

  it('does not render the trigger when the item has no assignment history', () => {
    render(editorElement(baseItem))
    expect(screen.queryByTestId('cloud-todo-assignment-chain-trigger')).not.toBeInTheDocument()
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
    expect(screen.getByText('评论 / 动态')).toBeInTheDocument()
  })
})
