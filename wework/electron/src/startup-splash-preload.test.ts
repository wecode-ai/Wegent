import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('startup splash preload', () => {
  test('exposes only the startup recovery actions', async () => {
    const sourcePath = resolve(
      process.cwd(),
      basename(process.cwd()) === 'electron'
        ? 'src/startup-splash-preload.cts'
        : 'electron/src/startup-splash-preload.cts'
    )
    const source = await readFile(sourcePath, 'utf8')

    expect(source).not.toMatch(/from\s+['"]\.\.?\//)
    expect(source).toContain("'weworkStartupRecovery'")
    expect(source).toContain("'startup-recovery:retry'")
    expect(source).toContain("'startup-recovery:recover-workbench'")
    expect(source).toContain("'startup-recovery:reset-app-state'")
    expect(source).not.toContain('webUtils')
  })
})
