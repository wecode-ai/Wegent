import { describe, expect, test, vi } from 'vitest'
import type { Attachment, DeviceInfo } from '@/types/api'
import {
  buildRuntimeTaskCreateHandle,
  friendlyTitleForTask,
  loadTemporaryChatSource,
  prepareRuntimeAttachmentsForDevice,
  resolveRuntimeTaskCreateWorkspacePath,
  runtimeExecutablePathForTarget,
  resolveTemporaryChatSource,
  runtimeThreadId,
  titleModelForGeneration,
} from './useWorkbenchRuntimeMessaging'

describe('buildRuntimeTaskCreateHandle', () => {
  test('keeps board ownership in the optimistic runtime address', () => {
    expect(
      buildRuntimeTaskCreateHandle(null, {
        cloudProjectId: 'project-1',
        origin: {
          type: 'board_task',
          cloudProjectId: 'project-1',
          loopItemId: 'ISSUE-1',
          projectStore: 'backend',
        },
      })
    ).toEqual({
      cloudProjectId: 'project-1',
      origin: {
        type: 'board_task',
        cloudProjectId: 'project-1',
        loopItemId: 'ISSUE-1',
        projectStore: 'backend',
      },
    })
  })
})

describe('resolveRuntimeTaskCreateWorkspacePath', () => {
  test('keeps the source path for a current-workspace task without a response path', () => {
    expect(
      resolveRuntimeTaskCreateWorkspacePath({
        sourcePath: '/workspace/project',
        requestedManagedWorkspace: false,
      })
    ).toBe('/workspace/project')
  })

  test('requires the Executor planned path for a managed workspace task', () => {
    expect(() =>
      resolveRuntimeTaskCreateWorkspacePath({
        sourcePath: '/workspace/project',
        requestedManagedWorkspace: true,
      })
    ).toThrow('did not return a planned workspace path')
  })

  test('rejects a managed workspace response that falls back to the base workspace', () => {
    expect(() =>
      resolveRuntimeTaskCreateWorkspacePath({
        sourcePath: '/workspace/project/',
        responsePath: '/workspace/project',
        requestedManagedWorkspace: true,
      })
    ).toThrow('returned the base workspace path')
  })

  test('accepts a distinct planned managed workspace path', () => {
    expect(
      resolveRuntimeTaskCreateWorkspacePath({
        sourcePath: '/workspace/project',
        responsePath: '/executor/worktrees/task-1/project',
        requestedManagedWorkspace: true,
      })
    ).toBe('/executor/worktrees/task-1/project')
  })
})

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: -1,
    filename: 'screenshot.png',
    file_size: 4,
    mime_type: 'image/png',
    status: 'ready',
    file_extension: '.png',
    created_at: '2026-08-11T00:00:00.000Z',
    local_path: '/Users/me/.wework/workspace/attachments/draft/screenshot.png',
    ...overrides,
  }
}

function device(deviceId: string, deviceType: DeviceInfo['device_type']): DeviceInfo {
  return {
    id: 1,
    device_id: deviceId,
    name: deviceId,
    status: 'online',
    is_default: false,
    device_type: deviceType,
  }
}

describe('runtimeThreadId', () => {
  test('uses the direct thread id from a hydrated runtime task address', () => {
    expect(
      runtimeThreadId({
        deviceId: 'local-device',
        taskId: 'task-1',
        threadId: 'thread-1',
        runtimeHandle: { modelSelection: { modelName: 'gpt-5' } },
      })
    ).toBe('thread-1')
  })

  test('falls back to the runtime handle thread id', () => {
    expect(
      runtimeThreadId({
        deviceId: 'local-device',
        taskId: 'task-1',
        runtimeHandle: { threadId: 'thread-from-handle' },
      })
    ).toBe('thread-from-handle')
  })
})

