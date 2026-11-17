import { describe, expect, it } from 'vitest'

import type { RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/runtime'
import { buildConversationList } from './conversationList'
import { flattenConversations } from './work'

function workspace(
  deviceId: string,
  workspacePath: string,
  taskId: string
): RuntimeDeviceWorkspace {
  return {
    deviceId,
    deviceName: deviceId,
    deviceStatus: 'online',
    available: true,
    workspacePath,
    tasks: [{ taskId, title: taskId, workspacePath, runtime: 'codex' }],
  }
}

function presentation(workspaces: RuntimeDeviceWorkspace[], chats: RuntimeDeviceWorkspace[] = []) {
  const work: RuntimeWorkListResponse = {
    projects: workspaces.map(workspace => ({
      project: { key: workspace.workspacePath, name: 'Wegent', stateDeviceId: workspace.deviceId },
      deviceWorkspaces: [workspace],
    })),
    chats,
    totalTasks: [...workspaces, ...chats].reduce((total, item) => total + item.tasks.length, 0),
  }
  return buildConversationList(
    flattenConversations(work),
    work.projects.flatMap(projectWork =>
      projectWork.deviceWorkspaces.map(workspace => ({
        projectName: projectWork.project.name,
        projectWork,
        workspace,
      }))
    )
  )
}

describe('buildConversationList', () => {
  it('keeps identically named projects separate by device and parent workspace', () => {
    const first = workspace('mac', '/work/one', 'one')
    const second = workspace('mac', '/work/two', 'two')
    const third = workspace('linux', '/work/one', 'three')

    const result = presentation([first, second, third])

    expect(result.projects).toHaveLength(3)
    expect(new Set(result.projects.map(project => project.key)).size).toBe(3)
    expect(result.projects.map(project => project.workspace)).toEqual([first, second, third])
    expect(
      result.projects.map(project => project.conversations.map(item => item.address.taskId))
    ).toEqual([['one'], ['two'], ['three']])
  })

  it('groups a worktree task with its source workspace while retaining its execution address', () => {
    const source = workspace('mac', '/work/Wegent', 'worktree-task')
    source.tasks[0]!.workspacePath = '/work/worktrees/change-1'
    source.tasks[0]!.workspaceKind = 'worktree'
    const result = presentation([source])

    expect(result.projects).toHaveLength(1)
    expect(result.projects[0]!.workspace).toBe(source)
    expect(result.projects[0]!.conversations[0]!.address.workspacePath).toBe(
      '/work/worktrees/change-1'
    )
    expect(result.projects[0]!.conversations[0]!.sourceWorkspacePath).toBe('/work/Wegent')
  })

  it('uses real labels and directory names without inventing worktree identifiers', () => {
    const named = { ...workspace('mac', '/work/Wegent', 'one'), label: 'Release checkout' }
    const windows = workspace('windows', 'C:\\work\\release-branch\\', 'two')
    const ordinary = workspace('linux', '/work/Wegent/', 'three')

    expect(
      presentation([named, windows, ordinary]).projects.map(project => project.detail)
    ).toEqual(['Release checkout', 'release-branch', null])
  })

  it('projects pinned project and chat tasks once using PC pin ordering', () => {
    const project = workspace('mac', '/work/Wegent', 'project-pinned')
    Object.assign(project.tasks[0]!, { pinned: true, pinnedOrder: 2, updatedAt: 10 })
    const chat = workspace('mac', 'chat://mac', 'chat-pinned')
    Object.assign(chat.tasks[0]!, { pinned: true, pinnedOrder: 0, updatedAt: 5 })
    chat.tasks.push(
      {
        taskId: 'newer-pin',
        title: 'newer',
        runtime: 'codex',
        workspacePath: chat.workspacePath,
        pinned: true,
        pinnedOrder: 2,
        updatedAt: 20,
      },
      {
        taskId: 'unordered-pin',
        title: 'unordered',
        runtime: 'codex',
        workspacePath: chat.workspacePath,
        pinned: true,
        updatedAt: 30,
      },
      {
        taskId: 'ordinary',
        title: 'ordinary',
        runtime: 'codex',
        workspacePath: chat.workspacePath,
        updatedAt: 40,
      }
    )
    const result = presentation([project], [chat])

    expect(result.pinned.map(item => item.address.taskId)).toEqual([
      'chat-pinned',
      'newer-pin',
      'project-pinned',
      'unordered-pin',
    ])
    expect(result.projects[0]!.conversations).toEqual([])
    expect(result.standalone.map(item => item.address.taskId)).toEqual(['ordinary'])
  })

  it('retains conversations with a missing workspace without offering another project creation target', () => {
    const source = workspace('mac', '/work/missing', 'existing-task')
    const work = {
      projects: [{ project: { key: 'missing', name: 'Wegent' }, deviceWorkspaces: [source] }],
      chats: [],
      totalTasks: 1,
    }
    const conversations = flattenConversations(work)
    const result = buildConversationList(conversations, [])

    expect(result.projects[0]!.workspace).toBeUndefined()
    expect(result.projects[0]!.conversations).toEqual(conversations)
  })

  it('does not mutate input task order or duplicate a workspace entry', () => {
    const source = workspace('mac', '/work/Wegent', 'first')
    const result = presentation([source, source])
    expect(result.projects).toHaveLength(1)
    expect(source.tasks[0]!.taskId).toBe('first')
  })
})

it('presents a multi-root project once and orders pinned projects before ordinary ones', () => {
  const first = workspace('computer', '/first', 'one')
  const second = workspace('computer', '/second', 'two')
  const ordinary = {
    project: { key: 'ordinary', name: 'Ordinary', stateDeviceId: 'computer' },
    deviceWorkspaces: [workspace('computer', '/ordinary', 'three')],
  }
  const pinned = {
    project: { key: 'multi-root', name: 'Pinned', stateDeviceId: 'computer', pinned: true },
    deviceWorkspaces: [first, second],
  }
  const work = { projects: [ordinary, pinned], chats: [], totalTasks: 3 }
  const result = buildConversationList(
    flattenConversations(work),
    work.projects.flatMap(projectWork =>
      projectWork.deviceWorkspaces.map(workspace => ({
        projectWork,
        projectName: projectWork.project.name,
        workspace,
      }))
    )
  )
  expect(result.projects.map(group => group.name)).toEqual(['Ordinary'])
  expect(result.pinnedProjects.map(group => group.name)).toEqual(['Pinned'])
  expect(result.pinnedProjects[0]!.conversations.map(item => item.address.taskId)).toEqual([
    'one',
    'two',
  ])
  expect(result.pinnedProjects[0]!.projectWork).toBe(pinned)
})

it('keeps two projects sharing a directory and name distinct by project identity', () => {
  const projects = ['first', 'second'].map(key => ({
    project: { key, name: 'Same name', stateDeviceId: 'computer' },
    deviceWorkspaces: [workspace('computer', '/shared', key)],
  }))
  const result = buildConversationList(
    flattenConversations({ projects, chats: [], totalTasks: 2 }),
    projects.map(projectWork => ({
      projectName: projectWork.project.name,
      projectWork,
      workspace: projectWork.deviceWorkspaces[0]!,
    }))
  )
  expect(
    result.projects.map(group => group.conversations.map(item => item.address.taskId))
  ).toEqual([['first'], ['second']])
})
