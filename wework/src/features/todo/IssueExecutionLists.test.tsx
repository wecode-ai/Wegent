import type { CloudLoopItem, CloudProject, LoopItemTaskBinding } from '@/api/deliveries'
import '@/i18n'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoEditor } from './TodoEditor'

const item = {
  id: 'ISSUE-1',
  cloud_project_id: '11',
  title: 'Linked tasks',
  description: '',
  status: 'in_progress',
  priority: 'none',
  parent_id: null,
  tags: [],
  can_edit: true,
  version: 1,
} as CloudLoopItem

const tasks = Array.from({ length: 9 }, (_, index) => ({
  id: index + 1,
  task_user_id: 1,
  device_id: 'local-device',
  task_id: `task-${index + 1}`,
  task_title: `Task ${index + 1}`,
  linked_at: `2026-10-22T08:00:0${index}Z`,
})) as LoopItemTaskBinding[]

const deliveries = Array.from({ length: 4 }, (_, index) => ({
  id: `delivery-${index}`,
  loop_item_id: item.id,
  status: 'delivered',
  assets: [],
  fulfillments: [],
  created_at: '2026-10-22T08:00:00Z',
  delivered_at: '2026-10-22T08:00:00Z',
}))

const api = {
  listDeliveries: vi.fn(async () => ({ items: deliveries })),
  listTaskBindings: vi.fn(async () => []),
  listLoopItemAttachments: vi.fn(async () => []),
  listLoopItemCollaborators: vi.fn(async () => []),
  listCloudProjectMembers: vi.fn(async () => []),
} as never

function editor(overrides: Partial<ComponentProps<typeof TodoEditor>> = {}) {
  return (
    <TodoEditor
      mode="edit"
      presentation="workspace-panel"
      item={item}
      project={{ id: '11', name: 'Wework' } as CloudProject}
      allItems={[item]}
      onUpdated={vi.fn()}
      onClose={vi.fn()}
      api={api}
      currentUserId={1}
      initialTaskBindings={tasks}
      {...overrides}
    />
  )
}

describe('Issue execution lists', () => {
  beforeEach(() =>
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
  )
  afterEach(() => vi.unstubAllGlobals())
  it('previews two of nine tasks and expands inside the task section with keyboard support', async () => {
    const user = userEvent.setup()
    const onCreateTask = vi.fn()
    const onOpenTaskConversation = vi.fn()
    render(editor({ onCreateTask, onOpenTaskConversation }))

    const section = await screen.findByTestId('cloud-todo-tasks')
    const list = within(section).getByTestId('cloud-todo-task-list')
    const toggle = within(section).getByRole('button', { name: '查看全部 9 个' })
    expect(within(list).getAllByRole('button')).toHaveLength(2)
    expect(within(list).getByText('Task 9')).toBeInTheDocument()
    expect(within(list).getByText('Task 8')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-controls', list.id)
    expect(screen.getByTestId('cloud-todo-state-summary')).not.toContainElement(toggle)

    toggle.focus()
    await user.keyboard('{Enter}')

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(list).getAllByRole('button')).toHaveLength(9)
    expect(list).toHaveAttribute('tabindex', '0')
    expect(list).not.toContainElement(toggle)
    expect(list).not.toContainElement(within(section).getByTestId('cloud-todo-create-task'))
    await user.click(within(list).getByText('Task 1'))
    expect(onOpenTaskConversation).toHaveBeenCalledWith(tasks[0])
    await user.click(within(section).getByTestId('cloud-todo-create-task'))
    expect(onCreateTask).toHaveBeenCalledOnce()

    list.scrollTop = 200
    await user.click(toggle)
    expect(within(list).getAllByRole('button')).toHaveLength(2)
    expect(list.scrollTop).toBe(0)
    expect(list).not.toHaveAttribute('tabindex')
    await user.click(toggle)
    expect(list.scrollTop).toBe(0)
  })

  it('bounds the preview even when all nine tasks are running', async () => {
    render(
      editor({
        taskExecutionStates: Object.fromEntries(
          tasks.map(task => [task.id, { status: 'running' as const }])
        ),
      })
    )

    const list = await screen.findByTestId('cloud-todo-task-list')
    expect(within(list).getAllByRole('button')).toHaveLength(2)
    await userEvent.click(screen.getByTestId('cloud-todo-toggle-tasks'))
    expect(within(list).getAllByRole('button')).toHaveLength(9)
    expect(within(list).getAllByText('执行中')).toHaveLength(9)
  })
})
