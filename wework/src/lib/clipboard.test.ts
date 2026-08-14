import { beforeEach, describe, expect, test, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { copyLocalExecutorDebugInfo } from '@/tauri/localExecutor'

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: vi.fn(),
}))

vi.mock('@/tauri/localExecutor', () => ({
  copyLocalExecutorDebugInfo: vi.fn(),
}))

const isTauriRuntimeMock = vi.mocked(isTauriRuntime)
const copyLocalExecutorDebugInfoMock = vi.mocked(copyLocalExecutorDebugInfo)

describe('copyTextToClipboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isTauriRuntimeMock.mockReturnValue(false)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    })
  })

  test('uses the browser clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    await copyTextToClipboard('docker run')

    expect(writeText).toHaveBeenCalledWith('docker run')
    expect(document.execCommand).not.toHaveBeenCalled()
  })

  test('falls back to the document copy command before the native Tauri command', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    vi.mocked(document.execCommand).mockReturnValue(true)

    await copyTextToClipboard('docker run')

    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(copyLocalExecutorDebugInfoMock).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')).toBeNull()
  })

  test('uses the native Tauri command when browser fallbacks are unavailable', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    copyLocalExecutorDebugInfoMock.mockResolvedValue(undefined)

    await copyTextToClipboard('docker run')

    expect(copyLocalExecutorDebugInfoMock).toHaveBeenCalledWith('docker run')
  })

  test('reports unsupported browser clipboard environments', async () => {
    await expect(copyTextToClipboard('docker run')).rejects.toThrow(
      'Clipboard copy is not supported'
    )
  })
})
