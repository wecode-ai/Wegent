import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { AppUpdateErrorDetailsDialog } from './AppUpdateErrorDetailsDialog'
import type { AppUpdateError } from './app-update-error'

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn() }))

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const updateError: AppUpdateError = {
  stage: 'check',
  kind: 'generic',
  code: 'APP_UPDATE_PATH_UNAVAILABLE',
  occurredAt: Date.parse('2026-11-02T02:34:20Z'),
  detail: 'No verified upgrade path is available from this version.',
}

function renderDialog(error = updateError) {
  return render(
    <AppUpdateErrorDetailsDialog open error={error} onClose={vi.fn()} onRetry={vi.fn()} />
  )
}

describe('AppUpdateErrorDetailsDialog diagnostics', () => {
  beforeEach(() => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    vi.mocked(invokeDesktopHost).mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    delete window.__WEWORK_RUNTIME_CONFIG__
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })

  test('copies every displayed diagnostic through the native clipboard without the browser API', async () => {
    renderDialog()

    fireEvent.click(screen.getByTestId('app-update-error-copy'))

    const occurredAt = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(updateError.occurredAt))
    await waitFor(() => {
      expect(invokeDesktopHost).toHaveBeenCalledExactlyOnceWith('clipboard.writeText', {
        text: [
          '错误类型: 更新失败',
          '错误代码: APP_UPDATE_PATH_UNAVAILABLE',
          `发生时间: ${occurredAt}`,
          '影响功能: 检查应用更新',
          `技术信息: ${updateError.detail}`,
        ].join('\n'),
      })
      expect(screen.getByTestId('app-update-error-copy')).toHaveTextContent('已复制')
    })
  })

  test('keeps copying pending until the native write succeeds and prevents duplicate clicks', async () => {
    let finishCopy!: () => void
    vi.mocked(invokeDesktopHost).mockReturnValueOnce(
      new Promise<void>(resolve => {
        finishCopy = resolve
      })
    )
    renderDialog()
    const button = screen.getByTestId('app-update-error-copy')

    fireEvent.click(button)

    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('复制中')
    expect(button).not.toHaveTextContent('已复制')
    fireEvent.click(button)
    expect(invokeDesktopHost).toHaveBeenCalledTimes(1)

    await act(async () => finishCopy())

    expect(button).toBeEnabled()
    expect(button).toHaveTextContent('已复制')
  })

  test('shows a failed native write and allows copying again', async () => {
    vi.mocked(invokeDesktopHost).mockRejectedValueOnce(new Error('Clipboard unavailable'))
    renderDialog()
    const button = screen.getByTestId('app-update-error-copy')

    fireEvent.click(button)

    await waitFor(() => expect(button).toHaveTextContent('复制失败，请重试'))
    expect(button).toBeEnabled()
    expect(button).not.toHaveTextContent('已复制')

    fireEvent.click(button)

    await waitFor(() => expect(button).toHaveTextContent('已复制'))
    expect(invokeDesktopHost).toHaveBeenCalledTimes(2)
  })

  test('omits absent technical details from copied diagnostics', async () => {
    renderDialog({ ...updateError, kind: 'network', detail: null })

    fireEvent.click(screen.getByTestId('app-update-error-copy'))

    await waitFor(() => expect(invokeDesktopHost).toHaveBeenCalledOnce())
    const diagnostics = vi.mocked(invokeDesktopHost).mock.calls[0]?.[1]?.text
    expect(diagnostics).toContain('错误类型: 网络连接失败')
    expect(diagnostics).not.toContain('技术信息:')
    expect(diagnostics).not.toContain('null')
  })
})
