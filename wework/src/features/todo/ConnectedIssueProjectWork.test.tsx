import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectWorkControls } from '@/components/chat/ChatInput'
import type { ProjectWithTasks } from '@/types/api'
import { ConnectedIssueProjectWork } from './ConnectedIssueProjectWork'

const mocks = vi.hoisted(() => ({
  globalSelectProject: vi.fn(),
  globalSelectProjectWorkspace: vi.fn(),
  globalBindProjectWorkspace: vi.fn(),
  requestProjectCreateMode: vi.fn(),
  environmentProjectWork: null as ProjectWorkControls | null,
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    state: {
      projects: [{ id: 92, name: '研发工作区', tasks: [] }],
      runtimeWork: null,
    },
  }),
}))

vi.mock('@/components/layout/useWorkbenchProjectWorkControls', () => ({
  useWorkbenchProjectWorkControls: () => ({
    projects: [{ id: 92, name: '研发工作区', tasks: [] }],
    devices: [],
    currentProject: null,
    selectedDeviceWorkspaceId: 77,
    pendingProjectWorkspaceProjectId: 92,
    executionMode: 'current_workspace',
    worktreeBranch: 'global/branch',
    onSelectProject: mocks.globalSelectProject,
    onSelectStandaloneDevice: vi.fn(),
    onSelectProjectWorkspace: mocks.globalSelectProjectWorkspace,
    onBindProjectWorkspace: mocks.globalBindProjectWorkspace,
    onExecutionModeChange: vi.fn(),
  }),
}))

vi.mock('@/components/layout/useWorkbenchPaneEnvironment', () => ({
  useWorkbenchPaneEnvironment: ({ projectWork }: { projectWork: ProjectWorkControls }) => ({
    projectWork: (mocks.environmentProjectWork = projectWork),
  }),
}))

vi.mock('@/components/layout/workbenchShellEvents', () => ({
  requestProjectCreateMode: mocks.requestProjectCreateMode,
}))

describe('ConnectedIssueProjectWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.environmentProjectWork = null
  })

  it('keeps an unbound project selected when opening workspace binding', async () => {
    const onSelectProject = vi.fn()

    render(
      <ConnectedIssueProjectWork
        projects={[{ id: 92, name: '研发工作区', tasks: [] }]}
        project={null}
        selectedDeviceWorkspaceId={null}
        onSelectProject={onSelectProject}
        onSelectProjectWorkspace={vi.fn()}
      >
        {projectWork => (
          <button type="button" onClick={() => projectWork.onBindProjectWorkspace?.(92)}>
            bind project workspace
          </button>
        )}
      </ConnectedIssueProjectWork>
    )

    await userEvent.click(screen.getByText('bind project workspace'))

    expect(onSelectProject).toHaveBeenCalledWith(92)
    expect(mocks.globalBindProjectWorkspace).toHaveBeenCalledWith(92)
    expect(onSelectProject.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.globalBindProjectWorkspace.mock.invocationCallOrder[0]
    )
    expect(mocks.globalSelectProject).not.toHaveBeenCalled()
  })

  it('keeps project workspace selection inside the Issue composer', async () => {
    const project: ProjectWithTasks = { id: 92, name: '研发工作区', tasks: [] }
    const onSelectProject = vi.fn()
    const onSelectProjectWorkspace = vi.fn()

    render(
      <ConnectedIssueProjectWork
        projects={[project]}
        project={project}
        selectedDeviceWorkspaceId={202}
        onSelectProject={onSelectProject}
        onSelectProjectWorkspace={onSelectProjectWorkspace}
      >
        {projectWork => (
          <>
            <span data-testid="selected-workspace">
              {projectWork.selectedDeviceWorkspaceId ?? 'none'}
            </span>
            <span data-testid="pending-project">
              {projectWork.pendingProjectWorkspaceProjectId ?? 'none'}
            </span>
            <button type="button" onClick={() => projectWork.onSelectProjectWorkspace?.(92, 203)}>
              select local workspace
            </button>
          </>
        )}
      </ConnectedIssueProjectWork>
    )

    expect(screen.getByTestId('selected-workspace')).toHaveTextContent('202')
    expect(screen.getByTestId('pending-project')).toHaveTextContent('none')

    await userEvent.click(screen.getByText('select local workspace'))
    expect(onSelectProjectWorkspace).toHaveBeenCalledWith(92, 203)
    expect(mocks.globalSelectProjectWorkspace).not.toHaveBeenCalled()
    expect(mocks.globalSelectProject).not.toHaveBeenCalled()
  })

  it('uses the Issue project list and creates new projects without leaving the surface', async () => {
    const projects: ProjectWithTasks[] = [
      { id: 91, name: '运营工作区', tasks: [] },
      { id: 92, name: '研发工作区', tasks: [] },
    ]
    const onSelectProject = vi.fn()

    render(
      <ConnectedIssueProjectWork
        projects={projects}
        project={projects[0]}
        selectedDeviceWorkspaceId={null}
        onSelectProject={onSelectProject}
        onSelectProjectWorkspace={vi.fn()}
      >
        {projectWork => (
          <>
            <span data-testid="project-options">
              {projectWork.projects.map(project => project.name).join(',')}
            </span>
            <button type="button" onClick={() => projectWork.onCreateProjectMode?.('existing')}>
              add local project
            </button>
          </>
        )}
      </ConnectedIssueProjectWork>
    )

    expect(screen.getByTestId('project-options')).toHaveTextContent('运营工作区,研发工作区')
    await userEvent.click(screen.getByText('add local project'))

    expect(mocks.requestProjectCreateMode).toHaveBeenCalledWith(
      'existing',
      expect.objectContaining({ preserveCurrentSurface: true })
    )
    const options = mocks.requestProjectCreateMode.mock.calls[0]?.[1]
    options?.onCreated?.({ id: 93, name: '新项目', tasks: [] })
    expect(onSelectProject).toHaveBeenCalledWith(93)
  })

  it('preserves an opaque execution strategy selected by the caller', () => {
    const project: ProjectWithTasks = { id: 92, name: '研发工作区', tasks: [] }

    render(
      <ConnectedIssueProjectWork
        projects={[project]}
        project={project}
        selectedDeviceWorkspaceId={202}
        executionMode="plugin-owned-strategy"
        onSelectProject={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
      >
        {projectWork => <span data-testid="execution-strategy">{projectWork.executionMode}</span>}
      </ConnectedIssueProjectWork>
    )

    expect(screen.getByTestId('execution-strategy')).toHaveTextContent('plugin-owned-strategy')
  })

  it('allows the Issue composer to clear a previously selected global worktree branch', () => {
    const project: ProjectWithTasks = { id: 92, name: '研发工作区', tasks: [] }

    render(
      <ConnectedIssueProjectWork
        projects={[project]}
        project={project}
        selectedDeviceWorkspaceId={202}
        worktreeBranch={null}
        onSelectProject={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
      >
        {projectWork => (
          <span data-testid="worktree-branch">{projectWork.worktreeBranch ?? 'none'}</span>
        )}
      </ConnectedIssueProjectWork>
    )

    expect(screen.getByTestId('worktree-branch')).toHaveTextContent('none')
    expect(mocks.environmentProjectWork?.worktreeBranch).toBeNull()
  })
})
