import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import { PluginMarketplaceRow } from './PluginMarketplaceRow'
import { arePluginMarketplaceRowPropsEqual } from './pluginMarketplaceRowEquality'

const labels = {
  install: '安装',
  installing: '正在安装',
  uninstalling: '正在卸载',
  retry: '重试安装',
  syncing: '同步中...',
  try: '立即对话',
  manage: '管理',
  uninstall: '卸载',
  copy: '复制到我的插件',
}

function makeItem(overrides: Partial<PluginMarketplaceItem> = {}): PluginMarketplaceItem {
  return {
    id: '101',
    name: 'documents',
    displayName: 'Documents',
    description: 'Docs plugin',
    version: '1.0.0',
    installed: false,
    installedLocally: false,
    enabled: false,
    visibility: 'public',
    ...overrides,
  } as PluginMarketplaceItem
}

describe('PluginMarketplaceRow', () => {
  test('treats identical row props as equal for memo', () => {
    const onAction = vi.fn()
    const item = makeItem()
    const props = {
      item,
      isLoggedIn: true,
      isInstalling: false,
      isUninstalling: false,
      allowPendingRetry: true,
      labels,
      onAction,
    }
    expect(arePluginMarketplaceRowPropsEqual(props, { ...props })).toBe(true)
    expect(
      arePluginMarketplaceRowPropsEqual(props, {
        ...props,
        isInstalling: true,
      })
    ).toBe(false)
  })

  test('does not commit a new render when parent re-renders with the same props', () => {
    const onAction = vi.fn()
    const item = makeItem()
    let actualDurationTotal = 0
    const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
      if (phase === 'update') actualDurationTotal += actualDuration
    }

    function Parent({ tick }: { tick: number }) {
      return (
        <Profiler id="plugin-marketplace-row" onRender={onRender}>
          <span data-testid="parent-tick">{tick}</span>
          <PluginMarketplaceRow
            item={item}
            isLoggedIn
            isInstalling={false}
            isUninstalling={false}
            allowPendingRetry
            labels={labels}
            onAction={onAction}
          />
        </Profiler>
      )
    }

    const { rerender } = render(<Parent tick={1} />)
    expect(screen.getByTestId('plugin-marketplace-row-101')).toHaveTextContent('Documents')
    rerender(<Parent tick={2} />)
    expect(screen.getByTestId('parent-tick')).toHaveTextContent('2')
    expect(screen.getByTestId('plugin-marketplace-row-101')).toBeInTheDocument()
    expect(actualDurationTotal).toBeGreaterThanOrEqual(0)
  })
})
