import { createHash } from 'node:crypto'
import {
  compareVersions,
  validateUpgradeCatalog,
} from '../../electron/src/runtime/upgrade-policy.mjs'

/** Production promotion accepts exact delivered packages, never regression fixture results. */
export function verifiedUpgradeEdge({
  from,
  to,
  evidence,
  evidenceBytes,
  runId,
  suiteVersion,
  platform,
  arch,
  channel,
}) {
  if (
    from.fixture ||
    to.fixture ||
    evidence.kind !== 'release' ||
    evidence.schemaVersion !== 1 ||
    evidence.suiteVersion !== suiteVersion ||
    evidence.runId !== String(runId) ||
    !/^[1-9]\d*$/.test(String(runId)) ||
    evidence.source !== from.sha256 ||
    evidence.target !== to.sha256 ||
    !/^[a-f0-9]{40,64}$/.test(from.sourceSha) ||
    !/^[a-f0-9]{40,64}$/.test(to.sourceSha) ||
    evidence.fromSourceSha !== from.sourceSha ||
    evidence.toSourceSha !== to.sourceSha ||
    evidence.fromVersion !== from.version ||
    evidence.toVersion !== to.version ||
    evidence.platform !== platform ||
    evidence.arch !== arch ||
    evidence.channel !== channel ||
    evidence.upgrade !== 'passed' ||
    evidence.rollback !== 'passed' ||
    compareVersions(from.version, to.version) >= 0 ||
    compareVersions(from.version, to.minSourceVersion) < 0
  ) {
    throw new Error('Upgrade promotion requires exact-package upgrade and rollback E2E evidence')
  }
  return {
    from: from.version,
    to: to.version,
    fromSha256: from.sha256,
    toSha256: to.sha256,
    fromSourceSha: from.sourceSha,
    toSourceSha: to.sourceSha,
    runId: String(runId),
    evidenceSha256: createHash('sha256').update(evidenceBytes).digest('hex'),
    upgrade: 'passed',
    rollback: 'passed',
    revoked: false,
  }
}

export function upgradeSource(catalogs, version) {
  const candidates = catalogs
    .filter(Boolean)
    .map(validateUpgradeCatalog)
    .flatMap(catalog => catalog.releases.filter(release => release.version === version))
  if (!candidates.length)
    throw new Error(`The source ${version} is not in the verified release policy`)
  if (candidates.some(release => release.sha256 !== candidates[0].sha256))
    throw new Error('A published release package is immutable across channels')
  return candidates[0]
}

/** Select candidates automatically; only real-package E2E may authorize their edges. */
export function releaseUpgradePlan(catalogs, target, channel) {
  if (compareVersions(target.minSourceVersion, target.version) > 0)
    throw new Error('The minimum upgrade source cannot be newer than the target')
  const published = catalogs.filter(Boolean).map(validateUpgradeCatalog)
  const selectedCatalogs =
    channel === 'stable' ? published.filter(catalog => catalog.channel === 'stable') : published
  const blocked = new Set(
    published.flatMap(catalog =>
      catalog.releases
        .filter(release => release.revoked || release.fixture)
        .map(release => release.version)
    )
  )
  const eligible = releases =>
    releases
      .filter(
        release =>
          !blocked.has(release.version) &&
          compareVersions(release.version, target.version) < 0 &&
          compareVersions(release.version, target.minSourceVersion) >= 0
      )
      .sort((left, right) => compareVersions(right.version, left.version))
  const previous =
    eligible(selectedCatalogs.find(catalog => catalog.channel === channel)?.releases ?? [])[0] ??
    eligible(selectedCatalogs.flatMap(catalog => catalog.releases))[0]
  if (
    !previous &&
    selectedCatalogs.some(catalog =>
      catalog.releases.some(release => release.version !== target.version)
    )
  )
    throw new Error(
      `No eligible published upgrade source for ${target.version} (minimum ${target.minSourceVersion})`
    )
  if (!previous) return null
  const declaredBaseline =
    compareVersions(previous.minSourceVersion, target.minSourceVersion) >= 0
      ? previous.minSourceVersion
      : target.minSourceVersion
  const baselineVersion =
    channel === 'stable' ? declaredBaseline.replace(/-beta\.\d+$/, '') : declaredBaseline
  const baseline = selectedCatalogs.some(catalog =>
    catalog.releases.some(release => release.version === baselineVersion)
  )
  const sourceForChannel = version => {
    upgradeSource(published, version)
    return upgradeSource(selectedCatalogs, version)
  }
  return {
    baselineVersion,
    baseline: baseline && !blocked.has(baselineVersion) ? sourceForChannel(baselineVersion) : null,
    previous: sourceForChannel(previous.version),
  }
}

