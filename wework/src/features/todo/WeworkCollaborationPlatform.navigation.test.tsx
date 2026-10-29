import { useCallback, useState, type ComponentProps } from 'react'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  CollaborationApp,
  CollaborationPlatformApp,
  CollaborationPlatformLocation,
  CollaborationProject,
} from '@wegent/collaboration'
import type { RuntimeProjectSpaceRef } from '@/types/api'
import { WeworkCollaborationPlatform } from './WeworkCollaborationPlatform'

vi.mock('@wegent/collaboration', async importOriginal => {
  const actual = await importOriginal<typeof import('@wegent/collaboration')>()
  return {
    ...actual,
    CollaborationPlatformApp: ({
      host,
      renderProject,
    }: ComponentProps<typeof CollaborationPlatformApp>) => (
      <>
        <output data-testid="navigation-location">{JSON.stringify(host.location)}</output>
        <button
          onClick={() =>
            host.navigate({
              ...host.location,
              rootView: 'home',
              workspaceId: 'workspace',
              workspaceView: 'projects',
              projectId: 'project',
              projectView: 'board',
              issueId: null,
            })
          }
        >
          Open project
        </button>
        <button onClick={() => host.manageResource?.('agents')}>Manage agents</button>
        <button onClick={() => host.manageResource?.('environments')}>Manage environments</button>
        {host.location.rootView === 'stand-in'
          ? host.renderStandInPage?.({ projects: [], onClose: vi.fn() })
          : host.location.projectId
            ? renderProject?.({
                project: project(host.location.projectId),
                workspace: { id: 'workspace', name: 'Workspace' },
              } as never)
            : null}
      </>
    ),
    CollaborationApp: ({ host, initialProject }: ComponentProps<typeof CollaborationApp>) => (
      <>
        {host.renderProjectHeaderAction?.(initialProject!)}
        <button onClick={() => host.navigate({ ...host.location, issueId: 'latest-issue' })}>
          Open child Issue
        </button>
        <button
          onClick={() =>
            host.navigate({
              ...host.location,
              issueId: null,
              view: 'manage',
              projectSettingsSection: 'agents',
            })
          }
        >
          Open child settings
        </button>
        <button
          onClick={() =>
            host.navigate({ ...host.location, projectId: 'other-project', issueId: 'other-issue' })
          }
        >
          Open another project Issue
        </button>
      </>
    ),
  }
})

vi.mock('./StandInPopover', () => ({
  StandInPopover: ({
    onOpenPersonalSettings,
  }: {
    onOpenPersonalSettings(roleId: string, deviceId: string): void
  }) => <button onClick={() => onOpenPersonalSettings('role', 'device')}>Personal settings</button>,
}))

vi.mock('./StandInSettingsPage', () => ({
  StandInSettingsPage: ({ onCancel }: { onCancel(): void }) => (
    <>
      <input data-testid="personal-prompt" defaultValue="Keep personal settings" />
      <button onClick={() => onCancel()}>Return to project</button>
    </>
  ),
}))

