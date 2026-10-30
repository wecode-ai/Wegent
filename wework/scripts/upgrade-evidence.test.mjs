import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mirrorMacosUpgradePolicies } from './mirror-macos-upgrade-policy.mjs'
import { publishedUpgradePolicies } from './lib/published-upgrade-policies.mjs'
import { planUpgrade } from '../electron/src/runtime/upgrade-policy.mjs'
import {
  mirrorMacosUpgradePolicy,
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
  assert.equal(releaseUpgradePlan([null, beta], automaticTarget, 'stable'), null)
  assert.deepEqual(releaseUpgradePlan([null, beta], automaticTarget, 'beta'), {
    baselineVersion: '0.5.13-beta.5',
    baseline: null,
    previous: beta.releases[0],
  })
  assert.deepEqual(beta.edges, [])
})

test('keeps the fixed baseline and selects the previous release of the target channel', () => {
  const stable = publishedCatalog('stable', ['0.5.13', '0.5.14', '0.6.0'])
  const beta = publishedCatalog('beta', ['0.6.1-beta.9', '0.6.1-beta.10', '0.6.0'])
  const plan = releaseUpgradePlan([stable, beta], automaticTarget, 'stable')
  assert.equal(plan.baseline.version, '0.5.13')
  assert.equal(plan.previous.version, '0.6.0')
  assert.equal(
    releaseUpgradePlan([stable, beta], automaticTarget, 'beta').previous.version,
    '0.6.1-beta.10'
  )
  stable.releases[2].minSourceVersion = '0.5.14'
  assert.equal(
    releaseUpgradePlan([stable, beta], automaticTarget, 'stable').baselineVersion,
    '0.5.14'
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
      () => releaseUpgradePlan([publishedCatalog('beta', versions)], automaticTarget, 'beta'),
      /No eligible published upgrade source/
    )
  }
  const revoked = publishedCatalog('beta', ['0.6.0'])
  revoked.releases[0].revoked = true
  assert.throws(
    () => releaseUpgradePlan([revoked], automaticTarget, 'beta'),
    /No eligible published upgrade source/
  )
})

test('the minimum is inclusive and cross-channel package identity is still enforced', () => {
  const beta = publishedCatalog('beta', ['0.5.13-beta.5'])
  const plan = releaseUpgradePlan([beta], automaticTarget, 'beta')
  assert.deepEqual(plan.baseline, beta.releases[0])
  assert.deepEqual(plan.previous, beta.releases[0])
  const stable = publishedCatalog('stable', ['0.5.13'])
  const betaStable = publishedCatalog('beta', ['0.5.13'])
  stable.releases[0].sha256 = 'b'.repeat(64)
  assert.throws(
    () => releaseUpgradePlan([stable, betaStable], automaticTarget, 'stable'),
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
  const catalog = publishedCatalog('stable', ['0.5.13', '0.6.0'])
  const plan = releaseUpgradePlan([catalog], automaticTarget, 'stable')
  const calls = []
  const result = await verifyReleaseUpgradePlan(plan, async source => {
    calls.push(source.version)
    return { from: source.version }
  })
  assert.deepEqual(calls, ['0.5.13', '0.6.0'])
  assert.equal(result.minSourceVersion, '0.5.13')
  assert.equal(result.verified.length, 2)
})

test('a failed baseline advances to the previous release and persists for the next release', async () => {
  const catalog = publishedCatalog('stable', ['0.5.13', '0.6.0'])
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
  const plan = releaseUpgradePlan([catalog], automaticTarget, 'beta')
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
    [publishedCatalog('stable', ['0.5.13'])],
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
    [publishedCatalog('stable', ['0.5.13', '0.6.0'])],
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
    assert.deepEqual(calls, ['0.5.13', '0.6.0'])
  }
})

