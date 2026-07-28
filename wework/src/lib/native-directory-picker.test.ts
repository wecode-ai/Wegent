import { describe, expect, test, vi } from 'vitest'
import { openNativeWorkspacePathPicker } from './native-workspace-path-picker'
import {
  openNativeProjectDirectoryPicker,
  openNativeProjectDirectoryPickers,
} from './native-directory-picker'

vi.mock('./native-workspace-path-picker', () => ({
  openNativeWorkspacePathPicker: vi.fn(),
}))

const openWorkspacePickerMock = vi.mocked(openNativeWorkspacePathPicker)

describe('openNativeProjectDirectoryPicker', () => {
  test('opens a single-directory picker at the requested home directory', async () => {
    openWorkspacePickerMock.mockResolvedValue([{ path: '/Users/alice/repo', isDirectory: true }])

    await expect(openNativeProjectDirectoryPicker('/Users/alice')).resolves.toBe(
      '/Users/alice/repo'
    )
    expect(openWorkspacePickerMock).toHaveBeenCalledWith('/Users/alice', {
      directoriesOnly: true,
      multiple: false,
      defaultToHome: true,
    })
  })

  test('returns null when the native picker is cancelled', async () => {
    openWorkspacePickerMock.mockResolvedValue([])

    await expect(openNativeProjectDirectoryPicker('/Users/alice')).resolves.toBeNull()
  })

  test('returns every selected directory for a multi-root project', async () => {
    openWorkspacePickerMock.mockResolvedValue([
      { path: '/Users/alice/web', isDirectory: true },
      { path: '/Users/alice/api', isDirectory: true },
      { path: '/Users/alice/readme.md', isDirectory: false },
    ])

    await expect(openNativeProjectDirectoryPickers('/Users/alice')).resolves.toEqual([
      '/Users/alice/web',
      '/Users/alice/api',
    ])
    expect(openWorkspacePickerMock).toHaveBeenCalledWith('/Users/alice', {
      directoriesOnly: true,
      multiple: true,
      defaultToHome: true,
    })
  })
})
