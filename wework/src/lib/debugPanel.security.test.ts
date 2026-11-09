import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import { EMPTY_CLOUD_WORK_STATUS } from '@/features/workbench/workbenchCloudStatus'
import { initialWorkbenchState } from '@/features/workbench/workbenchReducer'
import { describe, expect, it } from 'vitest'
import {
  getWorkbenchDebugSnapshot,
  summarizeMessages,
  updateWorkbenchDebugSnapshot,
} from './debugPanel'
import type { WorkbenchMessage } from '@/types/workbench'

describe('device debug snapshot security', () => {
  it('distinguishes image payload loss without recording file references or generated content', () => {
    const message = {
      id: 'image-message',
      role: 'assistant',
      status: 'done',
      content: '',
      blocks: [
        {
          id: 'image',
          type: 'tool',
          toolName: 'image_generation',
          status: 'done',
          renderPayload: {
            kind: 'image_generation',
            mimeType: 'image/png',
            imageBase64: 'private-image',
            source: {
              type: 'workspace_file',
              deviceId: 'private-device',
              workspacePath: '/private-workspace',
              path: 'private-image.png',
            },
          },
        },
      ],
    } as WorkbenchMessage
    const full = summarizeMessages([message])
    expect(full.lastMessage?.generatedImages).toEqual([
      {
        id: 'image',
        status: 'done',
        hasPayload: true,
        hasWorkspaceSource: true,
        hasInlineData: true,
        hasMimeType: true,
      },
    ])
    expect(JSON.stringify(full)).not.toContain('private-')
    message.blocks![0] = {
      ...message.blocks![0],
      renderPayload: { kind: 'image_generation' },
    } as (typeof message.blocks)[number]
    expect(summarizeMessages([message]).lastMessage?.generatedImages).toEqual([
      {
        id: 'image',
        status: 'done',
        hasPayload: true,
        hasWorkspaceSource: false,
        hasInlineData: false,
        hasMimeType: false,
      },
    ])
  })
  it('exports device diagnostics without raw connection configuration', () => {
    const device = {
      id: 1,
      device_id: 'device-1',
      name: 'Device',
      status: 'online' as const,
      is_default: true,
      cloud_config: { ubuntuInitialPassword: 'secret-cloud-value' },
      remote_config: { password: 'secret-remote-value' },
    }
    updateWorkbenchDebugSnapshot({
      state: { ...initialWorkbenchState, devices: [device] },
      lifecycle: new RuntimeTaskLifecycleStore('device-debug-test').getSnapshot(),
      taskReminders: { unreadCount: 0 },
      cloudWorkStatus: EMPTY_CLOUD_WORK_STATUS,
    })
    const devices = getWorkbenchDebugSnapshot().workbench?.devices
    expect(devices?.[0]).toMatchObject({ device_id: 'device-1', status: 'online' })
    expect(JSON.stringify(devices)).not.toContain('secret-')
    expect(devices?.[0]).not.toHaveProperty('cloud_config')
    expect(devices?.[0]).not.toHaveProperty('remote_config')
  })
})
