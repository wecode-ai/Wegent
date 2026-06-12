import { describe, expect, test, vi } from 'vitest'
import { createDeviceApi } from './devices'
import type { HttpClient } from './http'

describe('createDeviceApi', () => {
  test('uses cloud device endpoints for restart and delete actions', async () => {
    const client = {
      delete: vi.fn().mockResolvedValue({ message: 'deleted' }),
      post: vi.fn().mockResolvedValue({ message: 'restart sent' }),
    } as unknown as HttpClient

    const api = createDeviceApi(client)

    await api.restartCloudDevice('device/1')
    await api.deleteCloudDevice('device/1')
    await api.deleteDevice('device/1')
    await api.upgradeDevice('device/1', { auto_confirm: true })

    expect(client.post).toHaveBeenCalledWith('/cloud-devices/device%2F1/restart')
    expect(client.delete).toHaveBeenCalledWith('/cloud-devices/device%2F1')
    expect(client.delete).toHaveBeenCalledWith('/devices/device%2F1')
    expect(client.post).toHaveBeenCalledWith(
      '/devices/device%2F1/upgrade',
      { auto_confirm: true },
    )
  })

  test('listWorkspaceEntries maps workspace tree output', async () => {
    const post = vi.fn().mockResolvedValue({
      success: true,
      stdout: {
        path: '/workspace/project',
        entries: [
          {
            name: 'src',
            path: '/workspace/project/src',
            is_directory: true,
            size: 0,
            modified_at: '2026-06-12T00:00:00+00:00',
          },
        ],
      },
      stderr: '',
    })
    const api = createDeviceApi({ post } as never)

    await expect(api.listWorkspaceEntries('device-a', '/workspace/project')).resolves.toEqual({
      path: '/workspace/project',
      entries: [
        {
          name: 'src',
          path: '/workspace/project/src',
          isDirectory: true,
          size: 0,
          modifiedAt: '2026-06-12T00:00:00+00:00',
        },
      ],
    })
    expect(post).toHaveBeenCalledWith('/devices/device-a/commands', {
      command_key: 'workspace_tree',
      path: '/workspace/project',
      timeout_seconds: 15,
      max_output_bytes: 1024 * 512,
    })
  })

  test('listWorkspaceEntries rejects malformed successful workspace tree output', async () => {
    const post = vi.fn().mockResolvedValue({
      success: true,
      stdout: {
        path: '/workspace/project',
        entries: [
          {
            name: 'src',
            path: '/workspace/project/src',
          },
        ],
      },
      stderr: '',
    })
    const api = createDeviceApi({ post } as never)

    await expect(api.listWorkspaceEntries('device-a', '/workspace/project')).rejects.toThrow(
      'Invalid workspace tree response',
    )
  })

  test('readWorkspaceTextFile calls parent path with file name arg', async () => {
    const post = vi.fn().mockResolvedValue({
      success: true,
      stdout: {
        path: '/workspace/project/src/main.ts',
        name: 'main.ts',
        content: 'export {}',
        truncated: false,
        size: 9,
        modified_at: null,
      },
      stderr: '',
    })
    const api = createDeviceApi({ post } as never)

    await expect(
      api.readWorkspaceTextFile('device-a', '/workspace/project/src/main.ts'),
    ).resolves.toMatchObject({
      path: '/workspace/project/src/main.ts',
      name: 'main.ts',
      content: 'export {}',
      truncated: false,
      size: 9,
    })
    expect(post).toHaveBeenCalledWith('/devices/device-a/commands', {
      command_key: 'workspace_read_text_file',
      path: '/workspace/project/src',
      args: ['main.ts'],
      timeout_seconds: 15,
      max_output_bytes: 1024 * 1024 * 2,
    })
  })

  test('readWorkspaceTextFile rejects relative file paths', async () => {
    const post = vi.fn()
    const api = createDeviceApi({ post } as never)

    await expect(api.readWorkspaceTextFile('device-a', 'src/main.ts')).rejects.toThrow(
      'Workspace file path must be absolute',
    )
    expect(post).not.toHaveBeenCalled()
  })

  test('readWorkspaceTextFile rejects malformed successful file output', async () => {
    const post = vi.fn().mockResolvedValue({
      success: true,
      stdout: {
        path: '/workspace/project/src/main.ts',
        name: 'main.ts',
        content: 123,
        truncated: false,
        size: 9,
        modified_at: null,
      },
      stderr: '',
    })
    const api = createDeviceApi({ post } as never)

    await expect(
      api.readWorkspaceTextFile('device-a', '/workspace/project/src/main.ts'),
    ).rejects.toThrow('Invalid workspace text file response')
  })
})
