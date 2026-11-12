import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import { HarnessAppAutoLauncher } from './HarnessAppAutoLauncher'
import {
  harnessAppKey,
  registerHarnessAppTab,
  resolveRunningHarnessAppInstallation,
  unregisterHarnessAppTab,
} from './harnessAppTabs'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  clear: vi.fn(),
  fail: vi.fn(),
  begin: vi.fn(),
  notify: vi.fn(),
}))
vi.mock('@/api/local/harnessApps', () => ({ harnessAppsApi: { open: mocks.open } }))
vi.mock('./harnessAppLaunchState', () => ({
  beginHarnessAppLaunch: mocks.begin,
  clearHarnessAppLaunch: mocks.clear,
  failHarnessAppLaunch: mocks.fail,
}))
vi.mock('./harnessAppInstallationsChanged', () => ({
  notifyHarnessAppInstallationsChanged: mocks.notify,
}))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => true }))
const t = (_key: string, fallback: string) => fallback
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
const running: HarnessAppInstallation = {
  id: 'app-1',
  manifest: {
    name: 'app-1',
    displayName: '工具',
    version: '1.0.0',
    type: 'deepseek-harness-plugin-bundle',
    description: 'Test workbench',
    entry: { installPackage: 'packages/app', profile: 'default' },
    requirements: { dsh: '>=0.1.0', node: '>=22' },
  },
  packagePath: '/tmp/app-1',
  sha256: 'hash',
  modelKey: null,
  resident: false,
  runtimeVersion: null,
  state: 'running',
  presentation: 'tab',
  webUrl: 'http://localhost:9000',
  error: null,
  source: 'managed',
  grantedCapabilities: { decisionModel: false },
}

describe('HarnessAppAutoLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unregisterHarnessAppTab('app-1')
    unregisterHarnessAppTab('app-2')
    mocks.open.mockResolvedValue(running)
  })
  test('settles a Host-prepared tab without beginning another launch or publishing it again', () => {
    registerHarnessAppTab(running)
    const settled = vi.fn()
    render(<HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />)
    expect(settled).toHaveBeenCalledExactlyOnceWith('app-1')
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.fail).not.toHaveBeenCalled()
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith('app-1')
    expect(resolveRunningHarnessAppInstallation(harnessAppKey('app-1'))).toBe(running)
  })
  test('passively attaches an unregistered restored route and settles only after Host readiness', async () => {
    registerHarnessAppTab({ ...running, id: 'app-2' })
    let complete!: (value: HarnessAppInstallation) => void
    mocks.open.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    const settled = vi.fn()
    render(<HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />)
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith('app-1', 'tab', { activateTab: false })
    expect(mocks.begin).toHaveBeenCalledWith('app-1', '工作台', expect.any(Function))
    expect(settled).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(resolveRunningHarnessAppInstallation(harnessAppKey('app-1'))).toBeNull()
    await act(async () => complete(running))
    expect(resolveRunningHarnessAppInstallation(harnessAppKey('app-1'))).toBe(running)
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
      type: 'updated',
      installationId: 'app-1',
      installation: running,
    })
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith('app-1')
    expect(settled).toHaveBeenCalledExactlyOnceWith('app-1')
  })
  test('shows a Host launch failure and retries through the same entry', async () => {
    mocks.open.mockRejectedValueOnce(new Error('model unavailable'))
    const settled = vi.fn()
    render(<HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />)
    await waitFor(() => expect(mocks.fail).toHaveBeenCalledWith('app-1', '工作台启动失败'))
    expect(resolveRunningHarnessAppInstallation(harnessAppKey('app-1'))).toBeNull()
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledExactlyOnceWith('app-1')
    act(() => mocks.begin.mock.calls[0][2]())
    await waitFor(() =>
      expect(resolveRunningHarnessAppInstallation(harnessAppKey('app-1'))).toBe(running)
    )
    expect(mocks.open.mock.calls).toEqual([
      ['app-1', 'tab', { activateTab: false }],
      ['app-1', 'tab', { activateTab: false }],
    ])
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith('app-1')
    expect(settled).toHaveBeenCalledTimes(2)
  })
  test.each([null, 'http://localhost:9000'])(
    'does not register a returned window as a prepared tab (webUrl=%s)',
    async webUrl => {
      mocks.open.mockResolvedValue({ ...running, presentation: 'window', webUrl })
      const settled = vi.fn()
      render(<HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />)
      await waitFor(() => expect(settled).toHaveBeenCalledExactlyOnceWith('app-1'))
      expect(resolveRunningHarnessAppInstallation(harnessAppKey('app-1'))).toBeNull()
      expect(mocks.notify).not.toHaveBeenCalled()
      expect(mocks.fail).not.toHaveBeenCalled()
      expect(mocks.clear).toHaveBeenCalledExactlyOnceWith('app-1')
    }
  )
  test('keeps an invalid tab response recoverable without publishing readiness', async () => {
    mocks.open.mockResolvedValue({ ...running, webUrl: null })
    const settled = vi.fn()
    render(<HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />)
    await waitFor(() => expect(mocks.fail).toHaveBeenCalledWith('app-1', '工作台没有返回可用地址'))
    expect(resolveRunningHarnessAppInstallation(harnessAppKey('app-1'))).toBeNull()
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledExactlyOnceWith('app-1')
  })
  test('does not publish a late successful attach into an unmounted presentation', async () => {
    let complete!: (value: HarnessAppInstallation) => void
    mocks.open.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    const settled = vi.fn()
    const view = render(
      <HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />
    )
    view.unmount()
    await act(async () => complete(running))
    expect(resolveRunningHarnessAppInstallation(harnessAppKey('app-1'))).toBeNull()
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.fail).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
  })
  test('does not publish a late failure into an unmounted presentation', async () => {
    let reject!: (reason: Error) => void
    mocks.open.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    const settled = vi.fn()
    const view = render(
      <HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />
    )
    view.unmount()
    await act(async () => reject(new Error('late Host failure')))
    expect(resolveRunningHarnessAppInstallation(harnessAppKey('app-1'))).toBeNull()
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.fail).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
  })
  test('settles only the current route owner when the installation changes during attachment', async () => {
    const pending = new Map<string, (installation: HarnessAppInstallation) => void>()
    mocks.open.mockImplementation(
      (installationId: string) =>
        new Promise(resolve => {
          pending.set(installationId, resolve)
        })
    )
    const settled = vi.fn()
    const view = render(
      <HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />
    )
    view.rerender(<HarnessAppAutoLauncher installationId="app-2" onStartupSettled={settled} />)
    await act(async () => pending.get('app-1')!(running))
    expect(resolveRunningHarnessAppInstallation(harnessAppKey('app-1'))).toBeNull()
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    const current = { ...running, id: 'app-2' }
    await act(async () => pending.get('app-2')!(current))
    expect(resolveRunningHarnessAppInstallation(harnessAppKey('app-2'))).toBe(current)
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
      type: 'updated',
      installationId: 'app-2',
      installation: current,
    })
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith('app-2')
    expect(settled).toHaveBeenCalledExactlyOnceWith('app-2')
  })
})
