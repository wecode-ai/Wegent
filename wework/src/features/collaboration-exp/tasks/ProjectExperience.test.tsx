import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CollaborationMember, SharedWorkspaceApi } from '@wegent/collaboration'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
import '@/i18n'
import { experienceProjectFixture } from '../model/fixtures'
import { ProjectExperience } from './ProjectExperience'

const mock = vi.hoisted(() => ({ renderProject: vi.fn(), userId: 7 }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    state: { user: { id: mock.userId }, projects: [], devices: [], runtimeWork: null },
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
  mock.userId = 7
})

function deferredMembers() {
  let resolve!: (members: CollaborationMember[]) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<CollaborationMember[]>((success, failure) => {
    resolve = success
    reject = failure
  })
  return { promise, resolve, reject }
}

it('distinguishes initial member loading from a verified empty result', async () => {
  const props = propsFixture()
  const pending = deferredMembers()
  props.members.mockReturnValueOnce(pending.promise)
  const view = render(<ProjectExperience {...props} />)
  expect(view.getByTestId('collaboration-exp-project-members-loading')).toBeTruthy()
  expect(view.queryByTestId('collaboration-exp-project-members-empty')).toBeNull()
  await act(async () => pending.resolve([]))
  expect(view.queryByTestId('collaboration-exp-project-members-loading')).toBeNull()
  expect(view.getByTestId('collaboration-exp-project-members-empty')).toBeTruthy()
})

it('keeps verified members during a transient refresh failure and recovers through existing retry', async () => {
  const props = propsFixture()
  props.members.mockResolvedValueOnce([{ user_id: 8, user_name: 'Verified member' }])
  const view = render(<ProjectExperience {...props} />)
  await view.findByText('Verified member')
  const pending = deferredMembers()
  props.members.mockReturnValueOnce(pending.promise)
  view.rerender(<ProjectExperience {...props} active={false} />)
  view.rerender(<ProjectExperience {...props} />)
  expect(view.getByText('Verified member')).toBeTruthy()
  expect(view.getByTestId('collaboration-exp-project-members')).toHaveAttribute('aria-busy', 'true')
  await act(async () => pending.reject(new Error('Network unavailable')))
  expect(view.getByText('Verified member')).toBeTruthy()
  expect(view.getByRole('alert')).toBeTruthy()
  expect(view.queryByTestId('collaboration-exp-project-members-empty')).toBeNull()
  fireEvent.click(view.getByTestId('collaboration-exp-project-members-retry'))
  await view.findByTestId('collaboration-exp-project-members-empty')
  expect(view.queryByText('Verified member')).toBeNull()
})

it.each([{ status: 401 }, { status: 403 }, { status: 404 }, { code: 'permission_denied' }])(
  'invalidates verified members after a structured access failure %j',
  async cause => {
    const props = propsFixture()
    props.members.mockResolvedValueOnce([{ user_id: 8, user_name: 'Previously allowed member' }])
    const view = render(<ProjectExperience {...props} />)
    await view.findByText('Previously allowed member')
    props.members.mockRejectedValueOnce(cause)
    view.rerender(<ProjectExperience {...props} active={false} />)
    view.rerender(<ProjectExperience {...props} />)
    await view.findByRole('alert')
    expect(view.queryByText('Previously allowed member')).toBeNull()
    expect(view.queryByTestId('collaboration-exp-project-members-empty')).toBeNull()
    expect(view.queryByTestId('collaboration-exp-project-members-loading')).toBeNull()
    fireEvent.click(view.getByTestId('collaboration-exp-project-members-retry'))
    await view.findByTestId('collaboration-exp-project-members-empty')
  }
)

it('shows initial member failures with retry rather than an empty result', async () => {
  const props = propsFixture()
  props.members.mockRejectedValueOnce(new Error('Network unavailable'))
  const view = render(<ProjectExperience {...props} />)
  await view.findByRole('alert')
  expect(view.queryByTestId('collaboration-exp-project-members-empty')).toBeNull()
  expect(view.queryByTestId('collaboration-exp-project-members-loading')).toBeNull()
  const recovery = deferredMembers()
  props.members.mockReturnValueOnce(recovery.promise)
  fireEvent.click(view.getByTestId('collaboration-exp-project-members-retry'))
  expect(view.getByTestId('collaboration-exp-project-members-loading')).toBeTruthy()
  await act(async () => recovery.resolve([]))
  expect(view.getByTestId('collaboration-exp-project-members-empty')).toBeTruthy()
})

it.each(['account', 'backend', 'store', 'project-viewer'] as const)(
  'invalidates members on %s changes and ignores a late previous-scope refresh',
  async identity => {
    const props = propsFixture()
    props.members.mockResolvedValueOnce([{ user_id: 8, user_name: 'Previous scope member' }])
    let backend = 'https://backend-a.example'
    const content = (project = props.project, active = true) => (
      <CloudConnectionContext.Provider
        value={{ apiBaseUrl: backend } as CloudConnectionContextValue}
      >
        <ProjectExperience {...props} project={project} active={active} />
      </CloudConnectionContext.Provider>
    )
    const view = render(content())
    await view.findByText('Previous scope member')
    const oldRefresh = deferredMembers()
    const next = deferredMembers()
    props.members.mockReturnValueOnce(oldRefresh.promise).mockReturnValueOnce(next.promise)
    view.rerender(content(props.project, false))
    view.rerender(content())
    await waitFor(() => expect(props.members).toHaveBeenCalledTimes(2))
    if (identity === 'account') mock.userId = 9
    if (identity === 'backend') backend = 'https://backend-b.example'
    const project = {
      ...props.project,
      ...(identity === 'store' ? { project_store: 'local' as const } : {}),
      ...(identity === 'project-viewer' ? { current_user_id: 9 } : {}),
    }
    view.rerender(content(project))
    expect(view.queryByText('Previous scope member')).toBeNull()
    expect(view.getByTestId('collaboration-exp-project-members-loading')).toBeTruthy()
    await act(async () => oldRefresh.resolve([{ user_id: 10, user_name: 'Late old member' }]))
    expect(view.queryByText('Late old member')).toBeNull()
    await act(async () => next.resolve([{ user_id: 11, user_name: 'Current scope member' }]))
    expect(view.getByText('Current scope member')).toBeTruthy()
  }
)

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
