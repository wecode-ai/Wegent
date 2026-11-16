import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { selectTaskRows } from '../model'
import { experienceIssueFixture, experienceProjectFixture } from '../model/fixtures'
import { TaskHome } from './TaskHome'

afterEach(cleanup)

const rows = selectTaskRows({
  viewer: 7,
  projects: [
    {
      project: experienceProjectFixture(),
      issues: [
        experienceIssueFixture({ id: 'waiting', title: 'Confirm the scope' }),
        experienceIssueFixture({
          id: 'running',
          title: 'Implement the selected scope',
          status: 'in_progress',
          execution_state: 'running',
        }),
        experienceIssueFixture({
          id: 'done',
          title: 'Approved work',
          status: 'reviewed',
          completed_at: '2026-11-03T00:00:00Z',
          execution_state: 'running',
        }),
        experienceIssueFixture({ id: 'hidden', title: 'Secret work', can_view_detail: false }),
      ],
    },
  ],
})

it('composes the home with real current work, team state, and the next visible decision', () => {
  const onSelect = vi.fn()
  const onCreate = vi.fn()
  const view = render(
    <TaskHome
      rows={rows}
      team={<section data-testid="shared-team-state" />}
      onSelect={onSelect}
      onCreate={onCreate}
    />
  )
  expect(view.getByTestId('shared-team-state')).toBeTruthy()
  expect(view.getByTestId('collaboration-exp-task-rhythm-waiting').textContent).toBe('1')
  expect(view.getByTestId('collaboration-exp-task-rhythm-running').textContent).toBe('1')
  expect(view.getByTestId('collaboration-exp-task-rhythm-completed').textContent).toBe('1')
  expect(view.queryByText('Secret work')).toBeNull()
  fireEvent.click(view.getByTestId('collaboration-exp-task-rhythm-current'))
  expect(onSelect).toHaveBeenLastCalledWith(rows.find(row => row.id === 'running'))
  fireEvent.click(view.getByTestId('collaboration-exp-task-home-next-open'))
  expect(onSelect).toHaveBeenLastCalledWith(rows.find(row => row.id === 'waiting'))
  fireEvent.click(view.getByTestId('collaboration-exp-task-home-create'))
  expect(onCreate).toHaveBeenCalledTimes(1)
})

it('removes current and next actions when the visible list contains only completed work', () => {
  const onSelect = vi.fn()
  const view = render(<TaskHome rows={rows.filter(row => row.id === 'done')} onSelect={onSelect} />)
  expect(view.getByTestId('collaboration-exp-task-rhythm-completed').textContent).toBe('1')
  expect(view.queryByTestId('collaboration-exp-task-rhythm-current')).toBeNull()
  expect(view.queryByTestId('collaboration-exp-task-home-next')).toBeNull()
  expect(view.queryByTestId('collaboration-exp-task-home-create')).toBeNull()
  expect(onSelect).not.toHaveBeenCalled()
})
