import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { PluginPythonRuntimeNotice } from '@/components/plugins/PluginPythonRuntimeNotice'
import i18n from '@/i18n'
import { ExecutionEnvironmentsSettingsPage } from './ExecutionEnvironmentsSettingsPage'

const mocks = vi.hoisted(() => ({
  chooseNode: vi.fn(),
  ensurePython: vi.fn(),
  list: vi.fn(),
  useBuiltinNode: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({ subscribeDesktopHostEvents: mocks.subscribe }))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => true,
}))

vi.mock('@/desktop/executionEnvironments', () => ({
  chooseNodeExecutable: mocks.chooseNode,
  ensurePython: mocks.ensurePython,
  listExecutionEnvironments: mocks.list,
  useBuiltinNode: mocks.useBuiltinNode,
}))

describe('ExecutionEnvironmentsSettingsPage', () => {
  beforeEach(() => {
    mocks.subscribe.mockReset().mockReturnValue(vi.fn())
    mocks.chooseNode.mockReset()
    mocks.ensurePython.mockReset().mockResolvedValue({ state: 'installed' })
    mocks.useBuiltinNode.mockReset()
    mocks.list.mockReset().mockResolvedValue([
      {
        id: 'node',
        managed: true,
        autoInstall: true,
        state: 'installed',
        version: '24.13.0',
        downloadedBytes: 0,
        totalBytes: 0,
        installedBytes: 0,
        path: '/runtime/node',
        error: null,
        source: 'electron',
      },
      {
        id: 'python',
        managed: false,
        autoInstall: false,
        state: 'notInstalled',
        version: null,
        downloadedBytes: 0,
        totalBytes: 0,
        installedBytes: 0,
        path: '/runtime/python3',
        error: null,
        source: 'managed',
      },
    ])
  })

  test('shows Electron Node and Wework-managed Python', async () => {
    render(<ExecutionEnvironmentsSettingsPage />)

    expect(await screen.findByTestId('execution-environment-node')).toHaveTextContent('Node.js')
    expect(screen.getByTestId('execution-environment-node')).toHaveTextContent('Electron 内置')
    expect(screen.getByTestId('execution-environment-node')).toHaveTextContent('24.13.0')
    expect(screen.getByTestId('execution-environment-node')).toHaveTextContent('/runtime/node')
    expect(screen.queryByTestId('execution-environment-node-remove')).not.toBeInTheDocument()
    expect(screen.getByTestId('execution-environment-python')).toHaveTextContent('Python')
    expect(screen.getByTestId('execution-environment-python')).toHaveTextContent('Wework 管理')
    expect(screen.getByTestId('execution-environment-python')).toHaveTextContent('自动准备')
  })

  test('installs managed Python', async () => {
    const user = userEvent.setup()
    render(<ExecutionEnvironmentsSettingsPage />)

    await user.click(await screen.findByTestId('execution-environment-python-install'))

    await waitFor(() => expect(mocks.ensurePython).toHaveBeenCalledOnce())
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
  })

  test('updates installation stages from host events while preparation is pending', async () => {
    const user = userEvent.setup()
    let finish!: (status: unknown) => void
    mocks.ensurePython.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    render(<ExecutionEnvironmentsSettingsPage />)
    await user.click(await screen.findByTestId('execution-environment-python-install'))
    const environments = await mocks.list.mock.results[0].value
    act(() =>
      mocks.subscribe.mock.calls[0][0]({
        type: 'python-runtime-status',
        payload: {
          ...environments.find((item: { id: string }) => item.id === 'python'),
          state: 'downloading',
          phase: 'install',
          source: 'managed',
          totalBytes: 0,
          downloadedBytes: 0,
        },
      })
    )
    expect(screen.getByTestId('execution-environment-python-status')).toHaveTextContent('正在安装')
    expect(mocks.list).toHaveBeenCalledOnce()
    // Accepted host preparation outlives the view; finish the fixture before the next test.
    await act(async () =>
      finish({
        ...environments.find((item: { id: string }) => item.id === 'python'),
        state: 'installed',
      })
    )
  })

  test('keeps diagnostic status separate from credential-bearing runtime errors', async () => {
    const sensitiveError =
      'Failed https://fixture-user:fixture-password@example.invalid/python?token=fixture-token'
    mocks.list.mockResolvedValue([
      {
        id: 'python',
        managed: true,
        autoInstall: true,
        state: 'error',
        version: '3.12.12',
        downloadedBytes: 0,
        totalBytes: 0,
        installedBytes: 0,
        path: '/runtime/python3',
        error: sensitiveError,
        source: 'managed',
      },
    ])
    render(<ExecutionEnvironmentsSettingsPage />)

    const card = await screen.findByTestId('execution-environment-python')
    expect(card).toHaveTextContent(sensitiveError)
    const status = screen.getByTestId('execution-environment-python-status')
    expect(status).toHaveTextContent('安装失败 · Wework 管理 · 3.12.12')
    expect(status).not.toHaveTextContent(sensitiveError)
    expect(status).not.toHaveTextContent('fixture-password')
    expect(status).not.toHaveTextContent('fixture-token')
  })

  test('selects a custom Node executable', async () => {
    mocks.chooseNode.mockResolvedValue({ path: '/custom/node', version: '24.13.0' })
    const user = userEvent.setup()
    render(<ExecutionEnvironmentsSettingsPage />)

    await user.click(await screen.findByTestId('execution-environment-node-choose'))

    await waitFor(() => expect(mocks.chooseNode).toHaveBeenCalledOnce())
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
  })

  test('shares events and one accepted retry across the settings page and background notice', async () => {
    let finish!: (status: unknown) => void
    mocks.ensurePython.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    render(
      <>
        <PluginPythonRuntimeNotice />
        <ExecutionEnvironmentsSettingsPage />
      </>
    )
    await screen.findByTestId('execution-environment-python')
    expect(mocks.list).toHaveBeenCalledOnce()
    expect(mocks.subscribe).toHaveBeenCalledOnce()
    const environments = await mocks.list.mock.results[0].value
    const python = environments.find((item: { id: string }) => item.id === 'python')
    act(() =>
      mocks.subscribe.mock.calls[0][0]({
        type: 'python-runtime-status',
        payload: { ...python, state: 'error' },
      })
    )
    expect(screen.getByTestId('execution-environment-python-status')).toHaveTextContent('安装失败')
    const noticeRetry = screen.getByTestId('plugin-python-runtime-retry')
    const pageRetry = screen.getByTestId('execution-environment-python-install')
    await act(async () => {
      fireEvent.click(noticeRetry)
      fireEvent.click(pageRetry)
    })
    expect(mocks.ensurePython).toHaveBeenCalledOnce()
    expect(noticeRetry).toBeDisabled()
    expect(pageRetry).toBeDisabled()
    const installed = { ...python, state: 'installed' }
    mocks.list.mockResolvedValue(
      environments.map((item: { id: string }) => (item.id === 'python' ? installed : item))
    )
    await act(async () => finish(installed))
    expect(screen.queryByTestId('plugin-python-runtime-notice')).not.toBeInTheDocument()
    expect(screen.getByTestId('execution-environment-python-status')).toHaveTextContent('已安装')
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })

  test('language changes do not reread or resubscribe to host status', async () => {
    const previousLanguage = i18n.language
    const view = render(<ExecutionEnvironmentsSettingsPage />)
    try {
      await screen.findByTestId('execution-environment-python')
      await act(async () => {
        await i18n.changeLanguage(previousLanguage.startsWith('en') ? 'zh-CN' : 'en')
      })
      expect(mocks.list).toHaveBeenCalledOnce()
      expect(mocks.subscribe).toHaveBeenCalledOnce()
    } finally {
      view.unmount()
      await act(async () => {
        await i18n.changeLanguage(previousLanguage)
      })
    }
  })
})