test('infrastructure and integrity failures abort instead of being treated as compatibility failures', async () => {
  const plan = releaseUpgradePlan(
    [publishedCatalog('stable', ['0.5.13', '0.6.0'])],
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
    const catalog = publishedCatalog('stable', ['0.5.13', '0.6.0'])
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

test('a Stable source can reach Beta only through a separately verified Beta edge', () => {
  const node = (version, sha256) => ({
    version,
    minSourceVersion: '1.0.0',
    sha256,
    sourceSha: sha256.slice(0, 40),
    url: `https://example.com/${version}.tar.gz`,
    bytes: 1,
    dataSchema: 1,
    readableDataSchemas: [1],
    revoked: false,
  })
  const older = node('1.0.0', 'a'.repeat(64))
  const source = node('1.1.0', 'b'.repeat(64))
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
  const stable = {
    schemaVersion: 1,
    channel: 'stable',
    platform: 'windows',
    arch: 'x64',
    releases: [older, source],
    edges: [priorEdge],
  }
  const selected = upgradeSource([null, stable], source.version)
  const target = node('1.2.0-beta.1', 'c'.repeat(64))
  const edge = {
    ...priorEdge,
    from: source.version,
    to: target.version,
    fromSha256: source.sha256,
    toSha256: target.sha256,
    fromSourceSha: source.sourceSha,
    toSourceSha: target.sourceSha,
  }
  const beta = mergeUpgradePolicy(
    null,
    target,
    [edge],
    { channel: 'beta', platform: 'windows', arch: 'x64' },
    [selected]
  )
  assert.deepEqual(
    beta.releases.map(item => item.version),
    [source.version, target.version]
  )
  assert.deepEqual(beta.edges, [edge])
  assert.throws(
    () =>
      upgradeSource(
        [stable, { ...stable, releases: [{ ...source, sha256: 'f'.repeat(64) }], edges: [] }],
        source.version
      ),
    /immutable across channels/
  )
})

function macosMirrorFixture() {
  const arm = publishedCatalog('stable', ['0.6.0', '0.6.1'])
  arm.platform = 'macos'
  arm.arch = 'arm64'
  arm.releases[1].minSourceVersion = '0.6.0'
  arm.edges = [
    {
      from: '0.6.0',
      to: '0.6.1',
      fromSha256: arm.releases[0].sha256,
      toSha256: arm.releases[1].sha256,
      fromSourceSha: arm.releases[0].sourceSha,
      toSourceSha: arm.releases[1].sourceSha,
      runId: '123',
      evidenceSha256: 'e'.repeat(64),
      upgrade: 'passed',
      rollback: 'passed',
      revoked: false,
    },
  ]
  const x64 = structuredClone(arm)
  x64.arch = 'x64'
  x64.releases = x64.releases.slice(0, 1).map(item => ({ ...item, sha256: 'b'.repeat(64) }))
  x64.edges = []
  const release = { ...arm.releases[1], platform: 'macos', arch: 'x64', sha256: 'c'.repeat(64) }
  return { arm, x64, release }
}

test('macOS x64 mirrors arm64 paths with x64 package identities and explicit provenance', () => {
  const { arm, x64, release } = macosMirrorFixture()
  const result = mirrorMacosUpgradePolicy(arm, x64, release)
  assert.equal(result.arch, 'x64')
  assert.equal(result.releases.at(-1).minSourceVersion, '0.6.0')
  assert.deepEqual(result.edges[0], {
    ...arm.edges[0],
    fromSha256: 'b'.repeat(64),
    toSha256: 'c'.repeat(64),
    verification: {
      kind: 'architecture-equivalence',
      platform: 'macos',
      arch: 'arm64',
      fromSha256: arm.edges[0].fromSha256,
      toSha256: arm.edges[0].toSha256,
    },
  })
  assert.equal(planUpgrade(result, '0.6.0').next.sha256, release.sha256)
  assert.equal(x64.edges.length, 0)
})

test('mirroring refuses missing sources, mismatched revisions and non-macOS results', () => {
  const { arm, x64, release } = macosMirrorFixture()
  assert.throws(() => mirrorMacosUpgradePolicy(arm, null, release), /not in the verified/)
  assert.throws(
    () => mirrorMacosUpgradePolicy(arm, x64, { ...release, sourceSha: '2'.repeat(40) }),
    /same release revision/
  )
  x64.releases[0].sourceSha = '3'.repeat(40)
  assert.throws(() => mirrorMacosUpgradePolicy(arm, x64, release), /matching macOS x64 source/)
  arm.platform = 'windows'
  assert.throws(() => mirrorMacosUpgradePolicy(arm, x64, release), /same release revision/)
})

test('Beta may mirror an arm64 path whose x64 source is in Stable', () => {
  const { arm, x64, release } = macosMirrorFixture()
  arm.channel = 'beta'
  const result = mirrorMacosUpgradePolicy(arm, null, release, [x64])
  assert.equal(result.channel, 'beta')
  assert.deepEqual(planUpgrade(result, '0.6.0').path, ['0.6.1'])
})

test('mirroring does not create upgrade permission without arm64 edges', () => {
  const { arm, release } = macosMirrorFixture()
  arm.edges = []
  arm.releases[1].minSourceVersion = release.version
  const result = mirrorMacosUpgradePolicy(arm, null, release)
  assert.equal(result.edges.length, 0)
  assert.equal(planUpgrade(result, '0.6.0'), null)
})

test('revoked arm64 paths remain revoked on x64', () => {
  const { arm, x64, release } = macosMirrorFixture()
  arm.edges[0].revoked = true
  const result = mirrorMacosUpgradePolicy(arm, x64, release)
  assert.equal(planUpgrade(result, '0.6.0'), null)
})

test('release mirroring generates Stable and Beta policies without invoking E2E', async () => {
  const { arm, x64, release } = macosMirrorFixture()
  const temporary = mkdtempSync(join(tmpdir(), 'wework-mirror-policy-'))
  try {
    for (const channel of ['stable', 'beta']) {
      writeFileSync(
        join(temporary, `upgrade-policy-${channel}-macos-arm64.json`),
        JSON.stringify({ ...arm, channel })
      )
      writeFileSync(
        join(temporary, `components-${channel}-macos-x64.json`),
        JSON.stringify({ upgradePolicy: { ...x64, channel } })
      )
    }
    writeFileSync(
      join(temporary, 'release-macos-x64.json'),
      JSON.stringify({
        ...release,
        name: 'WeWorkRelease_0.6.1_macos_x64.tar.gz',
      })
    )
    const execute = (command, args) => {
      assert.equal(command, 'gh')
      assert.equal(args[0], 'release')
      assert.equal(args[args.indexOf('--repo') + 1], 'owner/repository')
      if (args[1] === 'view')
        return JSON.stringify({
          assets: ['stable', 'beta'].map(channel => ({
            name: 'components-' + channel + '-macos-x64.json',
          })),
        })
      assert.equal(args[1], 'download')
      return readFileSync(join(temporary, args[args.indexOf('--pattern') + 1]), 'utf8')
    }
    for (const channel of ['stable', 'beta']) {
      if (channel === 'beta') {
        const stable = readFileSync(join(temporary, 'upgrade-policy-stable-macos-x64.json'), 'utf8')
        rmSync(join(temporary, 'upgrade-policy-beta-macos-x64.json'))
        writeFileSync(join(temporary, 'stable-before.json'), stable)
      }
      await mirrorMacosUpgradePolicies(
        { assets: temporary, channel, repository: 'owner/repository' },
        execute
      )
      const output = JSON.parse(
        readFileSync(join(temporary, `upgrade-policy-${channel}-macos-x64.json`), 'utf8')
      )
      assert.equal(output.channel, channel)
      assert.equal(output.edges[0].verification.arch, 'arm64')
      assert.equal(output.releases.at(-1).sha256, release.sha256)
      assert.match(output.releases.at(-1).url, /WeWorkRelease_0.6.1_macos_x64.tar.gz$/)
      if (channel === 'beta')
        assert.equal(
          readFileSync(join(temporary, 'upgrade-policy-stable-macos-x64.json'), 'utf8'),
          readFileSync(join(temporary, 'stable-before.json'), 'utf8')
        )
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('architecture equivalence provenance is restricted to macOS x64', () => {
  const { arm, x64, release } = macosMirrorFixture()
  const result = mirrorMacosUpgradePolicy(arm, x64, release)
  for (const change of [
    catalog => {
      catalog.arch = 'arm64'
    },
    catalog => {
      catalog.edges[0].verification.arch = 'x64'
    },
    catalog => {
      catalog.edges[0].verification.toSha256 = ''
    },
  ]) {
    const invalid = structuredClone(result)
    change(invalid)
    assert.throws(() => planUpgrade(invalid, '0.6.0'), /Invalid macOS architecture equivalence/)
  }
})

test('mirroring preserves cross-channel immutability and revocation', () => {
  const { arm, x64, release } = macosMirrorFixture()
  const beta = structuredClone(x64)
  beta.channel = 'beta'
  beta.releases[0].revoked = true
  assert.throws(
    () => mirrorMacosUpgradePolicy(arm, x64, release, [beta]),
    /matching macOS x64 source/
  )
  beta.releases = [{ ...release, sha256: 'd'.repeat(64) }]
  assert.throws(
    () => mirrorMacosUpgradePolicy(arm, x64, release, [beta]),
    /immutable across channels/
  )
})

test('published policy reader rejects wrong targets and distinguishes absent baseline from download errors', () => {
  const catalog = publishedCatalog('stable', ['0.6.0'])
  const target = { repository: 'owner/repository', platform: 'macos', arch: 'x64' }
  const read = download => (command, args) => {
    assert.equal(command, 'gh')
    if (args[1] === 'view')
      return JSON.stringify({ assets: [{ name: 'components-stable-macos-x64.json' }] })
    return download()
  }
  assert.deepEqual(
    publishedUpgradePolicies(target, () => JSON.stringify({ assets: [] })),
    {}
  )
  assert.throws(
    () =>
      publishedUpgradePolicies(
        target,
        read(() => JSON.stringify({ upgradePolicy: catalog }))
      ),
    /target mismatch/
  )
  const failure = new Error('permission denied')
  assert.throws(
    () =>
      publishedUpgradePolicies(
        target,
        read(() => {
          throw failure
        })
      ),
    failure
  )
  assert.deepEqual(
    publishedUpgradePolicies(
      target,
      read(() => JSON.stringify({}))
    ),
    {}
  )
})

test('published policies support stdout larger than the default Node buffer', () => {
  const catalog = publishedCatalog('stable', ['0.6.0'])
  const target = { repository: 'owner/repository', platform: 'windows', arch: 'x64' }
  const execute = (command, args, options) => {
    assert.equal(command, 'gh')
    const response =
      args[1] === 'view'
        ? { assets: [{ name: 'components-stable-windows-x64.json' }] }
        : { upgradePolicy: catalog }
    return execFileSync(
      process.execPath,
      [
        '-e',
        'process.stdout.write(" ".repeat(2 * 1024 * 1024) + process.argv[1])',
        JSON.stringify(response),
      ],
      options
    )
  }
  assert.deepEqual(publishedUpgradePolicies(target, execute), { stable: catalog })
})
