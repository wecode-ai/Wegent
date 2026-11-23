import { expect, it, vi } from 'vitest'
import { createWorkbenchPaneEnvironmentSource } from './workbenchPaneEnvironmentSource'

it('keeps environment reads independent of project task updates', async () => {
  const loadEnvironmentInfo = vi.fn(async () => ({
    additions: '',
    deletions: '',
    executionTarget: 'local' as const,
  }))
  const target = { deviceId: 'local', path: '/workspace', source: 'project' as const }
  const input = {
    workspaceProject: { id: 1, name: 'Project' },
    runtimeWorkspaceTarget: null,
    projectRuntimeWorkspaceTarget: target,
    currentRuntimeTask: null,
    getProjectWorkspaceRoot: async () => '/workspace',
    loadEnvironmentInfo,
    apiOwner: null,
    devices: [],
    workspaceRoots: [target.path],
    autoLoad: true,
  }
  const source = createWorkbenchPaneEnvironmentSource(input)
  const listen = vi.fn()
  const release = source.subscribe(listen, input, false)
  await vi.waitFor(() => expect(source.getSnapshot().environmentInfo.loading).toBe(false))
  release()

  const releaseUpdatedProject = source.subscribe(
    listen,
    {
      ...input,
      workspaceProject: {
        ...input.workspaceProject,
        tasks: [{ id: 1, task_id: 1, status: 'running' }],
      },
    },
    false
  )
  expect(loadEnvironmentInfo).toHaveBeenCalledTimes(1)
  releaseUpdatedProject()

  const releaseUpdatedRoots = source.subscribe(
    listen,
    { ...input, workspaceRoots: [target.path, '/another-root'] },
    false
  )
  await vi.waitFor(() =>
    expect(source.getSnapshot().environmentInfo.workspaceRoots).toEqual([
      target.path,
      '/another-root',
    ])
  )
  expect(loadEnvironmentInfo).toHaveBeenCalledTimes(2)
  releaseUpdatedRoots()
})
