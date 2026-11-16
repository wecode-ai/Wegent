import { describe, expect, it } from 'vitest'
import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/runtime'
import { resolveMobileWorkspaceFileTarget } from './mobileFileTarget'

const address: RuntimeTaskAddress = {
  deviceId: 'logical-device',
  taskId: 'task',
  workspacePath: '/project',
}
const workspace: RuntimeDeviceWorkspace = {
  deviceId: 'logical-device',
  deviceName: 'Cloud device',
  deviceStatus: 'online',
  available: true,
  workspacePath: '/project',
  tasks: [{ taskId: 'task', title: 'Task', runtime: 'codex', workspacePath: '/project' }],
}
const emptyWork: RuntimeWorkListResponse = { projects: [], chats: [], totalTasks: 0 }
function workFor(value: RuntimeDeviceWorkspace, project = false): RuntimeWorkListResponse {
  return {
    projects: project
      ? [{ project: { key: 'project', name: 'Project' }, deviceWorkspaces: [value] }]
      : [],
    chats: project ? [] : [value],
    totalTasks: value.tasks.length,
  }
}

describe('mobile workspace file targets follow PC cloud-device ownership', () => {
  it.each([false, true])('resolves task paths from %s project scope', project => {
    const value = {
      ...workspace,
      tasks: [{ ...workspace.tasks[0], workspacePath: '/worktrees/task/project' }],
    }
    expect(resolveMobileWorkspaceFileTarget(address, workFor(value, project))).toEqual({
      deviceId: 'logical-device',
      path: '/worktrees/task/project',
      taskId: 'task',
    })
  })

  it('uses the final remote worktree group path even when the task still contains the source path', () => {
    const value = {
      ...workspace,
      workspacePath: '/executor/worktrees/task/project',
      workspaceKind: 'worktree',
      worktreeId: 'task',
      workspaceSource: 'remote',
      remoteHostId: ' runtime-device ',
    }
    expect(resolveMobileWorkspaceFileTarget(address, workFor(value))).toEqual({
      deviceId: 'runtime-device',
      path: value.workspacePath,
      taskId: 'task',
      workspaceSource: 'remote',
    })
  })

  it.each([
    { workspaceKind: 'worktree' },
    { worktreeId: 'task' },
    { workspacePath: '/worktrees/task/project' },
  ])('does not expose a queued independent task path: %j', taskFields => {
    const value = {
      ...workspace,
      tasks: [{ ...workspace.tasks[0], ...taskFields, status: 'queued' }],
    }
    expect(resolveMobileWorkspaceFileTarget(address, workFor(value))).toBeNull()
  })

  it.each([{ workspaceKind: 'worktree' }, { worktreeId: 'task' }])(
    'does not expose a queued independent group path: %j',
    groupFields => {
      const value = {
        ...workspace,
        ...groupFields,
        tasks: [{ ...workspace.tasks[0], status: 'queued' }],
      }
      expect(resolveMobileWorkspaceFileTarget(address, workFor(value))).toBeNull()
    }
  )

  it('keeps an ordinary queued project workspace available', () => {
    const value = { ...workspace, tasks: [{ ...workspace.tasks[0], status: 'queued' }] }
    expect(resolveMobileWorkspaceFileTarget(address, workFor(value))).toEqual({
      deviceId: 'logical-device',
      path: '/project',
      taskId: 'task',
    })
  })

  it.each([{ workspaceKind: 'worktree' }, { worktreeId: 'task' }])(
    'waits for projected worktree ownership instead of reading the provisional path: %j',
    fields => {
      expect(
        resolveMobileWorkspaceFileTarget({ ...address, ...fields }, emptyWork, workspace)
      ).toBeNull()
    }
  )

  it('never takes a matching task ID from another device or workspace', () => {
    const work = workFor({
      ...workspace,
      deviceId: 'other-device',
      remoteHostId: 'wrong-device',
      workspaceSource: 'remote',
    })
    work.chats.push({
      ...workspace,
      workspacePath: '/different',
      tasks: [{ ...workspace.tasks[0], workspacePath: '/different' }],
    })
    expect(resolveMobileWorkspaceFileTarget(address, work, workspace)).toEqual({
      deviceId: 'logical-device',
      path: '/project',
      taskId: 'task',
    })
  })

  it('uses selected workspace ownership only before a conversation is active', () => {
    const selected = { ...workspace, workspaceSource: 'remote', remoteHostId: 'storage-device' }
    expect(resolveMobileWorkspaceFileTarget(null, emptyWork, selected)).toEqual({
      deviceId: 'storage-device',
      path: '/project',
      workspaceSource: 'remote',
    })
    expect(
      resolveMobileWorkspaceFileTarget({ ...address, workspacePath: '/chat' }, emptyWork, selected)
    ).toEqual({
      deviceId: 'logical-device',
      path: '/chat',
      taskId: 'task',
    })
  })

  it('does not use remoteHostId for a local workspace or synthesize missing paths', () => {
    expect(
      resolveMobileWorkspaceFileTarget(null, emptyWork, {
        ...workspace,
        workspaceSource: 'local',
        remoteHostId: 'other',
      })
    ).toEqual({
      deviceId: 'logical-device',
      path: '/project',
      workspaceSource: 'local',
    })
    expect(resolveMobileWorkspaceFileTarget(null, emptyWork)).toBeNull()
    expect(
      resolveMobileWorkspaceFileTarget({ ...address, workspacePath: '' }, emptyWork)
    ).toBeNull()
  })
})
