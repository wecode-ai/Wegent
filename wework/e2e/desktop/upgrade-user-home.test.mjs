import assert from 'node:assert/strict'
import { basename, dirname, join, resolve, win32 } from 'node:path'
import { test } from 'node:test'
import { resolveUpgradeUserHome } from './modules/upgrade-user-home.mjs'

test('keeps default-layout fixtures inside results when native data shares the filesystem', async () => {
  const result = resolve('fixtures/result-id')
  const applicationData = resolve('native-app-data')
  assert.deepEqual(
    await resolveUpgradeUserHome(result, applicationData, async () => ({ dev: 1 })),
    {
      homePath: join(result, 'home'),
      applicationData,
      external: false,
    }
  )
})

test('uses the native-data filesystem when the checkout is on another device', async () => {
  const result = resolve('fixtures/result-id')
  const applicationData = resolve('native-app-data')
  const home = await resolveUpgradeUserHome(result, applicationData, async path => ({
    dev: path === result ? 1 : 2,
  }))
  assert.equal(home.applicationData, applicationData)
  assert.equal(home.external, true)
  assert.equal(dirname(home.homePath), join(applicationData, 'wu'))
  assert.match(basename(home.homePath), /^[a-f0-9]{16}$/)
  const other = await resolveUpgradeUserHome(`${result}-other`, applicationData, async path => ({
    dev: path === applicationData ? 2 : 1,
  }))
  assert.notEqual(other.homePath, home.homePath)
  const retained = win32.join(
    'C:\\Users\\runneradmin\\AppData\\Roaming\\wu',
    basename(home.homePath),
    '.wegent\\workbench\\wework\\default\\user-data\\releases\\slots',
    'installed-0.6.2-d96b71ee-e9e1-4e39-bbd7-069c0c35991d',
    'managed-components\\composed\\wework-core-plugins\\.content-XXXXXX'
  )
  assert.ok(
    retained.length < 248,
    `Legacy directory preparation exceeds MAX_PATH: ${retained.length}`
  )
})
