import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  aggregateUpgradeShards,
  planUpgradeShards,
  upgradeShardSelections,
  validateUpgradeShardPlan,
} from './lib/upgrade-verification-shards.mjs'
import { UPGRADE_SUITE_VERSION } from '../e2e/desktop/upgrade-suite.mjs'

function fixture(required = []) {
  const release = (version, index) => ({
    version,
    minSourceVersion: '1.0.0',
    sha256: String(index).repeat(64),
    sourceSha: '1'.repeat(40),
    url: `https://example.com/${version}.tar.gz`,
    bytes: 100,
    dataSchema: 1,
    readableDataSchemas: [1],
    revoked: false,
  })
  const catalog = (channel, releases) => ({
    schemaVersion: 1,
    channel,
    platform: 'windows',
    arch: 'x64',
    releases,
    edges: [],
  })
  const stable = ['1.0.0', '1.0.1', '1.0.2'].map((version, index) => release(version, index + 1))
  const options = {
    catalogs: {
      stable: catalog('stable', stable),
      beta: catalog('beta', [...stable, release('1.0.3-beta.1', 4)]),
    },
    version: '1.1.0',
    channel: 'stable',
    policy: {
      schemaVersion: 1,
      minSourceVersion: '1.0.0',
      requiredDirectUpgrades: { '1.1.0': required },
    },
    platform: 'windows',
    arch: 'x64',
  }
  const frozen = planUpgradeShards(options)
  const target = {
    ...release('1.1.0', 5),
    platform: 'windows',
    arch: 'x64',
    fixture: false,
    sourceSha: '2'.repeat(40),
  }
  const shards = upgradeShardSelections(frozen).map(({ channel, source }) => ({
    schemaVersion: 1,
    suiteVersion: UPGRADE_SUITE_VERSION,
    runId: '123',
    channel,
    source,
    target,
    status: 'passed',
    evidence: JSON.stringify({
      schemaVersion: 1,
      kind: 'release',
      suiteVersion: UPGRADE_SUITE_VERSION,
      runId: '123',
      source: source.sha256,
      target: target.sha256,
      fromSourceSha: source.sourceSha,
      toSourceSha: target.sourceSha,
      fromVersion: source.version,
      toVersion: target.version,
      platform: 'windows',
      arch: 'x64',
      channel,
      upgrade: 'passed',
      rollback: 'passed',
      reupgrade: 'passed',
      rollbackProtection: {
        version: target.version,
        packageSha256: target.sha256,
        kind: 'confirmation-required',
        historyPreserved: true,
        downloadPrevented: true,
        retryConfirmed: true,
      },
      credentials: ['source', 'upgraded', 'rolled-back', 're-upgraded'].map((stage, index) => ({
        stage,
        format: index === 0 ? 2 : 3,
        storageVersion: index % 2 === 0 ? 2 : 3,
        modelAuthenticated: true,
        cloudDeviceSignature: true,
        ...(['upgraded', 'rolled-back'].includes(stage) ? { writeAuthenticated: true } : {}),
      })),
      manifestRecovery: {
        schemaVersion: 2,
        backup: 'manifest.json.empty-recovered',
        historicalBackup: 'manifest.json.empty-previous-upgrade',
        restarted: true,
        rolledBack: true,
      },
    }),
  }))
  return { options, frozen, shards }
}

test('freezes every baseline, previous and required source once per channel', () => {
  const { frozen, options } = fixture(['1.0.1', '1.0.2'])
  assert.deepEqual(
    frozen.channels.map(item => item.sources.map(source => source.version)),
    [
      ['1.0.0', '1.0.2', '1.0.1'],
      ['1.0.0', '1.0.3-beta.1', '1.0.1', '1.0.2'],
    ]
  )
  assert.equal(upgradeShardSelections(frozen).length, 7)
  validateUpgradeShardPlan(frozen, options)
  assert.throws(() => validateUpgradeShardPlan(frozen, { ...options, version: '1.1.1' }))
  const damaged = structuredClone(frozen)
  damaged.channels[0].sources.pop()
  assert.throws(() => validateUpgradeShardPlan(damaged, options))
})

test('reassembles complete policies from exact proof in any completion order', async () => {
  const { frozen, shards } = fixture(['1.0.1'])
  const catalogs = await aggregateUpgradeShards(frozen, shards.reverse(), '123')
  assert.deepEqual(
    catalogs.map(catalog => catalog.channel),
    ['stable', 'beta']
  )
  for (const catalog of catalogs) {
    assert.equal(catalog.edges.length, 3)
    assert.equal(
      catalog.releases.find(release => release.version === '1.1.0').minSourceVersion,
      '1.0.0'
    )
    assert.ok(
      catalog.edges.every(edge => edge.runId === '123' && edge.evidenceSha256.length === 64)
    )
  }
})

