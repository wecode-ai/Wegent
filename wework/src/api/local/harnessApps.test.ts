import { beforeEach, describe, expect, test, vi } from 'vitest'
import { harnessAppsApi, type HarnessAppExport } from './harnessApps'

const mocks = vi.hoisted(() => ({
  desktopInvoke: vi.fn(),
  electron: false,
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: (...args: unknown[]) => mocks.desktopInvoke(...args),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => mocks.electron,
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
    mocks.electron = false
    mocks.invoke.mockReset()
  })

  test('exports an installation and copies the archive to Downloads', async () => {
    mocks.invoke
      .mockResolvedValueOnce(exported)
      .mockResolvedValueOnce('/Users/test/Downloads/research-desk-1.2.0.zip')

    await expect(harnessAppsApi.exportToDownloads('research-desk')).resolves.toEqual({
      ...exported,
      destinationPath: '/Users/test/Downloads/research-desk-1.2.0.zip',
    })
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'export_harness_app_package', {
      installationId: 'research-desk',
    })
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'download_local_file_to_downloads', {
      sourcePath: exported.archivePath,
      filename: 'research-desk-1.2.0.zip',
    })
  })

  test('exports directly to Downloads through the Electron host', async () => {
    mocks.electron = true
    const saved = {
      ...exported,
      destinationPath: '/Users/test/Downloads/research-desk-1.2.0.zip',
    }
    mocks.desktopInvoke.mockResolvedValue(saved)

    await expect(harnessAppsApi.exportToDownloads('research-desk')).resolves.toEqual(saved)
    expect(mocks.desktopInvoke).toHaveBeenCalledWith('smartApps.exportToDownloads', {
      installationId: 'research-desk',
    })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
