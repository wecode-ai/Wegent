import assert from 'node:assert/strict'
import {
  mergeUpgradePolicy,
  releaseUpgradePlan,
  releaseVerificationChannels,
  upgradeSource,
  verifiedUpgradeEdge,
  verifyReleaseUpgradePlan,
} from './upgrade-evidence.mjs'
import { UPGRADE_SUITE_VERSION } from '../../e2e/desktop/upgrade-suite.mjs'

/** Freeze catalog selection once, before independent source runners start. */
export function planUpgradeShards({ catalogs, version, channel, policy, platform, arch }) {
  assert.equal(policy.schemaVersion, 1)
  for (const [name, catalog] of Object.entries(catalogs)) {
    assert.ok(['stable', 'beta'].includes(name))
    assert.equal(catalog.channel, name)
    assert.equal(catalog.platform, platform)
    assert.equal(catalog.arch, arch)
  }
  const target = { version, minSourceVersion: policy.minSourceVersion }
  const channels = releaseVerificationChannels(channel).map(selected => {
    const plan = releaseUpgradePlan(Object.values(catalogs), target, selected)
    const required = (policy.requiredDirectUpgrades?.[version] ?? []).map(source =>
      upgradeSource(selected === 'stable' ? [catalogs.stable] : Object.values(catalogs), source)
    )
    if (!plan && required.length) throw new Error('Required upgrades need published sources')
    const candidates = [plan?.baseline, plan?.previous, ...required].filter(Boolean)
    const sources = [...new Map(candidates.map(source => [source.version, source])).values()]
    return { channel: selected, plan, required, sources }
  })
  return { schemaVersion: 1, platform, arch, version, channel, policy, catalogs, channels }
}

export function validateUpgradeShardPlan(frozen, expected) {
  assert.deepEqual(
    frozen,
    planUpgradeShards({ ...expected, catalogs: frozen.catalogs }),
    'Frozen upgrade plan does not match the verification source'
  )
  return frozen
}

export function upgradeShardSelections(frozen) {
  return frozen.channels.flatMap(item =>
    (item.sources.length ? item.sources : [null]).map(source => ({
      channel: item.channel,
      source,
    }))
  )
}

/** Re-run the complete policy decision using only exact, completed shard proof. */
export async function aggregateUpgradeShards(frozen, shards, runId, approvedExclusions = []) {
  const selections = upgradeShardSelections(frozen)
  assert.equal(shards.length, selections.length, 'Missing upgrade source shard')
  const targets = shards.map(shard => shard.target)
  const target = targets[0]
  assert.equal(target.version, frozen.version)
  assert.equal(target.platform, frozen.platform)
  assert.equal(target.arch, frozen.arch)
  assert.equal(target.fixture, false)
  assert.equal(target.minSourceVersion, frozen.policy.minSourceVersion)
  for (const other of targets) assert.deepEqual(other, target, 'Target packages disagree')
  const consumed = new Set()
  const edges = new Map()
  for (const selection of selections) {
    const matching = shards.filter(
      shard =>
        shard.channel === selection.channel && shard.source?.version === selection.source?.version
    )
    assert.equal(matching.length, 1, 'Missing or duplicate upgrade source proof')
    const shard = matching[0]
    assert.equal(shard.schemaVersion, 1)
    assert.equal(shard.suiteVersion, UPGRADE_SUITE_VERSION)
    assert.equal(shard.runId, String(runId))
    assert.deepEqual(shard.source, selection.source)
    assert.ok(!consumed.has(shard))
    consumed.add(shard)
    if (!selection.source) {
      assert.equal(shard.status, 'initial')
      assert.equal(shard.evidence, null)
      continue
    }
    assert.ok(['passed', 'failed'].includes(shard.status))
    if (shard.status === 'failed') {
      assert.equal(shard.evidence, null)
      continue
    }
    assert.equal(typeof shard.evidence, 'string')
    const evidenceBytes = Buffer.from(shard.evidence)
    edges.set(
      `${selection.channel}/${selection.source.version}`,
      verifiedUpgradeEdge({
        from: selection.source,
        to: target,
        evidence: JSON.parse(shard.evidence),
        evidenceBytes,
        runId,
        suiteVersion: UPGRADE_SUITE_VERSION,
        platform: frozen.platform,
        arch: frozen.arch,
        channel: selection.channel,
      })
    )
  }
  const policies = await Promise.all(
    frozen.channels.map(async item => {
      const result = await verifyReleaseUpgradePlan(
        item.plan,
        async source => edges.get(`${item.channel}/${source.version}`) ?? null,
        item.required
      )
      return mergeUpgradePolicy(
        frozen.catalogs[item.channel] ?? null,
        { ...target, minSourceVersion: result?.minSourceVersion ?? target.version },
        result?.verified.map(verified => verified.result) ?? [],
        { channel: item.channel, platform: frozen.platform, arch: frozen.arch },
        result?.verified.map(verified => verified.source) ?? []
      )
    })
  )
  const excluded = shards
    .filter(shard => shard.status === 'failed')
    .map(shard => `${frozen.platform}/${frozen.arch}/${shard.channel}/${shard.source.version}`)
  const unapproved = excluded.filter(source => !approvedExclusions.includes(source))
  assert.equal(
    unapproved.length,
    0,
    `Baseline exclusion requires human confirmation: ${unapproved.join(', ')}. ` +
      'Review the failure diagnostics, then set approved_baseline_exclusions to these exact sources; ' +
      'failed candidates receive no upgrade edge'
  )
  return policies
}
