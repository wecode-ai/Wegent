// @vitest-environment node

import { describe, expect, test, vi } from 'vitest'
import { openNativeProjectDirectoryPicker } from './native-directory-picker'
import { openNativeWorkspacePathPicker } from './native-workspace-path-picker'

vi.mock('./native-workspace-path-picker', () => ({
  openNativeWorkspacePathPicker: vi.fn(),
}))

const openWorkspacePickerMock = vi.mocked(openNativeWorkspacePathPicker)

describe('openNativeProjectDirectoryPicker', () => {
  test('returns null when the native picker is cancelled', async () => {
    openWorkspacePickerMock.mockResolvedValue([])

    await expect(openNativeProjectDirectoryPicker('/Users/alice')).resolves.toBeNull()
  })
})