/** The previous release must stay upgradeable even when the fixed baseline passes. */
export async function verifyReleaseUpgradePlan(plan, verify) {
  if (!plan) return null
  const baselineResult = plan.baseline ? await verify(plan.baseline) : null
  const previousResult =
    plan.baseline?.version === plan.previous.version ? baselineResult : await verify(plan.previous)
  if (!previousResult)
    throw new Error(
      'Previous release upgrade and rollback verification failed; publication blocked'
    )
  const verified = baselineResult ? [{ source: plan.baseline, result: baselineResult }] : []
  if (!baselineResult || plan.baseline.version !== plan.previous.version)
    verified.push({ source: plan.previous, result: previousResult })
  return {
    minSourceVersion: baselineResult ? plan.baselineVersion : plan.previous.version,
    verified,
  }
}

export function mergeUpgradePolicy(base, release, edges, target, sources = []) {
  const previous = base ? validateUpgradeCatalog(base) : { releases: [], edges: [] }
  if (
    base &&
    (base.channel !== target.channel ||
      base.platform !== target.platform ||
      base.arch !== target.arch)
  )
    throw new Error('Upgrade policy target mismatch')
  const nodes = new Map(previous.releases.map(item => [item.version, item]))
  for (const source of sources) {
    const existingSource = nodes.get(source.version)
    if (existingSource && existingSource.sha256 !== source.sha256)
      throw new Error('A published release package is immutable across channels')
    if (!existingSource) nodes.set(source.version, source)
  }
  const existing = nodes.get(release.version)
  if (existing && existing.sha256 !== release.sha256)
    throw new Error('A published release package is immutable')
  const edgeMap = new Map(previous.edges.map(edge => [`${edge.from}:${edge.to}`, edge]))
  for (const edge of edges) edgeMap.set(`${edge.from}:${edge.to}`, edge)
  nodes.set(release.version, release)
  return validateUpgradeCatalog({
    schemaVersion: 1,
    ...target,
    releases: [...nodes.values()],
    edges: [...edgeMap.values()],
  })
}

/** macOS x64 adopts arm64 paths with explicit cross-architecture provenance. */
export function mirrorMacosUpgradePolicy(armPolicy, x64Policy, release, otherPolicies = []) {
  validateUpgradeCatalog(armPolicy)
  const x64Policies = [x64Policy, ...otherPolicies].filter(Boolean)
  for (const policy of x64Policies) {
    validateUpgradeCatalog(policy)
    if (policy.platform !== 'macos' || policy.arch !== 'x64')
      throw new Error('Architecture equivalence requires macOS x64 source catalogs')
  }
  const armTarget = armPolicy.releases.find(item => item.version === release.version)
  if (
    armPolicy.platform !== 'macos' ||
    armPolicy.arch !== 'arm64' ||
    release.platform !== 'macos' ||
    release.arch !== 'x64' ||
    !armTarget ||
    armTarget.fixture ||
    armTarget.revoked ||
    release.fixture ||
    armTarget.sourceSha !== release.sourceSha
  )
    throw new Error('macOS architecture equivalence requires the same release revision')
  const target = { channel: armPolicy.channel, platform: 'macos', arch: 'x64' }
  const published = x64Policies.flatMap(policy => policy.releases)
  if (published.some(item => item.version === release.version && item.sha256 !== release.sha256))
    throw new Error('A published release package is immutable across channels')
  const sources = []
  const edges = armPolicy.edges
    .filter(edge => edge.to === release.version)
    .map(edge => {
      const source = upgradeSource(x64Policies, edge.from)
      if (
        published.some(item => item.version === source.version && (item.revoked || item.fixture)) ||
        source.sourceSha !== edge.fromSourceSha
      )
        throw new Error(`Missing matching macOS x64 source release: ${edge.from}`)
      sources.push(source)
      return {
        ...edge,
        fromSha256: source.sha256,
        toSha256: release.sha256,
        verification: {
          kind: 'architecture-equivalence',
          platform: 'macos',
          arch: 'arm64',
          fromSha256: edge.fromSha256,
          toSha256: edge.toSha256,
        },
      }
    })
  return mergeUpgradePolicy(
    x64Policy,
    { ...release, minSourceVersion: armTarget.minSourceVersion, revoked: false },
    edges,
    target,
    sources
  )
}
