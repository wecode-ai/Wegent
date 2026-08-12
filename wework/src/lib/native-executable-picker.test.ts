import { beforeEach, describe, expect, test, vi } from 'vitest'
import { open } from '@tauri-apps/plugin-dialog'
import { isTauriRuntime } from './runtime-environment'
import { openNativeExecutablePicker } from './native-executable-picker'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('./runtime-environment', () => ({ isTauriRuntime: vi.fn() }))

describe('openNativeExecutablePicker', () => {
  beforeEach(() => {
    vi.mocked(open).mockReset()
    vi.mocked(isTauriRuntime).mockReturnValue(true)
  })

  test('opens a native single-file picker at the detected executable', async () => {
    vi.mocked(open).mockResolvedValue('/opt/opencode/bin/opencode')

    await expect(
      openNativeExecutablePicker('/usr/local/bin/opencode', '选择 OpenCode 可执行文件')
    ).resolves.toBe('/opt/opencode/bin/opencode')
    expect(open).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      defaultPath: '/usr/local/bin/opencode',
      title: '选择 OpenCode 可执行文件',
    })
  })

  test('returns null outside Tauri without opening the picker', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false)

    await expect(openNativeExecutablePicker()).resolves.toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
})
