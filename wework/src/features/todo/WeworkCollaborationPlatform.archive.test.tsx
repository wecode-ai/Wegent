import { act, render, waitFor } from '@testing-library/react'
import type {
  CollaborationApp,
  CollaborationIssue,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import { createElement, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeworkSharedProject } from './WeworkCollaborationPlatform'
import type { TodoEditor } from './TodoEditor'

const app = vi.hoisted(() => ({
  props: null as ComponentProps<typeof CollaborationApp> | null,
}))

vi.mock('@wegent/collaboration', async importOriginal => ({
  ...(await importOriginal<typeof import('@wegent/collaboration')>()),
  CollaborationApp: (props: ComponentProps<typeof CollaborationApp>) => {
    app.props = props
    return null
  },
}))

afterEach(() => {
  app.props = null
  localStorage.clear()
})

const issue = { id: 'issue-1' } as CollaborationIssue

async function renderProject(projectStore: 'local' | 'backend') {
  const listBindings = vi.fn().mockResolvedValue([
    { deviceId: 'device-1', taskId: 'running-task' },
    { deviceId: 'device-1', taskId: 'completed-task' },
  ])
  const cancelRuntimeTask = vi.fn().mockResolvedValue(undefined)
  const project = {
    id: 'project-1',
    name: 'Project',
    project_store: projectStore,
    current_user_id: 7,
  }
  await act(async () => {
    render(
      createElement(WeworkSharedProject, {
        onOpenGroupThread: vi.fn(),
        draftAccountScope: 'fixture:user-7',
        api: {
          projects: { list: vi.fn().mockResolvedValue([project]) },
          issues: {},
          taskBindings: { list: listBindings },
        } as unknown as SharedWorkspaceApi,
        localProjects: [],
        locale: 'en',
        location: {
          platformView: 'project',
          workspaceId: 'workspace-1',
          workspaceView: 'projects',
          projectId: project.id,
          projectView: 'board',
          issueId: issue.id,
        },
        onCancelRuntimeTask: cancelRuntimeTask,
        project: project as never,
        runtimeWork: {
          projects: [
            {
              project: { id: 1, key: 'runtime', name: 'Runtime' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  workspacePath: '/workspace/project',
                  available: true,
                  tasks: [
                    {
                      taskId: 'running-task',
                      title: 'Running task',
                      workspacePath: '/workspace/project',
                      runtime: 'codex',
                      running: true,
                    },
                    {
                      taskId: 'completed-task',
                      title: 'Completed task',
                      workspacePath: '/workspace/project',
                      runtime: 'codex',
                      running: false,
                    },
                  ],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 2,
        },
        services: {} as never,
        setLocation: vi.fn(),
        userId: 7,
        workspace: { id: 'workspace-1', name: 'Workspace' } as never,
      })
    )
  })
  return { cancelRuntimeTask, listBindings }
}

describe('Issue archive execution ownership', () => {
  it.each(['local', 'backend'] as const)(
    'separates %s participation identity from existing detail authorization',
    async store => {
      await renderProject(store)
      const handlingUserId = store === 'local' ? 0 : 7
      expect(app.props!.participationUserId).toBe(handlingUserId)
      expect(app.props!.initialProject!.current_user_id).toBe(7)
      const detail = app.props!.renderIssueDetail!({
        api: {} as SharedWorkspaceApi,
        issue,
        allIssues: [issue],
        assignments: [],
        taskBindings: [],
        onRead: vi.fn(),
        onChange: vi.fn(),
        onClose: vi.fn(),
      } as never) as {
        props: { children(close: () => void): { props: ComponentProps<typeof TodoEditor> } }
      }
      expect(detail.props.children(vi.fn()).props.currentUserId).toBe(7)
    }
  )

  it('shares the already loaded live running state with the project quick filter', async () => {
    const { listBindings } = await renderProject('local')
    const running = app.props!.isIssueRunning!
    expect(running(issue, [{ deviceId: 'device-1', taskId: 'running-task' }] as never)).toBe(true)
    expect(running(issue, [{ deviceId: 'device-1', taskId: 'completed-task' }] as never)).toBe(
      false
    )
    expect(running(issue, [])).toBe(false)
    expect(listBindings).not.toHaveBeenCalled()
  })

  it('leaves cloud cancellation to the Backend archive transaction', async () => {
    const { cancelRuntimeTask, listBindings } = await renderProject('backend')

    expect(app.props).not.toBeNull()
    expect(app.props!.onPrepareIssueArchive).toBeUndefined()
    expect(listBindings).not.toHaveBeenCalled()
    expect(cancelRuntimeTask).not.toHaveBeenCalled()
  })

  it('waits for the local running Runtime to stop before allowing archive', async () => {
    const { cancelRuntimeTask, listBindings } = await renderProject('local')
    let acknowledgeStop!: () => void
    cancelRuntimeTask.mockReturnValueOnce(
      new Promise<void>(resolve => {
        acknowledgeStop = resolve
      })
    )
    let prepared = false
    const preparation = app.props!.onPrepareIssueArchive!(issue).then(() => {
      prepared = true
    })

    await waitFor(() => expect(cancelRuntimeTask).toHaveBeenCalledTimes(1))
    expect(listBindings).toHaveBeenCalledExactlyOnceWith(issue.id)
    expect(cancelRuntimeTask).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'device-1',
      taskId: 'running-task',
    })
    expect(prepared).toBe(false)
    acknowledgeStop()
    await preparation
    expect(prepared).toBe(true)
  })

  it('preserves the local stop failure instead of continuing archive', async () => {
    const { cancelRuntimeTask } = await renderProject('local')
    cancelRuntimeTask.mockRejectedValueOnce(new Error('Stop acknowledgement missing'))

    await expect(app.props!.onPrepareIssueArchive!(issue)).rejects.toThrow(
      'Stop acknowledgement missing'
    )
  })

  it('preserves binding access denial without issuing a Runtime cancellation', async () => {
    const { cancelRuntimeTask, listBindings } = await renderProject('local')
    listBindings.mockRejectedValueOnce(new Error('Issue not accessible'))

    await expect(app.props!.onPrepareIssueArchive!(issue)).rejects.toThrow('Issue not accessible')
    expect(cancelRuntimeTask).not.toHaveBeenCalled()
  })
})
