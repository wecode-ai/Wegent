import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { HarnessAppAutoLauncher } from './HarnessAppAutoLauncher'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  register: vi.fn(),
  clear: vi.fn(),
  fail: vi.fn(),
  begin: vi.fn(),
  notify: vi.fn(),
}))
vi.mock('@/api/local/harnessApps', () => ({ harnessAppsApi: { open: mocks.open } }))
vi.mock('./harnessAppTabs', () => ({ registerHarnessAppTab: mocks.register }))
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
const running = {
  id: 'app-1',
  manifest: { displayName: '工具' },
  state: 'running',
  presentation: 'tab',
  webUrl: 'http://localhost:9000',
}

describe('HarnessAppAutoLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.open.mockResolvedValue(running)
  })
  test('asks the Host to attach a tab without renderer model or route preparation', async () => {
    const settled = vi.fn()
    render(<HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />)
    await waitFor(() => expect(mocks.register).toHaveBeenCalledWith(running))
    expect(mocks.open).toHaveBeenCalledWith('app-1', 'tab')
    expect(settled).toHaveBeenCalledWith('app-1')
  })
  test('shows a Host launch failure and retries through the same entry', async () => {
    mocks.open.mockRejectedValueOnce(new Error('model unavailable'))
    render(<HarnessAppAutoLauncher installationId="app-1" />)
    await waitFor(() => expect(mocks.fail).toHaveBeenCalledWith('app-1', '工作台启动失败'))
    act(() => mocks.begin.mock.calls[0][2]())
    await waitFor(() => expect(mocks.register).toHaveBeenCalledWith(running))
  })
  test('does not publish a late open into an unmounted presentation', async () => {
    let resolve!: (value: unknown) => void
    mocks.open.mockImplementation(
      () =>
        new Promise(value => {
          resolve = value
        })
    )
    const view = render(<HarnessAppAutoLauncher installationId="app-1" />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())
    view.unmount()
    await act(async () => resolve(running))
    expect(mocks.register).not.toHaveBeenCalled()
  })
})
