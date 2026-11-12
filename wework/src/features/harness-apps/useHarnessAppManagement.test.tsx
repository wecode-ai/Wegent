import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import { useHarnessAppManagement } from './useHarnessAppManagement'
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  stop: vi.fn(),
  update: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  openTab: vi.fn(),
  selectTab: vi.fn(),
  workspaceOpenTab: vi.fn(),
  closeTab: vi.fn(),
}))
vi.mock('@/api/local/harnessApps', () => ({ harnessAppsApi: mocks }))
vi.mock('./harnessAppTabs', () => ({
  harnessAppRoute: (id: string) => `/app/harness-${id}`,
  registerHarnessAppTab: mocks.register,
  unregisterHarnessAppTab: mocks.unregister,
  openHarnessAppTab: mocks.openTab,
}))
const tabs = {
  tabs: [{ id: 'tab-1', contentRoute: '/app/harness-smart-app-1' }],
  activeTabId: 'tab-1',
  openTab: mocks.workspaceOpenTab,
  selectTab: mocks.selectTab,
  closeTab: mocks.closeTab,
}
vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useWorkspaceTabs: () => tabs,
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ projectChat: { models: [] } }),
}))
const t = (_key: string, fallback: string) => fallback
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
const installed: HarnessAppInstallation = {
  id: 'smart-app-1',
  manifest: {
    name: 'smart-app-1',
    displayName: 'Smart app 1',
    version: '1.0.0',
    type: 'deepseek-harness-plugin-bundle',
    description: 'Test app',
    entry: { installPackage: 'packages/app', profile: 'default' },
    requirements: { dsh: '>=0.1.0', node: '>=22' },
  },
  packagePath: '/tmp/smart-app-1',
  sha256: 'hash',
  modelKey: 'wework:runtime:::local-model%3Amodel-1',
  resident: false,
  runtimeVersion: null,
  state: 'installed',
  webUrl: null,
  error: null,
  source: 'managed',
  grantedCapabilities: { decisionModel: false },
}

const running: HarnessAppInstallation = {
  ...installed,
  state: 'running',
  webUrl: 'http://127.0.0.1:39000/',
}

describe('useHarnessAppManagement', () => {
  const onError = vi.fn(),
    onBusyChange = vi.fn(),
    onRefresh = vi.fn()
  const renderManagement = () =>
    renderHook(() => useHarnessAppManagement({ onError, onBusyChange, onRefresh }))
  beforeEach(() => {
    vi.clearAllMocks()
    tabs.activeTabId = 'tab-1'
    mocks.selectTab.mockImplementation((id: string) => {
      tabs.activeTabId = id
    })
    onRefresh.mockResolvedValue(undefined)
  })
  test('does not register presentations when the management hook mounts or rerenders', () => {
    const { rerender } = renderManagement()
    rerender()
    expect(mocks.register).not.toHaveBeenCalled()
  })
  test.each(['tab', 'window'] as const)(
    'preserves a newer user selection when a delayed %s open response completes',
    async presentation => {
      const hostInstallation = { ...running, presentation }
      let completeOpen!: (installation: HarnessAppInstallation) => void
      mocks.open.mockReturnValue(
        new Promise<HarnessAppInstallation>(resolve => {
          completeOpen = resolve
        })
      )
      const { result } = renderManagement()
      let opening!: Promise<void>
      act(() => {
        opening = result.current.open(installed, presentation)
      })
      mocks.register(hostInstallation)
      mocks.openTab(tabs, hostInstallation)
      act(() => tabs.selectTab('management'))
      mocks.register.mockClear()
      mocks.openTab.mockClear()
      mocks.selectTab.mockClear()

      await act(async () => {
        completeOpen(hostInstallation)
        await opening
      })

      expect(tabs.activeTabId).toBe('management')
      expect(mocks.register).not.toHaveBeenCalled()
      expect(mocks.unregister).not.toHaveBeenCalled()
      expect(mocks.openTab).not.toHaveBeenCalled()
      expect(mocks.workspaceOpenTab).not.toHaveBeenCalled()
      expect(mocks.selectTab).not.toHaveBeenCalled()
      expect(mocks.closeTab).not.toHaveBeenCalled()
      expect(onRefresh).toHaveBeenCalledOnce()
      expect(onBusyChange.mock.calls).toEqual([[installed.id], [null]])
    }
  )
  test('opens the Host default window and refreshes without mutating renderer presentations', async () => {
    mocks.open.mockResolvedValue({ ...running, presentation: 'window' })
    const { result } = renderManagement()
    await act(async () => result.current.start(installed))
    expect(mocks.open).toHaveBeenCalledWith(installed.id, undefined)
    expect(mocks.openTab).not.toHaveBeenCalled()
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.unregister).not.toHaveBeenCalled()
    expect(onRefresh).toHaveBeenCalledOnce()
  })
  test('switches the existing runtime to a tab using one Host open', async () => {
    const tab = { ...running, presentation: 'tab' }
    mocks.open.mockResolvedValue(tab)
    const { result } = renderManagement()
    await act(async () => result.current.open(running, 'tab'))
    expect(mocks.open).toHaveBeenCalledWith(installed.id, 'tab')
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(mocks.stop).not.toHaveBeenCalled()
  })
  test('keeps Host errors visible and refreshes only after successful actions', async () => {
    mocks.open.mockRejectedValue(new Error('model unavailable'))
    const { result } = renderManagement()
    await act(async () => result.current.open(installed))
    expect(onError).toHaveBeenLastCalledWith('工作台启动失败')
    expect(onRefresh).not.toHaveBeenCalled()
  })
  test('stops the Host runtime and closes its presentation', async () => {
    mocks.stop.mockResolvedValue(undefined)
    const { result } = renderManagement()
    await act(async () => result.current.stop(running))
    expect(mocks.stop).toHaveBeenCalledWith(installed.id)
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1')
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})