describe('resolveTemporaryChatSource', () => {
  test('hydrates a stale source address from the runtime work list', () => {
    expect(
      resolveTemporaryChatSource(
        {
          deviceId: 'local-device',
          taskId: 'task-1',
          runtimeHandle: { modelSelection: { modelName: 'gpt-5' } },
        },
        {
          projects: [],
          chats: [
            {
              deviceId: 'local-device',
              workspacePath: '/workspace',
              available: true,
              mapped: true,
              tasks: [
                {
                  taskId: 'task-1',
                  threadId: 'thread-1',
                  workspacePath: '/workspace',
                  title: 'Task',
                  runtime: 'codex',
                  runtimeHandle: { threadId: 'thread-1' },
                },
              ],
            },
          ],
          totalTasks: 1,
        }
      )
    ).toEqual({
      deviceId: 'local-device',
      taskId: 'task-1',
      runtime: 'codex',
      threadId: 'thread-1',
      workspacePath: '/workspace',
      runtimeHandle: {
        modelSelection: { modelName: 'gpt-5' },
        threadId: 'thread-1',
      },
    })
  })

  test('loads fresh runtime work when the cached source has no thread id', async () => {
    const listRuntimeWork = vi.fn().mockResolvedValue({
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          workspacePath: '/workspace',
          available: true,
          mapped: true,
          tasks: [
            {
              taskId: 'task-1',
              threadId: 'thread-1',
              workspacePath: '/workspace',
              title: 'Task',
              runtime: 'codex',
            },
          ],
        },
      ],
      totalTasks: 1,
    })

    await expect(
      loadTemporaryChatSource(
        {
          deviceId: 'local-device',
          taskId: 'task-1',
          runtimeHandle: { modelSelection: { modelName: 'gpt-5' } },
        },
        null,
        listRuntimeWork
      )
    ).resolves.toMatchObject({
      deviceId: 'local-device',
      taskId: 'task-1',
      threadId: 'thread-1',
      workspacePath: '/workspace',
    })
    expect(listRuntimeWork).toHaveBeenCalledTimes(1)
  })
})

describe('friendlyTitleForTask', () => {
  const taskExecutionModel = {
    modelId: 'local-model:current',
    modelType: 'runtime' as const,
    modelOptions: { collaborationMode: 'default' },
  }

  test('skips title generation when the previously selected title model is gone', () => {
    expect(
      friendlyTitleForTask(
        {
          friendlyTaskTitlesEnabled: true,
          friendlyTaskTitleModel: {
            modelName: 'local-model:removed',
            modelType: 'runtime',
            executionModelId: 'local-model:removed',
            executionModelType: 'runtime',
          },
        },
        [{ name: 'local-model:current', type: 'runtime' }] as never,
        taskExecutionModel
      )
    ).toBeNull()
  })

  test('uses an available configured title model', () => {
    expect(
      friendlyTitleForTask(
        {
          friendlyTaskTitlesEnabled: true,
          friendlyTaskTitleModel: {
            modelName: 'local-model:title',
            modelType: 'runtime',
            executionModelId: 'local-model:title',
            executionModelType: 'runtime',
            options: { collaborationMode: 'default' },
          },
        },
        [{ name: 'local-model:title', type: 'runtime' }] as never,
        taskExecutionModel
      )
    ).toEqual({
      modelId: 'local-model:title',
      modelType: 'runtime',
      modelOptions: { collaborationMode: 'default' },
    })
  })
})

describe('titleModelForGeneration', () => {
  test('uses the configured title model without requiring automatic task titles to be enabled', () => {
    expect(
      titleModelForGeneration(
        {
          friendlyTaskTitleModel: {
            modelName: 'local-model:title',
            modelType: 'runtime',
            executionModelId: 'local-model:title',
            executionModelType: 'runtime',
          },
        },
        [{ name: 'local-model:title', type: 'runtime' }] as never,
        {
          modelId: 'local-model:task',
          modelType: 'runtime',
          modelOptions: {},
        }
      )
    ).toMatchObject({ modelId: 'local-model:title', modelType: 'runtime' })
  })

  test('uses the current execution model while preferences are still loading', () => {
    expect(
      titleModelForGeneration(undefined, [], {
        modelId: 'gpt-5.6-sol',
        modelType: 'public',
        modelOptions: { reasoning: 'low' },
      })
    ).toEqual({
      modelId: 'gpt-5.6-sol',
      modelType: 'public',
      modelOptions: { reasoning: 'low' },
    })
  })
})

