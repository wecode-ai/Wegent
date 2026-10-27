import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifiedUpgradeEdge, mergeUpgradePolicy } from './lib/upgrade-evidence.mjs'

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
  }
}
test('only exact artifacts and a successful rollback grant a release edge', () => {
  assert.equal(verifiedUpgradeEdge(input()).to, '1.1.0')
  for (const change of [
    { kind: 'regression' },
    { rollback: 'not-run' },
    { platform: 'macos' },
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