function project(id = 'project', name = 'Current project'): CollaborationProject {
  return { id, name, project_store: 'backend', workspace_id: 'workspace' } as CollaborationProject
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function setup() {
  const first = deferred<CollaborationProject>()
  const latest = deferred<CollaborationProject>()
  const getProject = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(latest.promise)
    .mockImplementation((id: string) => Promise.resolve(project(id)))
  const services = { sharedWorkspaceApi: { projects: { get: getProject } } }
  const onActiveProjectChange = vi.fn()
  const onOpenSettings = vi.fn()
  function ControlledWorkbench() {
    const [activeProjectRef, setActiveProjectRef] = useState<RuntimeProjectSpaceRef | null>(null)
    const selectProject = useCallback(
      (
        value: Parameters<
          NonNullable<ComponentProps<typeof WeworkCollaborationPlatform>['onActiveProjectChange']>
        >[0]
      ) => {
        onActiveProjectChange(value)
        setActiveProjectRef(
          value
            ? {
                projectId: String(value.id),
                projectStore: value.project_store === 'local' ? 'local' : 'backend',
              }
            : null
        )
      },
      []
    )
    return (
      <WeworkCollaborationPlatform
        user={{ id: 1, user_name: 'admin', email: 'admin@example.com' } as never}
        localProjects={[]}
        services={services as never}
        activeProjectRef={activeProjectRef}
        onActiveProjectChange={selectProject}
        onOpenSettings={onOpenSettings}
      />
    )
  }
  render(<ControlledWorkbench />)
  act(() => screen.getByText('Open project').click())
  expect(getProject).toHaveBeenCalledTimes(1)
  return { first, latest, getProject, onActiveProjectChange, onOpenSettings }
}

function location(): CollaborationPlatformLocation {
  return JSON.parse(screen.getByTestId('navigation-location').textContent!)
}

describe('collaboration navigation ownership', () => {
  it.each(['resolve', 'reject'] as const)(
    'keeps personal settings after an older project lookup %s',
    async outcome => {
      const { first, onActiveProjectChange } = setup()
      act(() => screen.getByText('Personal settings').click())
      expect(screen.getByTestId('personal-prompt')).toHaveValue('Keep personal settings')
      expect(onActiveProjectChange.mock.calls).toEqual([[null]])
      await act(async () => {
        if (outcome === 'resolve') first.resolve(project('project', 'Stale project'))
        else first.reject(new Error('Old lookup failed'))
      })
      expect(onActiveProjectChange.mock.calls).toEqual([[null]])
      expect(location()).toMatchObject({ rootView: 'stand-in', projectId: null })
      expect(screen.getByTestId('personal-prompt')).toHaveValue('Keep personal settings')
    }
  )

  it('returns to the known project without accepting its older lookup', async () => {
    const { first, onActiveProjectChange } = setup()
    act(() => screen.getByText('Personal settings').click())
    act(() => screen.getByText('Return to project').click())
    expect(onActiveProjectChange.mock.calls).toEqual([
      [null],
      [expect.objectContaining({ name: 'Current project' })],
    ])
    await act(async () => first.resolve(project('project', 'Stale project')))
    expect(onActiveProjectChange).toHaveBeenCalledTimes(2)
    expect(location()).toMatchObject({ projectId: 'project', projectView: 'board' })
  })

  it('keeps resource navigation after an older project lookup completes', async () => {
    const { first, onActiveProjectChange } = setup()
    act(() => screen.getByText('Manage agents').click())
    await act(async () => first.resolve(project('project', 'Stale project')))
    expect(onActiveProjectChange.mock.calls).toEqual([[null]])
    expect(location()).toMatchObject({ workspaceView: 'agents', projectId: null })
  })

  it.each([
    ['Open child Issue', { projectView: 'board', issueId: 'latest-issue' }],
    [
      'Open child settings',
      { projectView: 'manage', projectSettingsSection: 'agents', issueId: null },
    ],
  ] as const)(
    'reuses rendered project metadata without a lookup for %s',
    async (action, expected) => {
      const { first, onActiveProjectChange, getProject } = setup()
      act(() => screen.getByText(action).click())
      expect(onActiveProjectChange.mock.calls).toEqual([
        [expect.objectContaining({ name: 'Current project', location: 'cloud' })],
      ])
      expect(location()).toMatchObject({
        collaborationDomain: 'cloud',
        projectId: 'project',
        ...expected,
      })
      await act(async () => first.resolve(project('project', 'Stale project')))
      expect(onActiveProjectChange).toHaveBeenCalledTimes(1)
      expect(getProject).toHaveBeenCalledTimes(1)
      expect(location()).toMatchObject({
        collaborationDomain: 'cloud',
        projectId: 'project',
        ...expected,
      })
    }
  )

  it('resolves a different child project before synchronizing its latest navigation', async () => {
    const { first, latest, onActiveProjectChange, getProject } = setup()
    act(() => screen.getByText('Open another project Issue').click())
    expect(getProject).toHaveBeenCalledTimes(2)
    expect(getProject).toHaveBeenLastCalledWith('other-project')
    await act(async () => first.resolve(project('project', 'Stale project')))
    expect(onActiveProjectChange).not.toHaveBeenCalled()
    expect(location()).toMatchObject({ projectId: 'other-project', issueId: 'other-issue' })
    await act(async () => latest.resolve(project('other-project', 'Latest project')))
    expect(onActiveProjectChange.mock.calls).toEqual([
      [expect.objectContaining({ id: 'other-project', name: 'Latest project', location: 'cloud' })],
    ])
    expect(location()).toMatchObject({ projectId: 'other-project', issueId: 'other-issue' })
  })

  it('keeps project navigation pending when only native environment settings open', async () => {
    const { first, onActiveProjectChange, onOpenSettings } = setup()
    act(() => screen.getByText('Manage environments').click())
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    await act(async () => first.resolve(project()))
    expect(onActiveProjectChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project', location: 'cloud' })
    )
    expect(location()).toMatchObject({ projectId: 'project', projectView: 'board' })
  })
})
