import assert from 'node:assert/strict'
import { test } from 'node:test'
import { intervalUpgradeCatalog } from '../e2e/desktop/modules/interval-upgrade-policy.mjs'
import { planUpgrade, validateUpgradeCatalog } from '../electron/src/runtime/upgrade-policy.mjs'
import { verifiedUpgradeEdge } from './lib/upgrade-evidence.mjs'

function pairFixture() {
  const asset = (version, digit) => ({
    version,
    name: `${version}.tar.gz`,
    platform: 'macos',
    arch: 'arm64',
    sha256: digit.repeat(64),
    sourceSha: digit.repeat(40),
    bytes: 100,
    dataSchema: 1,
    readableDataSchemas: [1],
  })
  return { from: asset('1.0.0', '1'), to: asset('1.1.0-beta.2', '2') }
}

test('the real-host discovery probe requires interval inference from a different source', () => {
  const pair = pairFixture()
  const catalog = validateUpgradeCatalog(intervalUpgradeCatalog(pair, 'http://127.0.0.1'))
  assert.equal(
    catalog.edges.some(edge => edge.from === pair.to.version),
    false
  )
  assert.deepEqual(planUpgrade(catalog, pair.to.version).path, ['1.1.1'])
  catalog.edges[0].revoked = true
  assert.equal(planUpgrade(catalog, pair.to.version), null)
})

test('discovery fixture metadata cannot become production package-pair evidence', () => {
  const pair = pairFixture()
  const catalog = intervalUpgradeCatalog(pair, 'http://127.0.0.1')
  const target = catalog.releases.at(-1)
  assert.equal(target.fixture, true)
  assert.throws(
    () => verifiedUpgradeEdge({ from: pair.from, to: target, evidence: {} }),
    /requires exact-package upgrade and rollback E2E evidence/
  )
})
