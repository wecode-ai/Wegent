import { beforeEach, describe, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from './localExecutor'
import {
  listLocalWorkspaceEntries,
  readLocalWorkspaceFileChunk,
  readLocalWorkspaceTextFile,
} from './localWorkspaceFiles'

vi.mock('./localExecutor', () => ({
  requestLocalExecutor: vi.fn(),
}))

const requestLocalExecutorMock = vi.mocked(requestLocalExecutor)

describe('localWorkspaceFiles', () => {
  beforeEach(() => {
    requestLocalExecutorMock.mockReset()
  })

  test('lists workspace entries through the Electron-managed executor', async () => {
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
  })

  test('lists Windows workspace entries returned with canonical verbatim paths', async () => {
    requestLocalExecutorMock.mockResolvedValue({
      success: true,
      stdout: {
        path: String.raw`\\?\C:\work\Wegent`,
        entries: [
          {
            name: 'src',
            path: String.raw`\\?\C:\work\Wegent\src`,
            is_directory: true,
            size: 0,
            modified_at: null,
          },
        ],
      },
      stderr: '',
    })

    await expect(
      listLocalWorkspaceEntries(String.raw`C:\work\Wegent`, String.raw`C:\work\Wegent`)
    ).resolves.toEqual({
      path: String.raw`C:\work\Wegent`,
      entries: [
        {
          name: 'src',
          path: String.raw`C:\work\Wegent\src`,
          isDirectory: true,
          size: 0,
          modifiedAt: null,
        },
      ],
    })
    expect(requestLocalExecutorMock).toHaveBeenCalledWith('device.execute_command', {
      command_key: 'workspace_tree',
      path: String.raw`C:\work\Wegent`,
      timeout_seconds: 15,
      max_output_bytes: 1024 * 512,
      env: {
        WEGENT_WORKSPACE_ROOTS: String.raw`C:\work\Wegent`,
      },
    })
  })

  test('reads text and binary chunks through the Electron-managed executor', async () => {
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

  test('surfaces executor workspace access failures', async () => {
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
