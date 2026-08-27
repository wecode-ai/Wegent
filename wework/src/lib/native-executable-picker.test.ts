import { beforeEach, describe, expect, test, vi } from 'vitest'
import { openNativeExecutablePicker } from './native-executable-picker'

const desktopHostMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: desktopHostMock }))

describe('openNativeExecutablePicker', () => {
  beforeEach(() => desktopHostMock.mockReset())

  test('opens an Electron single-file picker at the detected executable', async () => {
    desktopHostMock.mockResolvedValue({
      canceled: false,
      filePaths: ['/opt/opencode/bin/opencode'],
    })
    await expect(
      openNativeExecutablePicker('/usr/local/bin/opencode', '选择 OpenCode 可执行文件')
    ).resolves.toBe('/opt/opencode/bin/opencode')
    expect(desktopHostMock).toHaveBeenCalledWith('dialog.open', {
      defaultPath: '/usr/local/bin/opencode',
      title: '选择 OpenCode 可执行文件',
      properties: ['openFile'],
    })
  })

  test('returns null when the Electron dialog is canceled', async () => {
    desktopHostMock.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(openNativeExecutablePicker()).resolves.toBeNull()
  })
})
