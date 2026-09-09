import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { CoreDshPluginManagementSection } from './CoreDshPluginManagementSection'

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  list: vi.fn(),
  restart: vi.fn(),
  setEnabled: vi.fn(),
  uninstall: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@/features/dsh-plugins/coreDshPlugins', () => ({
  installCoreDshPlugin: mocks.install,
  readCoreDshPlugins: mocks.list,
  restartCoreDsh: mocks.restart,
  setCoreDshPluginEnabled: mocks.setEnabled,
  uninstallCoreDshPlugin: mocks.uninstall,
  updateCoreDshPlugin: mocks.update,
}))

const plugin = {
  name: 'dsh-example',
  displayName: 'Example',
  description: 'Example plugin',
  version: '1.0.0',
  requestedSpec: 'dsh-example',
  enabled: true,
  immutable: false,
  homepage: '',
  repository: 'https://example.test/plugin',
  canUpdate: true,
  canToggle: true,
  canUninstall: true,
}

describe('CoreDshPluginManagementSection', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.list.mockResolvedValue([plugin])
    mocks.install.mockResolvedValue([plugin])
    mocks.update.mockResolvedValue([plugin])
    mocks.setEnabled.mockResolvedValue([{ ...plugin, enabled: false }])
    mocks.uninstall.mockResolvedValue([])
    mocks.restart.mockResolvedValue(undefined)
  })

  test('installs a trusted bundle and batches the restart', async () => {
    render(<CoreDshPluginManagementSection />)
    await screen.findByText('Example')

    await userEvent.type(screen.getByTestId('core-dsh-plugin-spec-input'), 'github:owner/plugin')
    await userEvent.click(screen.getByTestId('core-dsh-plugin-install-button'))
    expect(
      screen.getByText('插件及其安装脚本会以当前用户权限运行。仅安装你信任的 npm、Git 或本地包。')
    ).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('core-dsh-plugin-install-confirm'))

    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith('github:owner/plugin'))
    expect(screen.getByTestId('core-dsh-plugin-restart-required')).toBeInTheDocument()
    expect(mocks.restart).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('core-dsh-plugin-restart-button'))
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledOnce())
  })

  test('updates and disables one installed bundle', async () => {
    render(<CoreDshPluginManagementSection />)
    await screen.findByText('Example')

    await userEvent.click(screen.getByTestId('core-dsh-plugin-update-dsh-example'))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('dsh-example'))

    await userEvent.click(screen.getByTestId('core-dsh-plugin-toggle-dsh-example'))
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith('dsh-example', false))
    expect(screen.getByText('已停用')).toBeInTheDocument()
  })

  test('confirms uninstall before removing the package', async () => {
    render(<CoreDshPluginManagementSection />)
    await screen.findByText('Example')

    await userEvent.click(screen.getByTestId('core-dsh-plugin-uninstall-dsh-example'))
    expect(screen.getByText('将从 Wework 插件运行时中移除 dsh-example。')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('core-dsh-plugin-uninstall-confirm'))

    await waitFor(() => expect(mocks.uninstall).toHaveBeenCalledWith('dsh-example'))
  })

  test('leaves the Git plugin controls to workbench mode', async () => {
    mocks.list.mockResolvedValue([
      {
        ...plugin,
        name: '@wegent/dsh-ui-git',
        displayName: 'Git',
        requestedSpec: '',
        canUpdate: false,
        canUninstall: false,
      },
    ])

    render(<CoreDshPluginManagementSection />)

    expect(await screen.findByText('由“设置 → 通用 → 模式”管理')).toBeInTheDocument()
    expect(
      screen.queryByTestId('core-dsh-plugin-toggle-@wegent/dsh-ui-git')
    ).not.toBeInTheDocument()
  })
})
