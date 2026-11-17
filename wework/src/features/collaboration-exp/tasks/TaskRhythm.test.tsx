import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { selectTaskRows } from '../model'
import { experienceIssueFixture, experienceProjectFixture } from '../model/fixtures'
import { TaskRhythm } from './TaskRhythm'

afterEach(cleanup)

const completed = experienceIssueFixture({
  id: 'done',
  title: 'Finished work',
  status: 'completed',
  completed_at: '2026-11-03T00:00:00Z',
})
const rows = selectTaskRows({
  viewer: 7,
  projects: [
    {
      project: experienceProjectFixture(),
      issues: [
        experienceIssueFixture({ id: 'waiting', title: 'Choose scope' }),
        experienceIssueFixture({
          id: 'running',
          title: 'Implement current work',
          status: 'in_progress',
          execution_state: 'running',
        }),
        completed,
        completed,
        experienceIssueFixture({
          id: 'secret',
          title: 'Hidden active work',
          execution_state: 'running',
          can_view_detail: false,
        }),
      ],
    },
  ],
})

it('summarizes only the visible unique rows and opens the current execution through selection', () => {
  const onSelect = vi.fn()
  const view = render(<TaskRhythm rows={rows} onSelect={onSelect} />)
  expect(view.getByTestId('collaboration-exp-task-rhythm-waiting').textContent).toBe('1')
  expect(view.getByTestId('collaboration-exp-task-rhythm-running').textContent).toBe('1')
  expect(view.getByTestId('collaboration-exp-task-rhythm-completed').textContent).toBe('1')
  expect(view.queryByText('Hidden active work')).toBeNull()
  fireEvent.click(view.getByTestId('collaboration-exp-task-rhythm-current'))
  expect(onSelect).toHaveBeenCalledWith(rows.find(row => row.id === 'running'))
  expect(onSelect).toHaveBeenCalledTimes(1)
})

it('updates counts and removes a current item excluded by the existing list filters', () => {
  const onSelect = vi.fn()
  const view = render(<TaskRhythm rows={rows} onSelect={onSelect} />)
  view.rerender(
    <TaskRhythm rows={rows.filter(row => row.status === 'completed')} onSelect={onSelect} />
  )
  expect(view.getByTestId('collaboration-exp-task-rhythm-waiting').textContent).toBe('0')
  expect(view.getByTestId('collaboration-exp-task-rhythm-running').textContent).toBe('0')
  expect(view.getByTestId('collaboration-exp-task-rhythm-completed').textContent).toBe('1')
  expect(view.queryByTestId('collaboration-exp-task-rhythm-current')).toBeNull()
  expect(onSelect).not.toHaveBeenCalled()
})
