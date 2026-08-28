import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('DSH preload', () => {
  test('remains self-contained for Electron sandbox loading', async () => {
    const source = await readFile(new URL('./dsh-preload.cts', import.meta.url), 'utf8')

    expect(source).not.toMatch(/from ['"]\.\//)
    expect(source).toContain("location.protocol === 'file:'")
    expect(source).toContain("'weworkElectronCloudCredentials'")
  })
})
