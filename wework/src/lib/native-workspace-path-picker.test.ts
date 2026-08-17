import { beforeEach, describe, expect, test, vi } from 'vitest'
import { openNativeWorkspacePathPicker } from './native-workspace-path-picker'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('./runtime-environment', () => ({
  isTauriRuntime: () => true,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}))

describe('openNativeWorkspacePathPicker', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  test('passes project picker constraints to the native command', async () => {
    mocks.invoke.mockResolvedValue([{ path: '/Users/alice/repo', isDirectory: true }])

    await expect(
      openNativeWorkspacePathPicker('/Users/alice', {
        directoriesOnly: true,
        multiple: false,
      })
    ).resolves.toEqual([{ path: '/Users/alice/repo', isDirectory: true }])

    expect(mocks.invoke).toHaveBeenCalledWith('pick_workspace_paths', {
      initialDirectory: '/Users/alice',
      directoriesOnly: true,
      multiple: false,
      defaultToHome: false,
    })
  })
})
