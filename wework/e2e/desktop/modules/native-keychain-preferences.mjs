import { execFile } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Preserve native Keychain access while HOME keeps application and shell data isolated. */
export async function prepareNativeKeychainPreferences(
  isolatedHome,
  { platform = process.platform, environment = process.env } = {}
) {
  if (platform !== 'darwin') return
  const nativeHome = environment.HOME || homedir()
  if (!isAbsolute(isolatedHome) || !isAbsolute(nativeHome))
    throw new Error('Native Keychain preparation requires absolute Home paths')
  if ((await realpath(isolatedHome)) === (await realpath(nativeHome)))
    throw new Error('Native Keychain preferences must remain inside the isolated test Home')
  const { stdout } = await execFileAsync('/usr/bin/security', ['default-keychain', '-d', 'user'], {
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  })
  const keychain = JSON.parse(stdout.trim())
  if (typeof keychain !== 'string' || !isAbsolute(keychain))
    throw new Error('The OS session has no absolute default Keychain path')
  const preferences = join(isolatedHome, 'Library', 'Preferences')
  await mkdir(preferences, { recursive: true, mode: 0o700 })
  // Only the test Home's path preferences change. Never copy keys, unlock a
  // Keychain, change its access controls, or reset the user's native preferences.
  const options = {
    env: { ...environment, HOME: isolatedHome },
    encoding: 'utf8',
    timeout: 10_000,
  }
  await execFileAsync(
    '/usr/bin/security',
    ['default-keychain', '-d', 'user', '-s', keychain],
    options
  )
  await execFileAsync(
    '/usr/bin/security',
    ['list-keychains', '-d', 'user', '-s', keychain],
    options
  )
}
