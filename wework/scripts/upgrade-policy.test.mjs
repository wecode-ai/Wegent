import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planUpgrade, validateUpgradeCatalog } from '../electron/src/runtime/upgrade-policy.mjs'

export function catalogFixture() {
  const releases = ['1.0.0', '1.1.0', '1.2.0'].map((version, i) => ({
    version,
    minSourceVersion: i === 2 ? '1.1.0' : '0.9.0',
    url: `https://example.com/${version}.zip`,
    sha256: String(i + 1).repeat(64),
    bytes: 100,
    dataSchema: 1,
    readableDataSchemas: [1],
    revoked: false,
  }))
  return {
    schemaVersion: 1,
    channel: 'stable',
    platform: 'macos',
    arch: 'arm64',
    releases,
    edges: [
      [0, 1],
      [1, 2],
    ].map(([a, b]) => ({
      from: releases[a].version,
      to: releases[b].version,
      fromSha256: releases[a].sha256,
      toSha256: releases[b].sha256,
      runId: '123',
      evidenceSha256: 'a'.repeat(64),
      upgrade: 'passed',
      rollback: 'passed',
      revoked: false,
    })),
  }
}

test('plans exact verified hops rather than using the highest version directly', () => {
  const plan = planUpgrade(catalogFixture(), '1.0.0')
  assert.deepEqual(plan.path, ['1.1.0', '1.2.0'])
  assert.equal(plan.next.version, '1.1.0')
})
test('a minimum source version alone does not grant upgrade permission', () => {
  assert.equal(planUpgrade(catalogFixture(), '0.9.5'), null)
})
test('a verified destination need not be the globally newest release', () => {
  const catalog = catalogFixture()
  catalog.edges = catalog.edges.slice(0, 1)
  assert.equal(planUpgrade(catalog, '1.0.0').targetVersion, '1.1.0')
})
test('enforces target minimum even when an edge claims to be verified', () => {
  const catalog = catalogFixture()
  catalog.releases[1].minSourceVersion = '1.0.1'
  assert.throws(() => validateUpgradeCatalog(catalog), /unverified/)
})
test('revoking a bridge stops the path; revoking an edge has the same effect', () => {
  const catalog = catalogFixture()
  catalog.releases[1].revoked = true
  assert.equal(planUpgrade(catalog, '1.0.0'), null)
  catalog.releases[1].revoked = false
  catalog.edges[0].revoked = true
  assert.equal(planUpgrade(catalog, '1.0.0'), null)
})
test('a revoked installed version can still escape along an explicitly tested edge', () => {
  const catalog = catalogFixture()
  catalog.releases[0].revoked = true
  assert.equal(planUpgrade(catalog, '1.0.0').next.version, '1.1.0')
})
test('changed package hashes and missing rollback evidence invalidate verification', () => {
  const catalog = catalogFixture()
  catalog.releases[1].sha256 = 'f'.repeat(64)
  assert.throws(() => validateUpgradeCatalog(catalog), /unverified/)
  const second = catalogFixture()
  second.edges[0].rollback = 'pending'
  assert.throws(() => validateUpgradeCatalog(second), /unverified/)
})
test('prefers a verified direct path over two hops', () => {
  const catalog = catalogFixture()
  catalog.releases[2].minSourceVersion = '1.0.0'
  catalog.edges.push({ ...catalog.edges[1], from: '1.0.0', fromSha256: catalog.releases[0].sha256 })
  assert.deepEqual(planUpgrade(catalog, '1.0.0').path, ['1.2.0'])
})
