import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import '@/i18n'
import { experienceProjectFixture } from '../model/fixtures'
import { ProjectExperience } from './ProjectExperience'

const mock = vi.hoisted(() => ({ renderProject: vi.fn() }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    state: { user: { id: 7 }, projects: [], devices: [], runtimeWork: null },
    services: {},
  }),
}))
vi.mock('@/features/todo/WeworkCollaborationPlatform', () => ({
  WeworkSharedProject: (props: unknown) => {
    mock.renderProject(props)
    return <div data-testid="existing-project-view" />
  },
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function propsFixture() {
  const members = vi.fn().mockResolvedValue([])
  return {
    project: experienceProjectFixture(),
    api: { members: { list: members } } as unknown as SharedWorkspaceApi,
    active: true,
    view: 'overview' as const,
    planView: 'board' as const,
    onViewChange: vi.fn(),
    onPlanViewChange: vi.fn(),
    onOpenIssue: vi.fn(),
    onBack: vi.fn(),
    members,
  }
}

it('does not mount configuration or offer its entry to a viewer, including a direct query', () => {
  const props = propsFixture()
  const view = render(
    <ProjectExperience
      {...props}
      project={{ ...props.project, access_role: 'Viewer' }}
      view="settings"
    />
  )
  expect(view.queryByTestId('collaboration-exp-project-settings')).toBeNull()
  expect(view.getByRole('status').textContent).toContain('无权')
  expect(mock.renderProject).not.toHaveBeenCalled()
  expect(props.members).not.toHaveBeenCalled()
})

it('reuses the existing planning view and returns an Issue selection to the experience route', () => {
  const props = propsFixture()
  const view = render(<ProjectExperience {...props} view="plan" planView="calendar" />)
  const adapter = mock.renderProject.mock.lastCall?.[0] as {
    location: { projectView: string }
    setLocation(update: (value: unknown) => unknown): void
  }
  expect(view.getByTestId('existing-project-view')).toBeTruthy()
  expect(adapter.location.projectView).toBe('calendar')
  adapter.setLocation(previous => ({ ...(previous as object), issueId: 'EXP-2' }))
  expect(props.onOpenIssue).toHaveBeenCalledWith('EXP-2')
  fireEvent.click(view.getByTestId('collaboration-exp-project-overview'))
  expect(props.onViewChange).toHaveBeenCalledWith('overview')
})

it('keeps an inactive project from mounting planners or requesting member data', async () => {
  const props = propsFixture()
  const view = render(<ProjectExperience {...props} active={false} view="plan" />)
  expect(mock.renderProject).not.toHaveBeenCalled()
  view.rerender(<ProjectExperience {...props} active={false} />)
  await waitFor(() =>
    expect(view.getByTestId('collaboration-exp-project-overview-body')).toBeTruthy()
  )
  expect(props.members).not.toHaveBeenCalled()
})

it('never retains another project member list while the new source is pending or rejected', async () => {
  const props = propsFixture()
  props.members.mockResolvedValueOnce([{ user_id: 8, user_name: 'Project A member' }])
  const view = render(<ProjectExperience {...props} />)
  await view.findByText('Project A member')
  let reject!: (reason: Error) => void
  props.members.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail
      })
  )
  view.rerender(
    <ProjectExperience
      {...props}
      project={{ ...props.project, id: 'project-b', name: 'Project B' }}
    />
  )
  expect(view.queryByText('Project A member')).toBeNull()
  await act(async () => reject(new Error('Cannot read Project B members')))
  expect(view.queryByText('Project A member')).toBeNull()
  expect(view.getByRole('alert')).toBeTruthy()
})
