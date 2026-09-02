import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectWorkControls } from '@/components/chat/ChatInput'
import type { ProjectWithTasks } from '@/types/api'
import { ConnectedIssueProjectWork } from './ConnectedIssueProjectWork'

const mocks = vi.hoisted(() => ({
  globalSelectProject: vi.fn(),
  globalSelectProjectWorkspace: vi.fn(),
  gitPluginInstalled: true,
}))

vi.mock('@/features/dsh-runtime/gitPlugin', () => ({
  useGitPluginInstalled: () => mocks.gitPluginInstalled,
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
    onSelectProject: mocks.globalSelectProject,
    onSelectStandaloneDevice: vi.fn(),
    onSelectProjectWorkspace: mocks.globalSelectProjectWorkspace,
    onExecutionModeChange: vi.fn(),
    isGitProject: true,
  }),
}))

vi.mock('@/components/layout/useWorkbenchPaneEnvironment', () => ({
  useWorkbenchPaneEnvironment: ({ projectWork }: { projectWork: ProjectWorkControls }) => ({
    projectWork,
  }),
}))

describe('ConnectedIssueProjectWork', () => {
  beforeEach(() => {
    mocks.gitPluginInstalled = true
  })

  it('keeps project workspace selection inside the Issue composer', async () => {
    const project: ProjectWithTasks = { id: 92, name: '研发工作区', tasks: [] }
    const onSelectProject = vi.fn()
    const onSelectProjectWorkspace = vi.fn()

    render(
      <ConnectedIssueProjectWork
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

  it('does not classify the project as Git when the Git plugin is unavailable', () => {
    mocks.gitPluginInstalled = false
    const project: ProjectWithTasks = { id: 92, name: '研发工作区', tasks: [] }

    render(
      <ConnectedIssueProjectWork
        project={project}
        selectedDeviceWorkspaceId={202}
        onSelectProject={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
      >
        {projectWork => <span data-testid="git-project">{String(projectWork.isGitProject)}</span>}
      </ConnectedIssueProjectWork>
    )

    expect(screen.getByTestId('git-project')).toHaveTextContent('false')
  })
})
