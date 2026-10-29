import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planUpgrade } from '../electron/src/runtime/upgrade-policy.mjs'
import {
  verifiedUpgradeEdge,
  mergeUpgradePolicy,
  releaseUpgradePlan,
  verifyReleaseUpgradePlan,
  upgradeSource,
} from './lib/upgrade-evidence.mjs'

function publishedCatalog(channel, versions) {
  return {
    schemaVersion: 1,
    channel,
    platform: 'windows',
    arch: 'x64',
    releases: versions.map(version => ({
      version,
      minSourceVersion: '0.5.0',
      sha256: 'a'.repeat(64),
      sourceSha: '1'.repeat(40),
      url: `https://example.com/${version}.tar.gz`,
      bytes: 100,
      dataSchema: 1,
      readableDataSchemas: [1],
      revoked: false,
    })),
    edges: [],
  }
}

const automaticTarget = { version: '0.6.1', minSourceVersion: '0.5.13-beta.5' }

test('release sources are automatic even when only the Beta catalog has history', () => {
  const beta = publishedCatalog('beta', ['0.5.13-beta.8'])
  assert.deepEqual(releaseUpgradePlan([null, beta], automaticTarget, 'stable'), {
    baselineVersion: '0.5.13-beta.5',
    baseline: null,
    previous: beta.releases[0],
  })
  assert.deepEqual(beta.edges, [])
})

test('keeps the fixed baseline and selects the previous release of the target channel', () => {
  const stable = publishedCatalog('stable', ['0.5.13-beta.5', '0.5.13', '0.6.0'])
  const beta = publishedCatalog('beta', ['0.6.1-beta.9', '0.6.1-beta.10', '0.6.0'])
  const plan = releaseUpgradePlan([stable, beta], automaticTarget, 'stable')
  assert.equal(plan.baseline.version, '0.5.13-beta.5')
  assert.equal(plan.previous.version, '0.6.0')
  assert.equal(
    releaseUpgradePlan([stable, beta], automaticTarget, 'beta').previous.version,
    '0.6.1-beta.10'
  )
  stable.releases[2].minSourceVersion = '0.5.13'
  assert.equal(
    releaseUpgradePlan([stable, beta], automaticTarget, 'stable').baselineVersion,
    '0.5.13'
  )
})

test('selection excludes the target, future versions, revoked releases and fixtures', () => {
  const beta = publishedCatalog('beta', [
    '0.6.0-beta.1',
    '0.6.0-beta.2',
    '0.6.0-beta.3',
    '0.6.1',
    '0.6.2',
  ])
  beta.releases[1].revoked = true
  beta.releases[2].fixture = true
  assert.deepEqual(releaseUpgradePlan([beta], automaticTarget, 'beta').previous, beta.releases[0])
})

test('revocation in either channel excludes that source in both channels', () => {
  const stable = publishedCatalog('stable', ['0.5.13', '0.6.0'])
  const beta = publishedCatalog('beta', ['0.6.0'])
  beta.releases[0].revoked = true
  assert.deepEqual(
    releaseUpgradePlan([stable, beta], automaticTarget, 'stable').previous,
    stable.releases[0]
  )
})

test('only an initial or identical baseline permits no sources', () => {
  assert.equal(releaseUpgradePlan([], automaticTarget, 'stable'), null)
  assert.equal(releaseUpgradePlan([publishedCatalog('beta', [])], automaticTarget, 'stable'), null)
  assert.deepEqual(
    releaseUpgradePlan([publishedCatalog('beta', ['0.6.1'])], automaticTarget, 'stable'),
    null
  )
  for (const versions of [['0.5.13-beta.4'], ['0.6.2']]) {
    assert.throws(
      () => releaseUpgradePlan([publishedCatalog('beta', versions)], automaticTarget, 'stable'),
      /No eligible published upgrade source/
    )
  }
  const revoked = publishedCatalog('beta', ['0.6.0'])
  revoked.releases[0].revoked = true
  assert.throws(
    () => releaseUpgradePlan([revoked], automaticTarget, 'stable'),
    /No eligible published upgrade source/
  )
})

