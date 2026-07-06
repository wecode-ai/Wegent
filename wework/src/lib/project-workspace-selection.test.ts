import { describe, expect, test } from 'vitest'
import {
  buildProjectWorkspaceOptions,
  isSelectableProjectWorkspace,
} from './project-workspace-selection'
import type { DeviceInfo, ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'

const projects: ProjectWithTasks[] = [
  { id: 7, name: 'Wegent', tasks: [] },
  { id: 8, name: 'Docs', tasks: [] },
  { id: 9, name: 'Empty', tasks: [] },
]

const devices: DeviceInfo[] = [
  {
    id: 1,
    device_id: 'device-1',
    name: 'MacBook Pro',
    status: 'online',
    is_default: true,
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
  },
  {
    id: 2,
    device_id: 'device-2',
    name: 'Cloud Devbox',
    status: 'offline',
    is_default: false,
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
  },
]

const runtimeWork: RuntimeWorkListResponse = {
  projects: [
    {
      project: { id: 7, name: 'Wegent' },
      deviceWorkspaces: [
        {
          id: 101,
          projectId: 7,
          deviceId: 'device-1',
          deviceName: 'MacBook Pro',
          deviceStatus: 'online',
          available: true,
          workspacePath: '/repo/Wegent',
          mapped: true,
          tasks: [],
        },
        {
          id: 102,
          projectId: 7,
          deviceId: 'device-2',
          deviceName: 'Cloud Devbox',
          deviceStatus: 'offline',
          available: false,
          workspacePath: '/workspace/Wegent',
          mapped: true,
          tasks: [],
          error: 'Device is offline',
        },
      ],
    },
    {
      project: { id: 8, name: 'Docs' },
      deviceWorkspaces: [
        {
          id: 201,
          projectId: 8,
          deviceId: 'device-1',
          deviceName: 'MacBook Pro',
          deviceStatus: 'online',
          available: true,
          workspacePath: '/repo/Docs',
          mapped: true,
          tasks: [],
        },
      ],
    },
  ],
  chats: [],
  totalTasks: 0,
}

describe('project workspace selection', () => {
  test('marks single workspace projects as directly selectable', () => {
    const options = buildProjectWorkspaceOptions({ projects, devices, runtimeWork })

    expect(options.find(option => option.project.id === 8)).toMatchObject({
      kind: 'single',
      selectable: true,
      workspace: {
        id: 201,
        deviceId: 'device-1',
      },
    })
  })

  test('marks multi workspace projects as requiring explicit workspace selection', () => {
    const options = buildProjectWorkspaceOptions({ projects, devices, runtimeWork })

    const option = options.find(item => item.project.id === 7)
    expect(option).toMatchObject({
      kind: 'multi',
      selectable: false,
    })
    expect(option?.workspaces.map(workspace => workspace.id)).toEqual([101, 102])
    expect(isSelectableProjectWorkspace(option?.workspaces[0])).toBe(true)
    expect(isSelectableProjectWorkspace(option?.workspaces[1])).toBe(false)
  })

  test('marks projects with no workspace as bind-required', () => {
    const options = buildProjectWorkspaceOptions({ projects, devices, runtimeWork })

    expect(options.find(option => option.project.id === 9)).toMatchObject({
      kind: 'empty',
      selectable: false,
      workspaces: [],
    })
  })

  test('allows runtime-native workspaces without central mapping ids', () => {
    const options = buildProjectWorkspaceOptions({
      projects: [{ id: 10, name: 'runtime-only', tasks: [] }],
      devices,
      runtimeWork: {
        projects: [
          {
            project: { id: 10, name: 'runtime-only' },
            deviceWorkspaces: [
              {
                projectId: null,
                deviceId: 'device-1',
                deviceName: 'MacBook Pro',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/runtime-only',
                mapped: true,
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
    })

    expect(options[0]).toMatchObject({
      kind: 'single',
      selectable: true,
      workspace: {
        deviceId: 'device-1',
        workspacePath: '/repo/runtime-only',
      },
    })
  })
})
