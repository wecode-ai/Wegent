import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { selectProjectScopes, selectTaskRows } from '../model'
import { experienceIssueFixture, experienceProjectFixture } from '../model/fixtures'
import { TaskListView } from './TaskListView'
import { TaskFilters, type TaskFilterValue } from './TaskFilters'

afterEach(cleanup)

const project = experienceProjectFixture()
const input = {
  projects: [
    {
      project,
      issues: [
        experienceIssueFixture(),
        experienceIssueFixture({ id: 'hidden', title: 'Secret title', can_view_detail: false }),
      ],
    },
  ],
  viewer: 7,
}
const projects = selectProjectScopes(input)
const filters: TaskFilterValue = {
  relevance: 'related',
  projectKey: projects[0].key,
  status: 'pending',
  search: '',
}

it('clears one filter, retains the others and restores its trigger focus', () => {
  const onChange = vi.fn()
  const view = render(
    <TaskFilters
      value={filters}
      projects={projects}
      statuses={[{ value: 'pending', label: 'Pending' }]}
      onChange={onChange}
    />
  )
  fireEvent.click(view.getByTestId('collaboration-exp-clear-status'))
  expect(onChange).toHaveBeenCalledWith({ ...filters, status: '' })
  expect(document.activeElement).toBe(view.getByTestId('collaboration-exp-filter-status'))
  expect(view.getByTestId('collaboration-exp-clear-projectKey')).toBeTruthy()
})

it('expands search with focus and preserves project and status in its update', async () => {
  const onChange = vi.fn()
  const view = render(
    <TaskFilters
      value={filters}
      projects={projects}
      statuses={[{ value: 'pending', label: 'Pending' }]}
      onChange={onChange}
    />
  )
  fireEvent.click(view.getByTestId('collaboration-exp-search-toggle'))
  const search = view.getByTestId('collaboration-exp-task-search')
  await waitFor(() => expect(document.activeElement).toBe(search))
  fireEvent.change(search, { target: { value: 'release' } })
  expect(onChange).toHaveBeenCalledWith({ ...filters, search: 'release' })
})

it('renders visible Issue rows once and lets the project action open independently', () => {
  const onSelect = vi.fn()
  const onOpenProject = vi.fn()
  const view = render(
    <TaskListView
      rows={selectTaskRows(input)}
      projects={projects}
      statuses={[]}
      filters={filters}
      loading={false}
      onFiltersChange={vi.fn()}
      onSelect={onSelect}
      onOpenProject={onOpenProject}
      onRetry={vi.fn()}
    />
  )
  expect(view.queryByText('Secret title')).toBeNull()
  expect(view.getAllByTestId('collaboration-exp-task-row-EXP-1')).toHaveLength(1)
  fireEvent.click(view.getByTestId('collaboration-exp-task-project-EXP-1'))
  expect(onOpenProject).toHaveBeenCalledWith(
    expect.objectContaining({ key: projects[0].key, id: project.id })
  )
  expect(onSelect).not.toHaveBeenCalled()
  fireEvent.click(view.getByTestId('collaboration-exp-task-EXP-1'))
  expect(onSelect).toHaveBeenCalledTimes(1)
})

it('shows retry without presenting a failed load as an empty successful result', () => {
  const onRetry = vi.fn()
  const view = render(
    <TaskListView
      rows={[]}
      projects={projects}
      statuses={[]}
      filters={filters}
      loading={false}
      error="Source offline"
      onFiltersChange={vi.fn()}
      onSelect={vi.fn()}
      onOpenProject={vi.fn()}
      onRetry={onRetry}
    />
  )
  expect(view.getByRole('alert').textContent).toContain('Source offline')
  expect(view.queryByTestId('collaboration-exp-tasks-empty')).toBeNull()
  expect(view.queryByTestId('collaboration-exp-task-rhythm')).toBeNull()
  fireEvent.click(view.getByTestId('collaboration-exp-tasks-retry'))
  expect(onRetry).toHaveBeenCalledTimes(1)
})

it('keeps a completed task static when its last execution projection still says running', () => {
  const rows = selectTaskRows({
    ...input,
    projects: [
      {
        project,
        issues: [
          experienceIssueFixture({
            status: 'reviewed',
            completed_at: '2026-11-03T00:00:00Z',
            execution_state: 'running',
          }),
        ],
      },
    ],
  })
  const view = render(
    <TaskListView
      rows={rows}
      projects={projects}
      statuses={[]}
      filters={filters}
      loading={false}
      onFiltersChange={vi.fn()}
      onSelect={vi.fn()}
      onOpenProject={vi.fn()}
      onRetry={vi.fn()}
    />
  )
  expect(view.getByTestId('collaboration-exp-task-rhythm-completed').textContent).toBe('1')
  expect(view.queryByTestId('collaboration-exp-task-rhythm-current')).toBeNull()
  expect(view.getByTestId('collaboration-exp-task-EXP-1').querySelector('.animate-spin')).toBeNull()
})