test('the minimum is inclusive and cross-channel package identity is still enforced', () => {
  const beta = publishedCatalog('beta', ['0.5.13-beta.5'])
  const plan = releaseUpgradePlan([beta], automaticTarget, 'stable')
  assert.deepEqual(plan.baseline, beta.releases[0])
  assert.deepEqual(plan.previous, beta.releases[0])
  const stable = publishedCatalog('stable', ['0.5.13-beta.5'])
  stable.releases[0].sha256 = 'b'.repeat(64)
  assert.throws(
    () => releaseUpgradePlan([stable, beta], automaticTarget, 'stable'),
    /immutable across channels/
  )
})

test('invalid catalogs or target floors fail rather than creating a baseline', () => {
  assert.throws(
    () => releaseUpgradePlan([{ schemaVersion: 2 }], automaticTarget, 'stable'),
    /Invalid Wework upgrade catalog/
  )
  assert.throws(
    () => releaseUpgradePlan([], { ...automaticTarget, minSourceVersion: '0.6.2' }, 'stable'),
    /minimum upgrade source cannot be newer/
  )
  assert.throws(
    () => releaseUpgradePlan([], { ...automaticTarget, minSourceVersion: undefined }, 'stable'),
    /Unsupported Wework version/
  )
})

test('both fixed baseline and previous release are verified before retaining the baseline', async () => {
  const catalog = publishedCatalog('stable', ['0.5.13-beta.5', '0.6.0'])
  const plan = releaseUpgradePlan([catalog], automaticTarget, 'stable')
  const calls = []
  const result = await verifyReleaseUpgradePlan(plan, async source => {
    calls.push(source.version)
    return { from: source.version }
  })
  assert.deepEqual(calls, ['0.5.13-beta.5', '0.6.0'])
  assert.equal(result.minSourceVersion, '0.5.13-beta.5')
  assert.equal(result.verified.length, 2)
})

test('a failed baseline advances to the previous release and persists for the next release', async () => {
  const catalog = publishedCatalog('stable', ['0.5.13-beta.5', '0.6.0'])
  const plan = releaseUpgradePlan([catalog], automaticTarget, 'stable')
  const result = await verifyReleaseUpgradePlan(plan, async source =>
    source.version === plan.baselineVersion ? null : { from: source.version }
  )
  assert.equal(result.minSourceVersion, '0.6.0')
  assert.deepEqual(
    result.verified.map(item => item.source.version),
    ['0.6.0']
  )
  catalog.releases.push({
    ...catalog.releases[1],
    version: automaticTarget.version,
    minSourceVersion: result.minSourceVersion,
  })
  const next = releaseUpgradePlan([catalog], { ...automaticTarget, version: '0.6.2' }, 'stable')
  assert.equal(next.baselineVersion, '0.6.0')
  assert.equal(next.previous.version, '0.6.1')
})

test('a missing historical baseline verifies the previous release rather than inventing an edge', async () => {
  const catalog = publishedCatalog('beta', ['0.5.13-beta.8'])
  const plan = releaseUpgradePlan([catalog], automaticTarget, 'stable')
  const calls = []
  const result = await verifyReleaseUpgradePlan(plan, async source => {
    calls.push(source.version)
    return { from: source.version }
  })
  assert.deepEqual(calls, ['0.5.13-beta.8'])
  assert.equal(result.minSourceVersion, '0.5.13-beta.8')
})

test('a shared baseline and previous release are tested exactly once', async () => {
  const plan = releaseUpgradePlan(
    [publishedCatalog('stable', ['0.5.13-beta.5'])],
    automaticTarget,
    'stable'
  )
  let calls = 0
  const result = await verifyReleaseUpgradePlan(plan, async () => {
    calls++
    return { passed: true }
  })
  assert.equal(calls, 1)
  assert.equal(result.verified.length, 1)
})

