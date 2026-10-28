import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('isolated surface preload', () => {
  test('uses validated desktop IPC while exposing only refresh in the cloud credential bridge', async () => {
    const sourcePath = resolve(
      process.cwd(),
      basename(process.cwd()) === 'electron'
        ? 'src/isolated-surface-preload.cts'
        : 'electron/src/isolated-surface-preload.cts'
    )
    const source = await readFile(sourcePath, 'utf8')

    expect(source).not.toMatch(/from\s+['"]\.\.?\//)
    expect(source).toContain("'weworkElectronCloudCredentials'")
    expect(source).toContain('if (process.isMainFrame)')
    expect(source).toContain("'desktop:invoke'")
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
