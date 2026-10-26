import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { ModuleKind, transpileModule } from 'typescript'
import { describe, expect, test, vi } from 'vitest'

async function preloadSource() {
  return readFile(
    resolve(
      process.cwd(),
      basename(process.cwd()) === 'electron'
        ? 'src/dsh-preload.cts'
        : 'electron/src/dsh-preload.cts'
    ),
    'utf8'
  )
}

describe('DSH preload', () => {
  test.each([
    [{}, false],
    [{ VITE_WEWORK_E2E: 'true' }, false],
    [{ WEWORK_E2E_CONTROL_URL: 'http://localhost' }, false],
    [{ VITE_WEWORK_E2E: 'true', WEWORK_E2E_CONTROL_URL: 'http://localhost' }, true],
  ])(
    'exposes authenticated verification only in an isolated E2E session: %j',
    async (env, enabled) => {
      const exposeInMainWorld = vi.fn()
      const invoke = vi.fn()
      const compiled = transpileModule(await preloadSource(), {
        compilerOptions: { module: ModuleKind.CommonJS },
      }).outputText
      runInNewContext(compiled, {
        exports: {},
        process: { env },
        location: { protocol: 'http:' },
        require: () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke } }),
      })
      const entry = exposeInMainWorld.mock.calls.find(
        ([name]) => name === 'weworkElectronVerification'
      )
      expect(Boolean(entry)).toBe(enabled)
      if (entry) {
        entry[1].requestRuntime({ url: 'http://127.0.0.1:3000/wework/executor/v1' })
        expect(invoke).toHaveBeenCalledWith('e2e:runtime-request', {
          url: 'http://127.0.0.1:3000/wework/executor/v1',
        })
      }
    }
  )

  test('remains self-contained for sandboxed renderers', async () => {
    const sourcePath = resolve(
      process.cwd(),
      basename(process.cwd()) === 'electron'
        ? 'src/dsh-preload.cts'
        : 'electron/src/dsh-preload.cts'
    )
    const source = await readFile(sourcePath, 'utf8')

    expect(source).not.toMatch(/from\s+['"]\.\.?\//)
    expect(source).toContain("location.protocol === 'file:'")
    expect(source).toContain("'weworkElectronCloudCredentials'")
    expect(source).toContain("'weworkElectronNetwork'")
    expect(source).toContain("'window:focus-changed'")
  })
})
