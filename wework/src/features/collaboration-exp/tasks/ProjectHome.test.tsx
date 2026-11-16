import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { selectProjectScopes, selectTaskRows } from '../model'
import { experienceIssueFixture, experienceProjectFixture } from '../model/fixtures'
import { ProjectHome } from './ProjectHome'

afterEach(cleanup)

it('highlights only projects with a visible waiting task and opens real create and project actions', () => {
  const project = experienceProjectFixture()
  const other = experienceProjectFixture({
    id: 'other',
    name: 'Other project',
    project_key: 'OTHER',
  })
  const input = {
    viewer: 7,
    projects: [
      {
        project,
        issues: [
          experienceIssueFixture({ title: 'Confirm scope' }),
          experienceIssueFixture({ id: 'hidden', title: 'Secret task', can_view_detail: false }),
        ],
      },
      {
        project: other,
        issues: [
          experienceIssueFixture({
            id: 'done',
            cloud_project_id: other.id,
            title: 'Finished work',
            completed_at: '2026-11-03T00:00:00Z',
          }),
        ],
      },
    ],
  }
  const projects = selectProjectScopes(input)
  const rows = selectTaskRows(input)
  const onOpenProject = vi.fn()
  const onCreate = vi.fn()
  const view = render(
    <ProjectHome
      projects={projects}
      rows={rows}
      onOpenProject={onOpenProject}
      onCreate={onCreate}
    />
  )
  expect(view.getAllByTestId(/^collaboration-exp-project-highlight-/)).toHaveLength(1)
  expect(view.queryByText('Secret task')).toBeNull()
  expect(view.getByTestId('collaboration-exp-project-highlight-project-1').textContent).toContain(
    'Confirm scope'
  )
  fireEvent.click(view.getByTestId('collaboration-exp-project-highlight-project-1'))
  expect(onOpenProject).toHaveBeenCalledWith(projects[0])
  fireEvent.click(view.getByTestId('collaboration-exp-project-home-create'))
  expect(onCreate).toHaveBeenCalledTimes(1)
  view.rerender(
    <ProjectHome
      projects={projects}
      rows={rows.filter(row => row.id === 'done')}
      onOpenProject={onOpenProject}
    />
  )
  expect(view.queryAllByTestId(/^collaboration-exp-project-highlight-/)).toHaveLength(0)
  expect(view.queryByTestId('collaboration-exp-project-home-create')).toBeNull()
})
