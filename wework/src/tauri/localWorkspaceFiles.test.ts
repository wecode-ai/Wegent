import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { requestLocalExecutor } from './localExecutor'
import {
  listLocalWorkspaceEntries,
  readLocalWorkspaceFileChunk,
  readLocalWorkspaceTextFile,
} from './localWorkspaceFiles'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: vi.fn(),
}))

vi.mock('./localExecutor', () => ({
  requestLocalExecutor: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)
const isElectronRuntimeMock = vi.mocked(isElectronRuntime)
const requestLocalExecutorMock = vi.mocked(requestLocalExecutor)

describe('localWorkspaceFiles', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isElectronRuntimeMock.mockReset()
    requestLocalExecutorMock.mockReset()
  })

  test('lists workspace entries through the Electron-managed executor', async () => {
    isElectronRuntimeMock.mockReturnValue(true)
    requestLocalExecutorMock.mockResolvedValue({
      success: true,
      stdout: {
        path: '/workspace/project',
        entries: [
          {
            name: 'src',
            path: '/workspace/project/src',
            is_directory: true,
            size: 0,
            modified_at: null,
          },
        ],
      },
      stderr: '',
    })

    await expect(
      listLocalWorkspaceEntries('/workspace/project', '/workspace/project')
    ).resolves.toEqual({
      path: '/workspace/project',
      entries: [
        {
          name: 'src',
          path: '/workspace/project/src',
          isDirectory: true,
          size: 0,
          modifiedAt: null,
        },
      ],
    })
    expect(requestLocalExecutorMock).toHaveBeenCalledWith('device.execute_command', {
      command_key: 'workspace_tree',
      path: '/workspace/project',
      timeout_seconds: 15,
      max_output_bytes: 1024 * 512,
      env: {
        WEGENT_WORKSPACE_ROOTS: '/workspace/project',
      },
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('reads text and binary chunks through the Electron-managed executor', async () => {
    isElectronRuntimeMock.mockReturnValue(true)
    requestLocalExecutorMock
      .mockResolvedValueOnce({
        success: true,
        stdout: {
          path: '/workspace/project/README.md',
          name: 'README.md',
          content: 'hello',
          editable: true,
          revision: 'sha256:abc',
          truncated: false,
          size: 5,
          modified_at: null,
        },
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: {
          path: '/workspace/project/image.png',
          name: 'image.png',
          content_base64: 'aW1hZ2U=',
          offset: 0,
          eof: true,
          size: 5,
          modified_at: null,
        },
        stderr: '',
      })

    await expect(
      readLocalWorkspaceTextFile('/workspace/project', '/workspace/project/README.md')
    ).resolves.toMatchObject({
      path: '/workspace/project/README.md',
      content: 'hello',
      editable: true,
      revision: 'sha256:abc',
    })
    await expect(
      readLocalWorkspaceFileChunk('/workspace/project', '/workspace/project/image.png', 0)
    ).resolves.toMatchObject({
      path: '/workspace/project/image.png',
      contentBase64: 'aW1hZ2U=',
      offset: 0,
      eof: true,
    })

    expect(requestLocalExecutorMock.mock.calls).toEqual([
      [
        'device.execute_command',
        {
          command_key: 'workspace_read_text_file',
          path: '/workspace/project',
          args: ['README.md'],
          timeout_seconds: 15,
          max_output_bytes: 1024 * 1024 * 2,
          env: {
            WEGENT_WORKSPACE_ROOTS: '/workspace/project',
          },
        },
      ],
      [
        'device.execute_command',
        {
          command_key: 'workspace_read_file_chunk',
          path: '/workspace/project',
          args: ['image.png', '0'],
          timeout_seconds: 30,
          max_output_bytes: 1024 * 1024 * 2,
          env: {
            WEGENT_WORKSPACE_ROOTS: '/workspace/project',
          },
        },
      ],
    ])
  })

  test('keeps the existing Tauri commands outside Electron', async () => {
    isElectronRuntimeMock.mockReturnValue(false)
    invokeMock.mockResolvedValue({
      path: '/workspace/project',
      entries: [],
    })

    await listLocalWorkspaceEntries('/workspace/project', '/workspace/project/src')

    expect(invokeMock).toHaveBeenCalledWith('list_local_workspace_entries', {
      workspaceRoot: '/workspace/project',
      directoryPath: '/workspace/project/src',
    })
    expect(requestLocalExecutorMock).not.toHaveBeenCalled()
  })

  test('surfaces executor workspace access failures', async () => {
    isElectronRuntimeMock.mockReturnValue(true)
    requestLocalExecutorMock.mockResolvedValue({
      success: false,
      stdout: '',
      stderr: '',
      error: 'Workspace path is outside allowed workspace roots',
    })

    await expect(
      listLocalWorkspaceEntries('/workspace/project', '/workspace/secret')
    ).rejects.toThrow('Workspace path is outside allowed workspace roots')
  })
})
