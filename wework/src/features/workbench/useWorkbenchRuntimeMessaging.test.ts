import { describe, expect, test, vi } from 'vitest'
import type { Attachment, DeviceInfo } from '@/types/api'
import {
  friendlyTitleForTask,
  prepareRuntimeAttachmentsForDevice,
  runtimeThreadId,
} from './useWorkbenchRuntimeMessaging'

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
