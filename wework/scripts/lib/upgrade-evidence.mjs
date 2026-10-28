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
    throw new Error(`The authored source ${version} is not in the verified release policy`)
  if (candidates.some(release => release.sha256 !== candidates[0].sha256))
    throw new Error('A published release package is immutable across channels')
  return candidates[0]
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
