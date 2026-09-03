import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import { createLocalCodexPluginApi } from './codexPlugins'

const mocks = vi.hoisted(() => ({
  requestLocalExecutor: vi.fn(),
  readElectronLocalFile: vi.fn(),
  sha256Hex: vi.fn(),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))

vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn(),
  ensureBundledPluginMarketplaceRegistered: vi.fn(),
  getInitializedBundledPluginMarketplace: () => ({
    id: 'wework-personal',
    path: '/tmp/executor-home/capabilities/bundled-marketplaces/wework-personal',
    pluginCount: 0,
  }),
  requestLocalExecutor: (...args: unknown[]) => mocks.requestLocalExecutor(...args),
}))

vi.mock('@/lib/electron-local-file', () => ({
  readElectronLocalFile: (...args: unknown[]) => mocks.readElectronLocalFile(...args),
}))

vi.mock('@/api/fileHash', () => ({
  sha256Hex: (...args: unknown[]) => mocks.sha256Hex(...args),
}))

const plugin = {
  metadata: { name: 'dev-tools' },
  spec: {
    source: {
      pluginKey: 'dev-tools',
      marketplace: 'wework-personal',
      providerKey: 'wework-personal',
    },
    sourcePayload: {
      pluginName: 'dev-tools',
      marketplacePath: '/tmp/executor-home/capabilities/bundled-marketplaces/wework-personal',
    },
  },
} as InstalledPlugin

const artifact = {
  name: 'dev-tools.zip',
  path: '/tmp/executor-home/artifacts/personal-plugin-packages/artifact.zip',
  size: 4,
  sha256: 'a'.repeat(64),
  cleanupToken: '8e0257d3-eeb8-4a16-bd60-4f14cfb94495',
}

describe('personal plugin package artifacts', () => {
  beforeEach(() => {
    mocks.requestLocalExecutor.mockReset()
    mocks.readElectronLocalFile.mockReset()
    mocks.sha256Hex.mockReset()
    mocks.requestLocalExecutor.mockImplementation(async (method: string) => {
      if (method === 'executor.plugins.personal.ensure') {
        return {
          pluginName: 'dev-tools',
          marketplacePath: '/tmp/executor-home/capabilities/bundled-marketplaces/wework-personal',
          pluginPath:
            '/tmp/executor-home/capabilities/bundled-marketplaces/wework-personal/plugins/dev-tools',
          migrated: false,
        }
      }
      if (method === 'executor.plugins.personal.package') return artifact
      if (method === 'executor.plugins.personal.package.cleanup') return null
      throw new Error(`Unexpected method: ${method}`)
    })
    mocks.readElectronLocalFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]))
    mocks.sha256Hex.mockResolvedValue(artifact.sha256)
  })

  test('reads, verifies, and cleans up an Executor package artifact', async () => {
    const packaged = await createLocalCodexPluginApi().packageCreatedPlugin(plugin)

    expect(packaged.name).toBe('dev-tools.zip')
    expect(packaged.type).toBe('application/zip')
    expect(packaged.size).toBe(4)
    expect(mocks.readElectronLocalFile).toHaveBeenCalledWith(artifact.path, {
      expectedSize: 4,
      maxBytes: 50 * 1024 * 1024,
    })
    expect(mocks.requestLocalExecutor).toHaveBeenLastCalledWith(
      'executor.plugins.personal.package.cleanup',
      { cleanupToken: artifact.cleanupToken }
    )
  })

  test('cleanup failures do not replace a package read failure', async () => {
    mocks.readElectronLocalFile.mockRejectedValue(new Error('package read failed'))
    mocks.requestLocalExecutor.mockImplementation(async (method: string) => {
      if (method === 'executor.plugins.personal.ensure') {
        return {
          pluginName: 'dev-tools',
          marketplacePath: '/tmp/executor-home/capabilities/bundled-marketplaces/wework-personal',
          pluginPath:
            '/tmp/executor-home/capabilities/bundled-marketplaces/wework-personal/plugins/dev-tools',
          migrated: false,
        }
      }
      if (method === 'executor.plugins.personal.package') return artifact
      if (method === 'executor.plugins.personal.package.cleanup') {
        throw new Error('cleanup failed')
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(createLocalCodexPluginApi().packageCreatedPlugin(plugin)).rejects.toThrow(
      'package read failed'
    )
    expect(warn).toHaveBeenCalledWith(
      '[Wework] Failed to clean up local plugin package artifact',
      expect.objectContaining({ message: 'cleanup failed' })
    )
    warn.mockRestore()
  })

  test('cleanup failures do not discard a verified package', async () => {
    mocks.requestLocalExecutor.mockImplementation(async (method: string) => {
      if (method === 'executor.plugins.personal.ensure') {
        return {
          pluginName: 'dev-tools',
          marketplacePath: '/tmp/executor-home/capabilities/bundled-marketplaces/wework-personal',
          pluginPath:
            '/tmp/executor-home/capabilities/bundled-marketplaces/wework-personal/plugins/dev-tools',
          migrated: false,
        }
      }
      if (method === 'executor.plugins.personal.package') return artifact
      if (method === 'executor.plugins.personal.package.cleanup') {
        throw new Error('cleanup failed')
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(createLocalCodexPluginApi().packageCreatedPlugin(plugin)).resolves.toEqual(
      expect.objectContaining({ name: 'dev-tools.zip', size: 4 })
    )
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  test('rejects an oversized artifact before reading and still cleans it up', async () => {
    mocks.requestLocalExecutor.mockImplementation(async (method: string) => {
      if (method === 'executor.plugins.personal.ensure') {
        return {
          pluginName: 'dev-tools',
          marketplacePath: '/tmp/executor-home/capabilities/bundled-marketplaces/wework-personal',
          pluginPath:
            '/tmp/executor-home/capabilities/bundled-marketplaces/wework-personal/plugins/dev-tools',
          migrated: false,
        }
      }
      if (method === 'executor.plugins.personal.package') {
        return { ...artifact, size: 50 * 1024 * 1024 + 1 }
      }
      if (method === 'executor.plugins.personal.package.cleanup') return null
      throw new Error(`Unexpected method: ${method}`)
    })

    await expect(createLocalCodexPluginApi().packageCreatedPlugin(plugin)).rejects.toThrow(
      'invalid personal plugin package metadata'
    )
    expect(mocks.readElectronLocalFile).not.toHaveBeenCalled()
    expect(mocks.requestLocalExecutor).toHaveBeenLastCalledWith(
      'executor.plugins.personal.package.cleanup',
      { cleanupToken: artifact.cleanupToken }
    )
  })
})
