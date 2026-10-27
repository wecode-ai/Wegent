import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/i18n'
import type { CloudLoopItem, CloudProject, LoopItemTaskBinding } from '@/api/deliveries'
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

  it('shares the preview limit across child Issues and sessions, prioritizing active sessions', async () => {
    const children = Array.from({ length: 3 }, (_, index) => ({
      ...item,
      id: `child-${index}`,
      parent_id: item.id,
      title: `Child ${index}`,
      can_view_detail: index !== 2,
    }))
    const onOpenChildTask = vi.fn()
    render(
      editor({
        allItems: [item, ...children],
        showChildren: false,
        onOpenChildTask,
        taskExecutionStates: { '1': { status: 'running' } },
      })
    )

    const list = await screen.findByTestId('cloud-todo-task-list')
    expect(within(list).getAllByRole('button')).toHaveLength(2)
    expect(within(list).getAllByRole('button')[0]).toHaveTextContent('Task 1')
    expect(screen.getByTestId('cloud-todo-execution-task-count')).toHaveTextContent('12')
    await userEvent.click(screen.getByTestId('cloud-todo-toggle-tasks'))
    expect(within(list).getAllByRole('button')).toHaveLength(12)
    expect(within(list).getByTestId('cloud-todo-open-child-task-child-2')).toBeDisabled()
    await userEvent.click(within(list).getByText('Child 0'))
    expect(onOpenChildTask).toHaveBeenCalledWith(children[0])
  })

  it('expands deliveries independently and resets both lists when switching Issues', async () => {
    const user = userEvent.setup()
    const view = render(editor())
    const taskList = await screen.findByTestId('cloud-todo-task-list')
    const deliveryList = await screen.findByTestId('todo-detail-delivery-list')
    expect(within(deliveryList).getAllByRole('button')).toHaveLength(2)

    await user.click(screen.getByTestId('cloud-todo-toggle-tasks'))
    expect(within(deliveryList).getAllByRole('button')).toHaveLength(2)
    await user.click(screen.getByTestId('todo-detail-toggle-deliveries'))
    expect(within(deliveryList).getAllByRole('button')).toHaveLength(4)
    await user.click(screen.getByTestId('cloud-todo-toggle-tasks'))
    expect(within(deliveryList).getAllByRole('button')).toHaveLength(4)
    expect(within(taskList).getAllByRole('button')).toHaveLength(2)
    await user.click(screen.getByTestId('cloud-todo-toggle-tasks'))

    const nextItem = { ...item, id: 'ISSUE-2' }
    view.rerender(editor({ item: nextItem, allItems: [nextItem] }))

    expect(screen.getByTestId('cloud-todo-toggle-tasks')).toHaveAttribute('aria-expanded', 'false')
    expect(await screen.findByTestId('todo-detail-toggle-deliveries')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(within(screen.getByTestId('cloud-todo-task-list')).getAllByRole('button')).toHaveLength(
      2
    )
    expect(
      within(screen.getByTestId('todo-detail-delivery-list')).getAllByRole('button')
    ).toHaveLength(2)
  })
})
