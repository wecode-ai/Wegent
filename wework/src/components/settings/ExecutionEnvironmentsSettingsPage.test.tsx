import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { ExecutionEnvironmentsSettingsPage } from './ExecutionEnvironmentsSettingsPage'

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => true,
}))

vi.mock('@/desktop/executionEnvironments', () => ({
  installExecutionEnvironment: mocks.install,
  listExecutionEnvironments: mocks.list,
  removeExecutionEnvironment: mocks.remove,
}))

describe('ExecutionEnvironmentsSettingsPage', () => {
  beforeEach(() => {
    mocks.install.mockReset()
    mocks.remove.mockReset()
    mocks.list.mockReset().mockResolvedValue([
      {
        id: 'node',
        managed: true,
        autoInstall: true,
        state: 'installed',
        version: '24.1.0',
        downloadedBytes: 40,
        totalBytes: 40,
        installedBytes: 110,
        path: '/runtime/node',
        error: null,
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

  test('shows managed Node and manually detected Python', async () => {
    render(<ExecutionEnvironmentsSettingsPage />)

    expect(await screen.findByTestId('execution-environment-node')).toHaveTextContent('Node.js')
    expect(screen.getByTestId('execution-environment-node')).toHaveTextContent('24.1.0')
    expect(screen.getByTestId('execution-environment-python')).toHaveTextContent('Python')
    expect(screen.getByTestId('execution-environment-python')).toHaveTextContent('默认不下载')
  })

  test('removes the managed Node runtime', async () => {
    mocks.remove.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ExecutionEnvironmentsSettingsPage />)

    await user.click(await screen.findByTestId('execution-environment-node-remove'))

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('node'))
  })
})
