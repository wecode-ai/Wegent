import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CloudMyWorkItem } from '@/api/deliveries'
import { CloudMyWorkView } from './CloudMyWorkView'

function dueAt(offsetDays: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  date.setHours(12, 0, 0, 0)
  return date.toISOString()
}

function makeItem(overrides: Partial<CloudMyWorkItem>): CloudMyWorkItem {
  return {
    id: 'WEG-1',
    cloud_project_id: 1,
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: 1,
    title: 'Cloud TODO',
    description: '',
    status: 'inbox',
    priority: 'none',
    due_at: null,
    sort_order: 0,
    current_delivery_id: null,
    version: 1,
    created_at: '2026-07-22T00:00:00Z',
    updated_at: '2026-07-22T00:00:00Z',
    completed_at: null,
    project_key: 'WEG',
    project_name: 'Wegent',
    has_active_task: false,
    ...overrides,
  }
}

const items: CloudMyWorkItem[] = [
  makeItem({
    id: 'WEG-1',
    title: '需要处理的任务',
    status: 'pending',
    priority: 'high',
    due_at: dueAt(0),
  }),
  makeItem({
    id: 'WEG-2',
    title: '执行中的任务',
    status: 'in_progress',
    has_active_task: true,
    priority: 'medium',
    due_at: dueAt(1),
  }),
  makeItem({
    id: 'WEG-3',
    title: '待确认的任务',
    status: 'in_review',
    priority: 'low',
    due_at: dueAt(2),
  }),
  makeItem({ id: 'WEG-4', title: '已完成的任务', status: 'completed', due_at: dueAt(-1) }),
  makeItem({ id: 'WEG-5', title: '无截止的任务', status: 'pending' }),
  makeItem({
    id: 'WEG-6',
    title: '待我批准的任务',
    status: 'pending',
    execution_state: 'pending_approval',
    can_approve: true,
  }),
]

function renderView(onSelectItem = vi.fn()) {
  render(<CloudMyWorkView items={items} onSelectItem={onSelectItem} />)
  return onSelectItem
}

describe('CloudMyWorkView', () => {
  it('renders the grouped view with the original my-work grouping semantics', () => {
    renderView()
    const groups = screen.getByTestId('my-work-groups')
    expect(within(groups).getByText('需要我处理')).toBeInTheDocument()
    expect(within(groups).getByText('正在执行')).toBeInTheDocument()
    expect(within(groups).getByText('等待确认')).toBeInTheDocument()
    expect(within(groups).getByText('已完成')).toBeInTheDocument()
    // 需要我处理: not completed and no active task (WEG-1, WEG-3, WEG-5)
    expect(screen.getByTestId('my-work-group-action-WEG-1')).toBeInTheDocument()
    expect(screen.getByTestId('my-work-group-action-WEG-3')).toBeInTheDocument()
    expect(screen.getByTestId('my-work-group-action-WEG-5')).toBeInTheDocument()
    expect(screen.getByTestId('my-work-group-running-WEG-2')).toBeInTheDocument()
    expect(screen.getByTestId('my-work-group-review-WEG-3')).toBeInTheDocument()
    expect(screen.getByTestId('my-work-group-done-WEG-4')).toBeInTheDocument()
  })

  it('selecting an item in the grouped view notifies the parent', async () => {
    const onSelectItem = renderView()
    await userEvent.click(screen.getByTestId('my-work-group-action-WEG-1'))
    expect(onSelectItem).toHaveBeenCalledWith(items[0])
  })

  it('shows pending-approval runs the current user must approve in the approval group', () => {
    renderView()
    const groups = screen.getByTestId('my-work-groups')
    expect(within(groups).getByText('待我批准')).toBeInTheDocument()
    expect(screen.getByTestId('my-work-group-approval-WEG-6')).toBeInTheDocument()
    // The approval item is not duplicated under "需要我处理".
    expect(screen.queryByTestId('my-work-group-action-WEG-6')).not.toBeInTheDocument()
  })

  it('approves a pending run from the approval group without opening the task', async () => {
    const onSelectItem = vi.fn()
    const onApproveItem = vi.fn(async () => undefined)
    render(
      <CloudMyWorkView items={items} onSelectItem={onSelectItem} onApproveItem={onApproveItem} />
    )

    expect(screen.getByTestId('my-work-approve-WEG-6')).toBeInTheDocument()
    expect(screen.queryByTestId('my-work-approve-WEG-1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('my-work-approve-WEG-6'))
    expect(onApproveItem).toHaveBeenCalledWith(items[5])
    expect(onSelectItem).not.toHaveBeenCalled()
  })

  it('switches to the list view sorted by due date', async () => {
    const onSelectItem = renderView()
    await userEvent.click(screen.getByTestId('my-work-view-tab-list'))
    const list = screen.getByTestId('my-work-list')
    const rows = within(list)
      .getAllByRole('button')
      .map(row => row.getAttribute('data-testid'))
    expect(rows).toEqual([
      'my-work-list-row-WEG-4',
      'my-work-list-row-WEG-1',
      'my-work-list-row-WEG-2',
      'my-work-list-row-WEG-3',
      'my-work-list-row-WEG-5',
      'my-work-list-row-WEG-6',
    ])
    await userEvent.click(screen.getByTestId('my-work-list-row-WEG-2'))
    expect(onSelectItem).toHaveBeenCalledWith(items[1])
  })

  it('switches to the timeline view grouped by due day', async () => {
    renderView()
    await userEvent.click(screen.getByTestId('my-work-view-tab-timeline'))
    const timeline = screen.getByTestId('my-work-timeline')
    expect(within(timeline).getByText(/^今天 · /)).toBeInTheDocument()
    expect(within(timeline).getByText(/^明天 · /)).toBeInTheDocument()
    expect(within(timeline).getByText('无截止日期')).toBeInTheDocument()
    expect(screen.getByTestId('my-work-timeline-item-WEG-5')).toBeInTheDocument()
  })

  it('switches to the calendar view showing dated tasks and forwards clicks', async () => {
    const onSelectItem = renderView()
    await userEvent.click(screen.getByTestId('my-work-view-tab-calendar'))
    const calendar = await screen.findByTestId('my-work-calendar')
    expect(await within(calendar).findByText('需要处理的任务')).toBeInTheDocument()
    expect(within(calendar).queryByText('无截止的任务')).not.toBeInTheDocument()
    await userEvent.click(within(calendar).getByText('需要处理的任务'))
    expect(onSelectItem).toHaveBeenCalledWith(items[0])
  })

  it('marks the active tab as selected', async () => {
    renderView()
    expect(screen.getByTestId('my-work-view-tab-group')).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByTestId('my-work-view-tab-timeline'))
    expect(screen.getByTestId('my-work-view-tab-timeline')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('my-work-view-tab-group')).toHaveAttribute('aria-selected', 'false')
  })
})
