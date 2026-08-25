import { beforeEach, describe, expect, test, vi } from 'vitest'
import { openNativeWorkspacePathPicker } from './native-workspace-path-picker'

const desktopHostMock = vi.hoisted(() => vi.fn())

vi.mock('./runtime-environment', () => ({ isDesktopRuntime: () => true }))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: desktopHostMock }))

describe('openNativeWorkspacePathPicker', () => {
  beforeEach(() => desktopHostMock.mockReset())

  test('passes project picker constraints to the Electron host', async () => {
    desktopHostMock
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/alice/repo'] })
      .mockResolvedValueOnce({ isDirectory: true })

    await expect(
      openNativeWorkspacePathPicker('/Users/alice', {
        directoriesOnly: true,
        multiple: false,
      })
    ).resolves.toEqual([{ path: '/Users/alice/repo', isDirectory: true }])
    expect(desktopHostMock).toHaveBeenNthCalledWith(1, 'dialog.open', {
      defaultPath: '/Users/alice',
      properties: ['openDirectory', 'createDirectory'],
    })
    expect(desktopHostMock).toHaveBeenNthCalledWith(2, 'filesystem.stat', {
      path: '/Users/alice/repo',
    })
  })
})
