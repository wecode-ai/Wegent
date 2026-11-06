import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import type { PluginMarketplaceRowProps } from './pluginMarketplaceRowEquality'
import { PluginMarketplaceRow } from './PluginMarketplaceRow'

const props: PluginMarketplaceRowProps = {
  item: {
    id: 'dingtalk',
    remotePluginId: 'dingtalk',
    name: 'dingtalk',
    displayName: '钉钉',
    description: '',
    visibility: 'public',
    featured: false,
    installed: false,
    enabled: true,
    sourceType: 'marketplace',
    components: {
      skills: [],
      commands: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
    },
    manifest: {},
    ownerUserId: 0,
    currentDeviceInstallation: {
      deviceId: 'device',
      state: 'uninstalling',
      desiredReleaseId: 1,
      attemptCount: 0,
      updatedAt: '2026-11-04T00:00:00Z',
    },
  },
  isLoggedIn: true,
  isReconciling: false,
  isInstalling: false,
  isUninstalling: false,
  allowPendingRetry: false,
  labels: {
    install: '安装',
    installing: '正在安装',
    uninstalling: '正在卸载',
    syncing: '同步中',
    retry: '重试',
    try: '使用',
    manage: '管理',
    uninstall: '卸载',
    copy: '复制',
  },
  onAction: vi.fn(),
}

test('a reinstall takes precedence over the previous device uninstall snapshot', () => {
  const { rerender } = render(<PluginMarketplaceRow {...props} />)
  expect(screen.getByRole('status', { name: '正在卸载 钉钉' })).toHaveTextContent('正在卸载')

  rerender(<PluginMarketplaceRow {...props} isInstalling />)
  expect(screen.getByRole('status', { name: '正在安装 钉钉' })).toHaveTextContent('正在安装')
  expect(screen.queryByText('正在卸载')).not.toBeInTheDocument()

  rerender(
    <PluginMarketplaceRow
      {...props}
      item={{
        ...props.item,
        currentDeviceInstallation: { ...props.item.currentDeviceInstallation!, state: 'pending' },
      }}
    />
  )
  expect(screen.getByRole('status', { name: '同步中 钉钉' })).toHaveTextContent('同步中')

  rerender(<PluginMarketplaceRow {...props} isUninstalling />)
  expect(screen.getByRole('status', { name: '正在卸载 钉钉' })).toHaveTextContent('正在卸载')
})
