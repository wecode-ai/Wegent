import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { ExecutionEnvironmentsSettingsPage } from './ExecutionEnvironmentsSettingsPage'

const mocks = vi.hoisted(() => ({
  chooseNode: vi.fn(),
  list: vi.fn(),
  useBuiltinNode: vi.fn(),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => true,
}))

vi.mock('@/desktop/executionEnvironments', () => ({
  chooseNodeExecutable: mocks.chooseNode,
  listExecutionEnvironments: mocks.list,
  useBuiltinNode: mocks.useBuiltinNode,
}))

describe('ExecutionEnvironmentsSettingsPage', () => {
  beforeEach(() => {
    mocks.chooseNode.mockReset()
    mocks.useBuiltinNode.mockReset()
    mocks.list.mockReset().mockResolvedValue([
      {
        id: 'node',
        managed: false,
        autoInstall: false,
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
        path: null,
        error: null,
      },
    ])
  })

  test('shows Electron Node and manually detected Python', async () => {
    render(<ExecutionEnvironmentsSettingsPage />)

    expect(await screen.findByTestId('execution-environment-node')).toHaveTextContent('Node.js')
    expect(screen.getByTestId('execution-environment-node')).toHaveTextContent('Electron 内置')
    expect(screen.getByTestId('execution-environment-node')).toHaveTextContent('24.13.0')
    expect(screen.getByTestId('execution-environment-node')).toHaveTextContent('/runtime/node')
    expect(screen.queryByTestId('execution-environment-node-remove')).not.toBeInTheDocument()
    expect(screen.getByTestId('execution-environment-python')).toHaveTextContent('Python')
    expect(screen.getByTestId('execution-environment-python')).toHaveTextContent('默认不下载')
  })

  test('refreshes manually detected Python', async () => {
    const user = userEvent.setup()
    render(<ExecutionEnvironmentsSettingsPage />)

    await user.click(await screen.findByTestId('execution-environment-python-refresh'))

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
  })

  test('selects a custom Node executable', async () => {
    mocks.chooseNode.mockResolvedValue({ path: '/custom/node', version: '24.13.0' })
    const user = userEvent.setup()
    render(<ExecutionEnvironmentsSettingsPage />)

    await user.click(await screen.findByTestId('execution-environment-node-choose'))

    await waitFor(() => expect(mocks.chooseNode).toHaveBeenCalledOnce())
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
  })
})