test('an incompatible optional baseline gets no edge and cannot conceal a required source failure', async () => {
  const { frozen, shards } = fixture()
  shards[0].status = 'failed'
  shards[0].evidence = null
  await assert.rejects(
    aggregateUpgradeShards(frozen, shards, '123'),
    /Baseline exclusion requires human confirmation: windows\/x64\/stable\/1.0.0/
  )
  await assert.rejects(
    aggregateUpgradeShards(frozen, shards, '123', ['macos/arm64/stable/1.0.0']),
    /human confirmation/
  )
  const approval = ['windows/x64/stable/1.0.0']
  const [stable] = await aggregateUpgradeShards(frozen, shards, '123', approval)
  assert.equal(stable.edges.length, 1)
  assert.equal(stable.edges[0].from, '1.0.2')
  assert.equal(
    stable.releases.find(release => release.version === '1.1.0').minSourceVersion,
    '1.0.2'
  )
  shards[1].status = 'failed'
  shards[1].evidence = null
  await assert.rejects(
    aggregateUpgradeShards(frozen, shards, '123', [...approval, 'windows/x64/stable/1.0.2']),
    /Previous release/
  )
  const required = fixture(['1.0.0'])
  required.shards[0].status = 'failed'
  required.shards[0].evidence = null
  await assert.rejects(
    aggregateUpgradeShards(required.frozen, required.shards, '123', approval),
    /Required direct/
  )
})

test('missing, duplicate, foreign-run, stale-suite and altered package proof cannot authorize promotion', async () => {
  for (const damage of [
    shards => shards.pop(),
    shards => {
      shards[1] = shards[0]
    },
    shards => {
      shards[0].runId = '122'
    },
    shards => {
      shards[0].suiteVersion--
    },
    shards => {
      shards[0].source = { ...shards[0].source, sha256: 'f'.repeat(64) }
    },
    shards => {
      shards[0].target = { ...shards[0].target, sha256: 'f'.repeat(64) }
    },
    shards => {
      shards[0].evidence = shards[0].evidence.replace('"upgrade":"passed"', '"upgrade":"failed"')
    },
  ]) {
    const { frozen, shards } = fixture()
    damage(shards)
    await assert.rejects(aggregateUpgradeShards(frozen, shards, '123'))
  }
})

test('an initial protocol release has explicit source-free shards and generates no edges', async () => {
  const { options } = fixture()
  const frozen = planUpgradeShards({ ...options, catalogs: {} })
  const target = fixture().shards[0].target
  const shards = upgradeShardSelections(frozen).map(({ channel, source }) => ({
    schemaVersion: 1,
    suiteVersion: UPGRADE_SUITE_VERSION,
    runId: '123',
    channel,
    source,
    target,
    status: 'initial',
    evidence: null,
  }))
  const catalogs = await aggregateUpgradeShards(frozen, shards, '123')
  assert.equal(catalogs.length, 2)
  assert.ok(
    catalogs.every(
      catalog =>
        catalog.edges.length === 0 && catalog.releases[0].minSourceVersion === target.version
    )
  )
})

test('the aggregation CLI requires both platforms and writes every channel policy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wework-upgrade-shards-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const plans = join(root, 'plans')
  const reports = join(root, 'reports')
  const output = join(root, 'policies')
  await mkdir(plans)
  await mkdir(reports)
  const policy = JSON.parse(
    await readFile(new URL('../upgrade-policy.json', import.meta.url), 'utf8')
  )
  const f = fixture()
  for (const [platform, arch] of [
    ['windows', 'x64'],
    ['macos', 'arm64'],
  ]) {
    const catalogs = Object.fromEntries(
      Object.entries(f.options.catalogs).map(([channel, catalog]) => [
        channel,
        { ...catalog, platform, arch },
      ])
    )
    const frozen = planUpgradeShards({ ...f.options, catalogs, policy, platform, arch })
    await writeFile(join(plans, `${platform}.json`), JSON.stringify(frozen))
    for (const [index, original] of f.shards.entries()) {
      const evidence = { ...JSON.parse(original.evidence), platform, arch }
      const shard = {
        ...original,
        target: { ...original.target, platform, arch, minSourceVersion: policy.minSourceVersion },
        evidence: JSON.stringify(evidence),
      }
      await writeFile(
        join(reports, `upgrade-shard-${platform}-${index}.json`),
        JSON.stringify(shard)
      )
    }
  }
  const run = (approval = '') =>
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./aggregate-release-upgrades.mjs', import.meta.url)),
        plans,
        reports,
        output,
      ],
      {
        env: {
          ...process.env,
          GITHUB_RUN_ID: '123',
          WEWORK_UPGRADE_VERSION: f.options.version,
          WEWORK_UPGRADE_CHANNEL: f.options.channel,
          WEWORK_APPROVED_BASELINE_EXCLUSIONS: approval,
        },
        stdio: 'pipe',
      }
    )
  run()
  assert.deepEqual((await readdir(output)).sort(), [
    'upgrade-policy-beta-macos-arm64.json',
    'upgrade-policy-beta-windows-x64.json',
    'upgrade-policy-stable-macos-arm64.json',
    'upgrade-policy-stable-windows-x64.json',
  ])
  const rejected = join(reports, 'upgrade-shard-macos-0.json')
  const shard = JSON.parse(await readFile(rejected, 'utf8'))
  await writeFile(rejected, JSON.stringify({ ...shard, status: 'failed', evidence: null }))
  assert.throws(run, /Baseline exclusion requires human confirmation/)
  run('macos/arm64/stable/1.0.0')
  const stable = JSON.parse(
    await readFile(join(output, 'upgrade-policy-stable-macos-arm64.json'), 'utf8')
  )
  assert.deepEqual(
    stable.edges.map(edge => edge.from),
    ['1.0.2']
  )
  assert.equal(stable.releases.at(-1).minSourceVersion, '1.0.2')
  await rm(join(reports, 'upgrade-shard-macos-0.json'))
  assert.throws(run, /Missing upgrade source shard/)
})
