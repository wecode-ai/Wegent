import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { ModuleKind, transpileModule } from 'typescript'
import { describe, expect, test, vi } from 'vitest'

describe('isolated surface preload', () => {
  test('passes the profile owner through the refresh IPC boundary', async () => {
    const sourcePath = resolve(
      process.cwd(),
      basename(process.cwd()) === 'electron'
        ? 'src/isolated-surface-preload.cts'
        : 'electron/src/isolated-surface-preload.cts'
    )
    const exposeInMainWorld = vi.fn()
    const invoke = vi.fn()
    const compiled = transpileModule(await readFile(sourcePath, 'utf8'), {
      compilerOptions: { module: ModuleKind.CommonJS },
    }).outputText
    runInNewContext(compiled, {
      exports: {},
      require: () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke } }),
    })
    expect(exposeInMainWorld).toHaveBeenCalledOnce()
    const [name, credentials] = exposeInMainWorld.mock.calls[0]
    expect(name).toBe('weworkElectronCloudCredentials')
    expect(Object.keys(credentials)).toEqual(['refreshAccessToken'])
    credentials.refreshAccessToken('https://cloud.example/api', 7)
    expect(invoke).toHaveBeenCalledWith(
      'cloud-credentials:refresh-access-token',
      'https://cloud.example/api',
      7
    )
  })

  test('exposes only the cloud access token refresh capability', async () => {
    const sourcePath = resolve(
      process.cwd(),
      basename(process.cwd()) === 'electron'
        ? 'src/isolated-surface-preload.cts'
        : 'electron/src/isolated-surface-preload.cts'
    )
    const source = await readFile(sourcePath, 'utf8')

    expect(source).not.toMatch(/from\s+['"]\.\.?\//)
    expect(source).toContain("'weworkElectronCloudCredentials'")
    expect(source).toContain("'cloud-credentials:refresh-access-token'")
    expect(source).not.toContain('cloud-credentials:get-device-public-key')
    expect(source).not.toContain('cloud-credentials:claim-authorization')
    expect(source).not.toContain('cloud-credentials:clear')
    expect(source).not.toContain("'weworkElectron'")
    expect(source).not.toContain("'weworkElectronFiles'")
    expect(source).not.toContain("'weworkElectronLifecycle'")
    expect(source).not.toContain("'weworkElectronExecutionEnvironments'")
  })
})
