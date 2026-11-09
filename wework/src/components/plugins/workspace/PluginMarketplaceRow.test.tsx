import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import type { PluginMarketplaceRowProps } from './pluginMarketplaceRowEquality'
import { PluginMarketplaceRow } from './PluginMarketplaceRow'
import { CategoryBrowseDialog } from './CategoryBrowseDialog'

beforeEach(() => {
  // Exercise real Radix collision handling with non-zero browser geometry.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.dataset.testid === 'plugin-marketplace-actions-dingtalk') {
      return new DOMRect(300, 720, 28, 28)
    }
    if (
      this.hasAttribute('data-radix-popper-content-wrapper') ||
      this.dataset.testid === 'plugin-marketplace-actions-menu-dingtalk'
    ) {
      return new DOMRect(0, 0, 176, 144)
    }
    return new DOMRect(0, 0, 1024, 768)
  })
  for (const [dimension, rect] of [
    ['clientWidth', 'width'],
    ['clientHeight', 'height'],
    ['offsetWidth', 'width'],
    ['offsetHeight', 'height'],
  ] as const) {
    vi.spyOn(HTMLElement.prototype, dimension, 'get').mockImplementation(function () {
      return this.getBoundingClientRect()[rect]
    })
  }
})

afterEach(() => vi.restoreAllMocks())

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

const installed = {
  ...props,
  item: {
    ...props.item,
    installed: true,
    installedLocally: true,
    currentDeviceInstallation: null,
    accessRole: 'recipient' as const,
    allowCopy: true,
  },
}

test('actions escape clipped and transformed card containers and restore trigger focus on Escape', async () => {
  const user = userEvent.setup()
  const { container } = render(
    <div style={{ overflow: 'hidden', transform: 'translateY(400px)' }}>
      <PluginMarketplaceRow {...installed} />
    </div>
  )
  const trigger = screen.getByTestId('plugin-marketplace-actions-dingtalk')
  await user.click(trigger)
  const menu = await screen.findByTestId('plugin-marketplace-actions-menu-dingtalk')
  expect(container).not.toContainElement(menu)
  expect(menu).toHaveClass('z-system-popover')
  expect(screen.getByTestId('plugin-marketplace-uninstall-dingtalk')).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() =>
    expect(screen.queryByTestId('plugin-marketplace-actions-menu-dingtalk')).not.toBeInTheDocument()
  )
  expect(trigger).toHaveFocus()
})

test.each(['try', 'copy', 'manage', 'uninstall'] as const)(
  'a portaled %s action dispatches once without opening the card',
  async action => {
    const user = userEvent.setup()
    const onAction = vi.fn()
    render(<PluginMarketplaceRow {...installed} onAction={onAction} />)
    await user.click(screen.getByTestId('plugin-marketplace-actions-dingtalk'))
    await user.click(await screen.findByTestId(`plugin-marketplace-${action}-dingtalk`))
    expect(onAction).toHaveBeenCalledExactlyOnceWith(action, installed.item)
    expect(screen.queryByTestId('plugin-marketplace-actions-menu-dingtalk')).not.toBeInTheDocument()
  }
)

test('clicking outside dismisses the menu', async () => {
  const user = userEvent.setup()
  render(
    <>
      <PluginMarketplaceRow {...installed} />
      <button type="button">Outside</button>
    </>
  )
  await user.click(screen.getByTestId('plugin-marketplace-actions-dingtalk'))
  await screen.findByTestId('plugin-marketplace-actions-menu-dingtalk')
  await user.click(screen.getByRole('button', { name: 'Outside' }))
  expect(screen.queryByTestId('plugin-marketplace-actions-menu-dingtalk')).not.toBeInTheDocument()
})

test('actions near the viewport bottom flip above the trigger', async () => {
  const user = userEvent.setup()
  render(<PluginMarketplaceRow {...installed} />)
  await user.click(screen.getByTestId('plugin-marketplace-actions-dingtalk'))
  await waitFor(() =>
    expect(screen.getByTestId('plugin-marketplace-actions-menu-dingtalk')).toHaveAttribute(
      'data-side',
      'top'
    )
  )
})

test('Escape dismisses the portaled menu before closing its category dialog', async () => {
  const user = userEvent.setup()
  const onClose = vi.fn()
  render(
    <CategoryBrowseDialog
      section={{ key: 'tools', title: 'Tools', items: [installed.item] }}
      isLoggedIn
      isReconciling={false}
      installingMarketplacePluginIds={new Set()}
      isLocallyUninstalling={() => false}
      allowPendingRetry={false}
      rowLabels={props.labels}
      onClose={onClose}
      onAction={vi.fn()}
    />
  )
  const dialog = screen.getByTestId('plugins-category-browse-dialog')
  await waitFor(() => expect(dialog).toHaveFocus())
  const trigger = screen.getByTestId('plugin-marketplace-actions-dingtalk')
  await user.click(trigger)
  const menu = await screen.findByTestId('plugin-marketplace-actions-menu-dingtalk')
  expect(dialog).not.toContainElement(menu)
  await user.keyboard('{Escape}')
  await waitFor(() =>
    expect(screen.queryByTestId('plugin-marketplace-actions-menu-dingtalk')).not.toBeInTheDocument()
  )
  expect(onClose).not.toHaveBeenCalled()
  expect(trigger).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalledOnce()
})

test('a virtual row unmount removes its portaled menu', async () => {
  const user = userEvent.setup()
  const result = render(<PluginMarketplaceRow {...installed} />)
  await user.click(screen.getByTestId('plugin-marketplace-actions-dingtalk'))
  await screen.findByTestId('plugin-marketplace-actions-menu-dingtalk')
  result.unmount()
  expect(screen.queryByTestId('plugin-marketplace-actions-menu-dingtalk')).not.toBeInTheDocument()
})
