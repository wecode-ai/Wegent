// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import {
  startHarnessAppDevelopmentRuntime,
  restartHarnessAppDevelopmentRuntime,
} from './harnessAppDevelopmentRuntime'
const mocks = vi.hoisted(() => ({
  preparePreview: vi.fn(),
  start: vi.fn(),
  open: vi.fn(),
  stop: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
}))
vi.mock('@/api/local/harnessApps', () => ({ harnessAppsApi: mocks }))
vi.mock('./harnessAppTabs', () => ({
  registerHarnessAppTab: mocks.register,
  unregisterHarnessAppTab: mocks.unregister,
}))
const installation: HarnessAppInstallation = {
  id: 'blank-workbench',
  manifest: {
    name: 'blank-workbench',
    displayName: '空白工作台',
    version: '0.1.0',
    type: 'deepseek-harness-plugin-bundle',
    description: 'Web preset',
    entry: {
      installPackage: 'packages/bundle/blank-workbench',
      profile: 'web',
    },
    requirements: { dsh: '0.1.0-rc.8', node: '>=22' },
  },
  packagePath: '/tmp/blank-workbench',
  sha256: 'a'.repeat(64),
  modelKey: null,
  resident: false,
  runtimeVersion: null,
  state: 'installed',
  webUrl: null,
  error: null,
  source: 'linked',
  grantedCapabilities: { decisionModel: false },
}

describe('development runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.preparePreview.mockResolvedValue({
      ...installation,
      state: 'running',
      webUrl: 'http://localhost:9000',
    })
  })
  test('prepares the shared DSH runtime without opening a formal presentation', async () => {
    const running = await startHarnessAppDevelopmentRuntime({
      installation,
      missingWebUrlMessage: 'missing URL',
    })
    expect(mocks.preparePreview).toHaveBeenCalledWith(installation.id)
    expect(running.webUrl).toBe('http://localhost:9000')
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
  })
  test('explicit reload stops and starts in order', async () => {
    await restartHarnessAppDevelopmentRuntime({ ...installation, state: 'running' }, 'missing URL')
    expect(mocks.stop).toHaveBeenCalledWith(installation.id)
    expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.preparePreview.mock.invocationCallOrder[0]
    )
  })
  test('rejects missing web presentation without publishing a broken preview', async () => {
    mocks.preparePreview.mockResolvedValue({ ...installation, state: 'running', webUrl: null })
    await expect(
      startHarnessAppDevelopmentRuntime({ installation, missingWebUrlMessage: 'missing URL' })
    ).rejects.toThrow('missing URL')
    expect(mocks.register).not.toHaveBeenCalled()
  })
})
