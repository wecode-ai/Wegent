import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { selectProjectScopes, selectTaskRows } from '../model'
import { experienceIssueFixture, experienceProjectFixture } from '../model/fixtures'
import { TaskListView } from './TaskListView'
import { TaskFilters, type TaskFilterValue } from './TaskFilters'

afterEach(cleanup)

it('loads an independently ready next page while unrelated page data is loading', () => {
  const onLoadMore = vi.fn()
  const view = render(
    <TaskListView
      rows={[]}
      projects={[]}
      statuses={[]}
      filters={{ relevance: 'related', projectKey: '', status: '', search: '' }}
      loading
      loadMoreReady
      hasMore
      onFiltersChange={vi.fn()}
      onSelect={vi.fn()}
      onOpenProject={vi.fn()}
      onRetry={vi.fn()}
      onLoadMore={onLoadMore}
    />
  )
  const more = view.getByTestId('collaboration-exp-tasks-more')
  expect(more).toBeEnabled()
  fireEvent.click(more)
  expect(onLoadMore).toHaveBeenCalledOnce()
  view.rerender(
    <TaskListView
      rows={[]}
      projects={[]}
      statuses={[]}
      filters={{ relevance: 'related', projectKey: '', status: '', search: '' }}
      loading
      loadMoreReady={false}
      hasMore
      onFiltersChange={vi.fn()}
      onSelect={vi.fn()}
      onOpenProject={vi.fn()}
      onRetry={vi.fn()}
      onLoadMore={onLoadMore}
    />
  )
  expect(more).toBeDisabled()
})

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

it('shows selected labels inside both real searchable filter triggers', () => {
  const view = render(
    <TaskFilters
      value={filters}
      projects={projects}
      statuses={[{ value: 'pending', label: 'Pending' }]}
      onChange={vi.fn()}
    />
  )
  expect(view.getByTestId('collaboration-exp-filter-status')).toHaveTextContent('Pending')
  expect(view.getByTestId('collaboration-exp-filter-projectKey')).toHaveTextContent(project.name)
})

it('shows all-status and all-project labels after opening unselected filters', () => {
  const view = render(
    <TaskFilters
      value={{ ...filters, projectKey: '', status: '' }}
      projects={projects}
      statuses={[{ value: 'pending', label: 'Pending' }]}
      onChange={vi.fn()}
    />
  )
  fireEvent.click(view.getByTestId('collaboration-exp-search-toggle'))
  expect(view.getByTestId('collaboration-exp-filter-status')).toHaveTextContent('全部状态')
  expect(view.getByTestId('collaboration-exp-filter-projectKey')).toHaveTextContent('全部项目')
})

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
      loadMoreReady={false}
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
      loadMoreReady={false}
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
      loadMoreReady={false}
      onFiltersChange={vi.fn()}
      onSelect={vi.fn()}
      onOpenProject={vi.fn()}
      onRetry={vi.fn()}
    />
  )
  expect(view.queryByTestId('collaboration-exp-task-rhythm')).toBeNull()
  expect(view.getByTestId('collaboration-exp-task-EXP-1').querySelector('.animate-spin')).toBeNull()
})

it('keeps filters collapsed by default and exposes a real creation callback in its toolbar', () => {
  const onCreate = vi.fn()
  const onModeChange = vi.fn()
  const view = render(
    <TaskFilters
      value={{ relevance: 'related', search: '', status: '', projectKey: '' }}
      projects={projects}
      statuses={[]}
      onChange={vi.fn()}
      onModeChange={onModeChange}
      onCreate={onCreate}
    />
  )
  expect(view.getByTestId('collaboration-exp-search-toggle').getAttribute('aria-expanded')).toBe(
    'false'
  )
  expect(view.queryByTestId('collaboration-exp-filter-relevance')).toBeNull()
  expect(view.queryByTestId('collaboration-exp-task-search')).toBeNull()
  fireEvent.click(view.getByTestId('collaboration-exp-task-create'))
  expect(onCreate).toHaveBeenCalledTimes(1)
  fireEvent.click(view.getByTestId('collaboration-exp-task-view-mode'))
  fireEvent.keyDown(view.getByTestId('collaboration-exp-task-view-mode-tasks'), {
    key: 'ArrowDown',
  })
  expect(document.activeElement).toBe(view.getByTestId('collaboration-exp-task-view-mode-projects'))
  fireEvent.click(view.getByTestId('collaboration-exp-task-view-mode-projects'))
  expect(onModeChange).toHaveBeenCalledWith('projects')
  fireEvent.click(view.getByTestId('collaboration-exp-search-toggle'))
  expect(view.getByTestId('collaboration-exp-filter-relevance')).toBeTruthy()
})

it('opens an authorized project from the project mode using only visible task counts', () => {
  const onOpenProject = vi.fn()
  const view = render(
    <TaskListView
      rows={selectTaskRows(input)}
      projects={projects}
      statuses={[]}
      filters={{ ...filters, projectKey: '', status: '' }}
      mode="projects"
      loading={false}
      loadMoreReady={false}
      onFiltersChange={vi.fn()}
      onSelect={vi.fn()}
      onOpenProject={onOpenProject}
      onRetry={vi.fn()}
    />
  )
  const projectRow = view.getByTestId(`collaboration-exp-task-project-scope-${project.id}`)
  expect(projectRow.textContent).toContain('1')
  expect(view.queryByText('Secret title')).toBeNull()
  expect(view.queryByTestId('collaboration-exp-task-row-EXP-1')).toBeNull()
  fireEvent.click(projectRow)
  expect(onOpenProject).toHaveBeenCalledWith(projects[0])
})

it('routes the project toolbar creation action to project creation', () => {
  const onCreate = vi.fn()
  const onCreateProject = vi.fn()
  const view = render(
    <TaskFilters
      value={{ relevance: 'related', search: '', status: '', projectKey: '' }}
      projects={projects}
      statuses={[]}
      mode="projects"
      onChange={vi.fn()}
      onCreate={onCreate}
      onCreateProject={onCreateProject}
    />
  )
  fireEvent.click(view.getByTestId('collaboration-exp-task-create'))
  expect(onCreateProject).toHaveBeenCalledTimes(1)
  expect(onCreate).not.toHaveBeenCalled()
})