describe('prepareRuntimeAttachmentsForDevice', () => {
  test('keeps local attachments on the local filesystem path', async () => {
    const localAttachment = attachment()

    await expect(
      prepareRuntimeAttachmentsForDevice(
        'local-device',
        [device('local-device', 'local')],
        [],
        [localAttachment]
      )
    ).resolves.toEqual({
      attachmentIds: [],
      attachments: [localAttachment],
    })
  })

  test('uploads local attachments before sending to a cloud device', async () => {
    const localAttachment = attachment()
    const uploadedAttachment = attachment({ id: 42, local_path: undefined })
    const existingAttachment = attachment({
      id: 8,
      local_path: '/cloud/attachment.png',
      local_preview_url: '/cloud/attachment.png',
    })
    const upload = vi.fn().mockResolvedValue(uploadedAttachment)

    await expect(
      prepareRuntimeAttachmentsForDevice(
        'cloud-device',
        [device('cloud-device', 'cloud')],
        [7],
        [localAttachment, existingAttachment],
        upload
      )
    ).resolves.toEqual({
      attachmentIds: [7, 8, 42],
      attachments: [
        attachment({
          id: 8,
          local_path: undefined,
          local_preview_url: undefined,
        }),
        uploadedAttachment,
      ],
    })
    expect(upload).toHaveBeenCalledWith(localAttachment)
  })

  test('reuses positive backend attachment ids even when transcript metadata has a path', async () => {
    const upload = vi.fn()

    await expect(
      prepareRuntimeAttachmentsForDevice(
        'cloud-device',
        [device('cloud-device', 'cloud')],
        [],
        [attachment({ id: 21, local_path: '/cloud/runtime/attachment.png' })],
        upload
      )
    ).resolves.toEqual({
      attachmentIds: [21],
      attachments: [attachment({ id: 21, local_path: undefined })],
    })
    expect(upload).not.toHaveBeenCalled()
  })

  test('blocks cloud sending when local attachment upload is unavailable', async () => {
    await expect(
      prepareRuntimeAttachmentsForDevice(
        'cloud-device',
        [device('cloud-device', 'cloud')],
        [],
        [attachment()]
      )
    ).rejects.toThrow('当前无法将本地附件上传到云设备')
  })
})

describe('runtimeExecutablePathForTarget', () => {
  test('keeps a configured executable for a local executor', () => {
    expect(
      runtimeExecutablePathForTarget({
        executablePath: '/tmp/claude',
        targetDevice: {
          device_id: 'local-device',
          device_type: 'local',
          status: 'online',
        },
        workspaceSource: 'local',
      })
    ).toBe('/tmp/claude')
  })

  test('keeps a configured executable while local device discovery is pending', () => {
    expect(
      runtimeExecutablePathForTarget({
        executablePath: '/tmp/claude',
        targetDevice: null,
      })
    ).toBe('/tmp/claude')
  })

  test('removes a local executable path for a remote workspace', () => {
    expect(
      runtimeExecutablePathForTarget({
        executablePath: '/tmp/claude',
        targetDevice: null,
        workspaceSource: 'remote',
      })
    ).toBeUndefined()
  })

  test.each(['cloud', 'remote'] as const)(
    'removes a local executable path for a %s executor',
    deviceType => {
      expect(
        runtimeExecutablePathForTarget({
          executablePath: '/tmp/claude',
          targetDevice: {
            device_id: 'remote-device',
            device_type: deviceType,
            status: 'online',
          },
        })
      ).toBeUndefined()
    }
  )

  test('prefers an explicit remote executor over stale local workspace metadata', () => {
    expect(
      runtimeExecutablePathForTarget({
        executablePath: '/tmp/claude',
        targetDevice: {
          device_id: 'remote-device',
          device_type: 'cloud',
          status: 'online',
        },
        workspaceSource: 'local',
      })
    ).toBeUndefined()
  })

  test('keeps a configured executable for the local app executor', () => {
    expect(
      runtimeExecutablePathForTarget({
        executablePath: '/tmp/claude',
        targetDevice: {
          device_id: 'app-device',
          device_type: 'app',
          status: 'online',
        },
      })
    ).toBe('/tmp/claude')
  })
})
