import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { DesktopHostEvent } from '@/api/dsh/desktopHost'
import type { ExecutionEnvironmentStatus } from '@/desktop/executionEnvironments'
import { PluginPythonRuntimeNotice } from './PluginPythonRuntimeNotice'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  ensure: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))
vi.mock('@/api/dsh/desktopHost', () => ({ subscribeDesktopHostEvents: mocks.subscribe }))
vi.mock('@/hooks/useTranslation', async () => {
  const { default: i18next } = await import('i18next')
  const { default: common } = await import('@/i18n/locales/zh-CN/common.json')
  const instance = i18next.createInstance()
  await instance.init({ lng: 'zh-CN', resources: { 'zh-CN': { common } } })
  return { useTranslation: () => ({ t: instance.getFixedT('zh-CN', 'common') }) }
})
vi.mock('@/desktop/executionEnvironments', () => ({
  listExecutionEnvironments: mocks.list,
  ensurePython: mocks.ensure,
}))

const python: ExecutionEnvironmentStatus = {
  id: 'python',
  managed: true,
  autoInstall: true,
  state: 'notInstalled',
  version: null,
  downloadedBytes: 0,
  totalBytes: 0,
  installedBytes: 0,
  path: '/app/managed-runtimes/python/bin/python3',
  error: null,
  source: 'managed',
  phase: null,
}
function publish(status: Partial<ExecutionEnvironmentStatus>) {
  const handler = mocks.subscribe.mock.calls[0][0] as (event: DesktopHostEvent) => void
  act(() =>
    handler({ sequence: 1, type: 'python-runtime-status', payload: { ...python, ...status } })
  )
}

describe('PluginPythonRuntimeNotice', () => {
  test('explains temporary local Python while the managed installation continues', async () => {
    render(<PluginPythonRuntimeNotice />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    publish({ state: 'downloading', phase: 'install', temporaryPythonVersion: '3.12.8' })
    expect(screen.getByTestId('plugin-python-runtime-notice')).toHaveTextContent(
      '本机 Python 3.12.8'
    )
    expect(screen.getByTestId('plugin-python-runtime-notice')).toHaveTextContent('托管环境继续准备')
    expect(mocks.ensure).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.list.mockResolvedValue([python])
    mocks.subscribe.mockReturnValue(mocks.unsubscribe)
    mocks.ensure.mockResolvedValue({ ...python, state: 'installed' })
  })

  test('reads status without preparing Python and releases its event subscription', async () => {
    const { unmount } = render(<PluginPythonRuntimeNotice />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(screen.queryByTestId('plugin-python-runtime-notice')).not.toBeInTheDocument()
    unmount()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })

  test('shows actual download progress and indeterminate installation and verification stages', async () => {
    render(<PluginPythonRuntimeNotice />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    publish({ state: 'downloading', phase: 'download', downloadedBytes: 25, totalBytes: 100 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByRole('status')).toHaveTextContent('正在下载')
    publish({ state: 'downloading', phase: 'install' })
    expect(screen.getByRole('status')).toHaveTextContent('正在安装')
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    expect(screen.queryByText('25%')).not.toBeInTheDocument()
    publish({ state: 'downloading', phase: 'verify' })
    expect(screen.getByRole('status')).toHaveTextContent('正在验证')
    publish({ state: 'installed' })
    expect(screen.queryByTestId('plugin-python-runtime-notice')).not.toBeInTheDocument()
  })

  test('allows dismissal, reopens on failure, and retries without displaying raw errors', async () => {
    const user = userEvent.setup()
    render(<PluginPythonRuntimeNotice />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    publish({ state: 'downloading', phase: 'install' })
    await user.click(screen.getByTestId('plugin-python-runtime-dismiss'))
    publish({ state: 'downloading', phase: 'verify' })
    expect(screen.queryByTestId('plugin-python-runtime-notice')).not.toBeInTheDocument()
    publish({ state: 'error', error: 'https://private:secret@example.invalid/?token=secret' })
    expect(screen.getByRole('alert')).toHaveTextContent('准备失败')
    expect(screen.getByTestId('plugin-python-runtime-notice')).not.toHaveTextContent('secret')
    await user.click(screen.getByTestId('plugin-python-runtime-retry'))
    expect(mocks.ensure).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(screen.queryByTestId('plugin-python-runtime-notice')).not.toBeInTheDocument()
    )
  })

  test('does not overwrite a newer installation event with the initial status response', async () => {
    let resolve!: (value: ExecutionEnvironmentStatus[]) => void
    mocks.list.mockReturnValue(
      new Promise<ExecutionEnvironmentStatus[]>(done => {
        resolve = done
      })
    )
    render(<PluginPythonRuntimeNotice />)
    publish({ state: 'downloading', phase: 'install' })
    await act(async () => resolve([python]))
    expect(screen.getByRole('status')).toHaveTextContent('正在安装')
  })
})