test('a failed previous release blocks publication regardless of the baseline result', async () => {
  const plan = releaseUpgradePlan(
    [publishedCatalog('stable', ['0.5.13-beta.5', '0.6.0'])],
    automaticTarget,
    'stable'
  )
  for (const baselinePasses of [true, false]) {
    const calls = []
    await assert.rejects(
      verifyReleaseUpgradePlan(plan, async source => {
        calls.push(source.version)
        return source.version === plan.baselineVersion && baselinePasses ? { passed: true } : null
      }),
      /Previous release upgrade and rollback verification failed/
    )
    assert.deepEqual(calls, ['0.5.13-beta.5', '0.6.0'])
  }
})

test('infrastructure and integrity failures abort instead of being treated as compatibility failures', async () => {
  const plan = releaseUpgradePlan(
    [publishedCatalog('stable', ['0.5.13-beta.5', '0.6.0'])],
    automaticTarget,
    'stable'
  )
  let calls = 0
  await assert.rejects(
    verifyReleaseUpgradePlan(plan, async () => {
      calls++
      throw new Error('Package checksum mismatch')
    }),
    /Package checksum mismatch/
  )
  assert.equal(calls, 1)
  assert.equal(
    await verifyReleaseUpgradePlan(null, async () => assert.fail('Unexpected verification')),
    null
  )
})

test('generated policies keep the previous client upgradeable and carry X into the next release', async () => {
  for (const baselinePasses of [true, false]) {
    const catalog = publishedCatalog('stable', ['0.5.13-beta.5', '0.6.0'])
    const plan = releaseUpgradePlan([catalog], automaticTarget, 'stable')
    const target = {
      ...catalog.releases[1],
      ...automaticTarget,
      sha256: 'b'.repeat(64),
      sourceSha: '2'.repeat(40),
    }
    const result = await verifyReleaseUpgradePlan(plan, async source => {
      if (!baselinePasses && source.version === plan.baselineVersion) return null
      const evidence = {
        ...input().evidence,
        source: source.sha256,
        target: target.sha256,
        fromVersion: source.version,
        toVersion: target.version,
        fromSourceSha: source.sourceSha,
        toSourceSha: target.sourceSha,
      }
      return verifiedUpgradeEdge({
        ...input(),
        from: source,
        to: target,
        evidence,
        evidenceBytes: JSON.stringify(evidence),
      })
    })
    const merged = mergeUpgradePolicy(
      catalog,
      { ...target, minSourceVersion: result.minSourceVersion },
      result.verified.map(item => item.result),
      { channel: 'stable', platform: 'windows', arch: 'x64' },
      result.verified.map(item => item.source)
    )
    assert.equal(planUpgrade(merged, '0.6.0').targetVersion, target.version)
    assert.equal(Boolean(planUpgrade(merged, plan.baselineVersion)), baselinePasses)
    const next = releaseUpgradePlan([merged], { ...automaticTarget, version: '0.6.2' }, 'stable')
    assert.equal(next.baselineVersion, result.minSourceVersion)
    assert.equal(next.previous.version, target.version)
  }
})

function input() {
  const from = { version: '1.0.0', sha256: 'a'.repeat(64), sourceSha: '1'.repeat(40) }
  const to = {
    version: '1.1.0',
    sha256: 'b'.repeat(64),
    sourceSha: '2'.repeat(40),
    minSourceVersion: '1.0.0',
  }
  const evidence = {
    schemaVersion: 1,
    kind: 'release',
    suiteVersion: 1,
    runId: '123',
    source: from.sha256,
    target: to.sha256,
    fromSourceSha: from.sourceSha,
    toSourceSha: to.sourceSha,
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
    { fromSourceSha: 'f'.repeat(40) },
    { toSourceSha: undefined },
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
    sourceSha: '2'.repeat(40),
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
    sourceSha: sha256.slice(0, 40),
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
    fromSourceSha: older.sourceSha,
    toSourceSha: source.sourceSha,
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
    fromSourceSha: source.sourceSha,
    toSourceSha: target.sourceSha,
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
