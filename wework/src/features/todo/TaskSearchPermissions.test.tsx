import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import '@/i18n'
import { GlobalTodoSearch } from './GlobalTodoSearch'
import { TaskSearchPanel } from './TaskSearchPanel'
import { emptyTaskSearchFilters } from './taskSearch'

const restrictedItem: CloudLoopItem = {
  id: 'PUBLIC-1',
  cloud_project_id: 'project-1',
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  can_view_detail: false,
  can_edit: false,
  assignee_user_id: null,
  title: 'Other user task',
  description: '',
  status: 'pending',
  priority: 'none',
  due_at: null,
  tags: [],
  sort_order: 1,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  completed_at: null,
}

describe('task search permissions', () => {
  test('project search cannot open a restricted task', async () => {
    const onSelect = vi.fn()
    render(
      <TaskSearchPanel
        items={[restrictedItem]}
        members={[]}
        query="other"
        filters={emptyTaskSearchFilters}
        tags={[]}
        onQueryChange={() => undefined}
        onFiltersChange={() => undefined}
        onSelect={onSelect}
      />
    )

    const result = screen.getByTestId('cloud-task-search-result-PUBLIC-1')
    expect(result).toBeDisabled()
    await userEvent.click(result)
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('global search cannot open a restricted task', async () => {
    const onSelectItem = vi.fn()
    render(
      <GlobalTodoSearch
        projects={[
          {
            id: 'project-1',
            name: 'Public project',
            project_key: 'PUBLIC',
            description: '',
          },
        ]}
        projectItems={{ 'project-1': [restrictedItem] }}
        projectMembers={{}}
        query="other"
        onQueryChange={() => undefined}
        onClose={() => undefined}
        onSelectProject={() => undefined}
        onSelectItem={onSelectItem}
      />
    )

    const result = screen.getByTestId('cloud-global-search-result-PUBLIC-1')
    expect(result).toBeDisabled()
    await userEvent.click(result)
    expect(onSelectItem).not.toHaveBeenCalled()
  })
})
