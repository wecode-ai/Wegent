import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
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
  assert.deepEqual(
    await resolveUpgradeUserHome(result, applicationData, async path => ({
      dev: path === result ? 1 : 2,
    })),
    {
      homePath: join(applicationData, 'wework-upgrade-test-homes/result-id'),
      applicationData,
      external: true,
    }
  )
})
