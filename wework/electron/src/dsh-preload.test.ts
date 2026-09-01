import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('DSH preload', () => {
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
  })
})
