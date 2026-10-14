import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function resolveCoreProfileCompositionAssets(userDataDirectory, profileName) {
  const stamp = JSON.parse(
    await readFile(
      join(userDataDirectory, 'dsh-core', 'profiles', profileName, '.wework-runtime.json'),
      'utf8'
    )
  )
  assert.match(stamp.corePluginsFingerprint, /^[a-f0-9]{64}$/)
  return join(
    userDataDirectory,
    'managed-components',
    'composed',
    'wework-core-plugins',
    stamp.corePluginsFingerprint,
    'wework-app',
    'web',
    'assets'
  )
}
