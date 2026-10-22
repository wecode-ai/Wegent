import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { BundledPluginUpdateNotice } from './BundledPluginUpdateNotice'

const mocks = vi.hoisted(() => ({
  state: undefined as { status: 'ready' | 'failed' | 'deferred' } | undefined,
  retry: vi.fn(),
}))
vi.mock('@/desktop/localExecutor', () => ({
  getBundledPluginUpdateState: () => mocks.state,
  subscribeBundledPluginUpdates: () => () => undefined,
  ensureBundledPluginInstalled: mocks.retry,
}))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

beforeEach(() => {
  mocks.retry.mockReset().mockResolvedValue(undefined)
})

test('offers recovery for a failed update without uninstalling the plugin', () => {
  mocks.state = { status: 'failed' }
  render(<BundledPluginUpdateNotice name="smart-app-builder" />)
  expect(screen.getByRole('status')).toHaveTextContent('旧版本已保留')
  fireEvent.click(screen.getByTestId('bundled-plugin-update-retry-smart-app-builder'))
  expect(mocks.retry).toHaveBeenCalledWith('smart-app-builder')
})

test('explains deferred updates and hides the notice once ready', () => {
  mocks.state = { status: 'deferred' }
  const view = render(<BundledPluginUpdateNotice name="smart-app-builder" />)
  expect(screen.getByRole('status')).toHaveTextContent('当前任务结束后更新')
  expect(screen.queryByRole('button')).toBeNull()
  mocks.state = { status: 'ready' }
  view.rerender(<BundledPluginUpdateNotice name="smart-app-builder" />)
  expect(screen.queryByRole('status')).toBeNull()
})
