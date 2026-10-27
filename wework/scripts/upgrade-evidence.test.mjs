import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifiedUpgradeEdge, mergeUpgradePolicy, upgradeSource } from './lib/upgrade-evidence.mjs'

function input() {
  const from = { version: '1.0.0', sha256: 'a'.repeat(64) }
  const to = { version: '1.1.0', sha256: 'b'.repeat(64), minSourceVersion: '1.0.0' }
  const evidence = {
    schemaVersion: 1,
    kind: 'release',
    suiteVersion: 1,
    runId: '123',
    source: from.sha256,
    target: to.sha256,
    fromVersion: from.version,
    toVersion: to.version,
    platform: 'windows',
    arch: 'x64',
    channel: 'stable',
    upgrade: 'passed',
    rollback: 'passed',
  }
  return {
    from,
    to,
    evidence,
    evidenceBytes: JSON.stringify(evidence),
    runId: '123',
    suiteVersion: 1,
    platform: 'windows',
    arch: 'x64',
    channel: 'stable',
  }
}
test('only exact artifacts and a successful rollback grant a release edge', () => {
  assert.equal(verifiedUpgradeEdge(input()).to, '1.1.0')
  for (const change of [
    { kind: 'regression' },
    { rollback: 'not-run' },
    { platform: 'macos' },
    { channel: 'beta' },
    { source: 'c'.repeat(64) },
    { runId: '124' },
    { suiteVersion: 2 },
  ]) {
    const value = input()
    Object.assign(value.evidence, change)
    assert.throws(() => verifiedUpgradeEdge(value), /exact-package/)
  }
})
test('locally generated regression fixtures cannot become production release evidence', () => {
  const value = input()
  value.to.fixture = true
  assert.throws(() => verifiedUpgradeEdge(value), /exact-package/)
})
test('a new baseline with no incoming edges does not invent historical compatibility', () => {
  const value = {
    version: '1.1.0',
    minSourceVersion: '1.1.0',
    sha256: 'b'.repeat(64),
    url: 'https://example.com/1.1.0.tar.gz',
    bytes: 1,
    dataSchema: 1,
    readableDataSchemas: [1],
    revoked: false,
  }
  const result = mergeUpgradePolicy(null, value, [], {
    channel: 'stable',
    platform: 'windows',
    arch: 'x64',
  })
  assert.deepEqual(result.edges, [])
  assert.throws(
    () =>
      mergeUpgradePolicy(result, { ...value, sha256: 'c'.repeat(64) }, [], {
        channel: 'stable',
        platform: 'windows',
        arch: 'x64',
      }),
    /immutable/
  )
})

test('a Beta source can reach Stable only through a separately verified Stable edge', () => {
  const node = (version, sha256) => ({
    version,
    minSourceVersion: '1.0.0-beta.1',
    sha256,
    url: `https://example.com/${version}.tar.gz`,
    bytes: 1,
    dataSchema: 1,
    readableDataSchemas: [1],
    revoked: false,
  })
  const older = node('1.0.0-beta.1', 'a'.repeat(64))
  const source = node('1.0.0-beta.2', 'b'.repeat(64))
  const priorEdge = {
    from: older.version,
    to: source.version,
    fromSha256: older.sha256,
    toSha256: source.sha256,
    runId: '12',
    evidenceSha256: 'e'.repeat(64),
    upgrade: 'passed',
    rollback: 'passed',
    revoked: false,
  }
  const beta = {
    schemaVersion: 1,
    channel: 'beta',
    platform: 'windows',
    arch: 'x64',
    releases: [older, source],
    edges: [priorEdge],
  }
  const selected = upgradeSource([null, beta], source.version)
  const target = node('1.0.0', 'c'.repeat(64))
  const edge = {
    ...priorEdge,
    from: source.version,
    to: target.version,
    fromSha256: source.sha256,
    toSha256: target.sha256,
  }
  const stable = mergeUpgradePolicy(
    null,
    target,
    [edge],
    { channel: 'stable', platform: 'windows', arch: 'x64' },
    [selected]
  )
  assert.deepEqual(
    stable.releases.map(item => item.version),
    [source.version, target.version]
  )
  assert.deepEqual(stable.edges, [edge])
  assert.throws(
    () =>
      upgradeSource(
        [beta, { ...beta, releases: [{ ...source, sha256: 'f'.repeat(64) }], edges: [] }],
        source.version
      ),
    /immutable across channels/
  )
})
