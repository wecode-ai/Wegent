import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { prepareNativeKeychainPreferences } from '../e2e/desktop/modules/native-keychain-preferences.mjs'

const execFileAsync = promisify(execFile)

test('other operating systems do not prepare macOS preferences', async () => {
  await prepareNativeKeychainPreferences('/unused', { platform: 'win32', environment: {} })
})

if (process.platform === 'darwin') {
  test('an isolated Home resolves the real Keychain without changing native preferences', async () => {
    const isolatedHome = await mkdtemp(join(tmpdir(), 'wework-keychain-preferences-'))
    const query = async (operation, environment = process.env) =>
      (
        await execFileAsync('/usr/bin/security', [operation, '-d', 'user'], {
          env: environment,
          encoding: 'utf8',
          timeout: 10_000,
        })
      ).stdout
    try {
      const before = await query('default-keychain')
      const searchList = await query('list-keychains')
      const environment = { ...process.env, HOME: isolatedHome }
      await assert.rejects(query('default-keychain', environment))
      await prepareNativeKeychainPreferences(isolatedHome)
      assert.equal(await query('default-keychain', environment), before)
      assert.equal(await query('list-keychains', environment), before)
      assert.equal(await query('default-keychain'), before)
      assert.equal(await query('list-keychains'), searchList)
      assert.ok(
        (await readFile(join(isolatedHome, 'Library/Preferences/com.apple.security.plist')))
          .length > 0
      )
    } finally {
      await rm(isolatedHome, { recursive: true, force: true })
    }
  })

  test('refuses to write preferences into the native Home', async () => {
    await assert.rejects(prepareNativeKeychainPreferences(process.env.HOME), /isolated test Home/)
  })
}
