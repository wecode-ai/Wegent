import { beforeEach, describe, expect, test, vi } from 'vitest'
import { harnessAppsApi, type HarnessAppExport } from './harnessApps'

const mocks = vi.hoisted(() => ({
  desktopInvoke: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: (...args: unknown[]) => mocks.desktopInvoke(...args),
}))

const exported: HarnessAppExport = {
  archivePath: '/tmp/exports/research-desk/1.2.0.zip',
  sha256: 'a'.repeat(64),
  sizeBytes: 1024,
  manifest: {
    name: 'research-desk',
    displayName: '研究工作台',
    version: '1.2.0',
    type: 'deepseek-harness-plugin-bundle',
    description: '整理本地研究资料',
    entry: {
      installPackage: 'packages/research-desk',
      profile: 'research',
    },
    requirements: { dsh: '0.1.0-rc.8', node: '>=22' },
  },
}

describe('harnessAppsApi', () => {
  beforeEach(() => {
    mocks.desktopInvoke.mockReset()
  })

  test('exports an installation and copies the archive to Downloads', async () => {
    const saved = {
      ...exported,
      destinationPath: '/Users/test/Downloads/research-desk-1.2.0.zip',
    }
    mocks.desktopInvoke.mockResolvedValue(saved)

    await expect(harnessAppsApi.exportToDownloads('research-desk')).resolves.toEqual(saved)
    expect(mocks.desktopInvoke).toHaveBeenCalledWith('smartApps.exportToDownloads', {
      installationId: 'research-desk',
    })
  })

  test('passes the selected capability template when creating a Smart App', async () => {
    mocks.desktopInvoke.mockResolvedValue({})

    await harnessAppsApi.createDirectory({
      parentPath: '/tmp',
      name: 'contract-app',
      displayName: 'Contract App',
      description: 'Generic app',
      template: 'web-host-remote',
    })

    expect(mocks.desktopInvoke).toHaveBeenCalledWith('smartApps.createDirectory', {
      parentPath: '/tmp',
      name: 'contract-app',
      displayName: 'Contract App',
      description: 'Generic app',
      template: 'web-host-remote',
    })
  })

  test('uses the dedicated verification capabilities for linked Smart Apps', async () => {
    const report = { status: 'passed' }
    mocks.desktopInvoke.mockResolvedValue(report)

    await expect(harnessAppsApi.inspectVerification('contract-app')).resolves.toBe(report)
    await expect(harnessAppsApi.verify('contract-app')).resolves.toBe(report)

    expect(mocks.desktopInvoke).toHaveBeenNthCalledWith(1, 'smartApps.inspectVerification', {
      installationId: 'contract-app',
    })
    expect(mocks.desktopInvoke).toHaveBeenNthCalledWith(2, 'smartApps.verify', {
      installationId: 'contract-app',
    })
  })
})
