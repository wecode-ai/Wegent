import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

test('loads the native dialog driver through Node ESM package exports', () => {
  const script = `
    import assert from 'node:assert/strict'
    const { createNativeDialogDriver } = await import('./scripts/native-dialog-driver.mjs')
    assert.equal(typeof createNativeDialogDriver, 'function')
  `

  expect(() =>
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: 'pipe',
      timeout: 10_000,
    })
  ).not.toThrow()
})
