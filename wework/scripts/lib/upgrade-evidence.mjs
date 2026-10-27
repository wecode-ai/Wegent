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
    evidence.fromVersion !== from.version ||
    evidence.toVersion !== to.version ||
    evidence.platform !== platform ||
    evidence.arch !== arch ||
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
    runId: String(runId),
    evidenceSha256: createHash('sha256').update(evidenceBytes).digest('hex'),
    upgrade: 'passed',
    rollback: 'passed',
    revoked: false,
  }
}

export function mergeUpgradePolicy(base, release, edges, target) {
  const previous = base ? validateUpgradeCatalog(base) : { releases: [], edges: [] }
  if (
    base &&
    (base.channel !== target.channel ||
      base.platform !== target.platform ||
      base.arch !== target.arch)
  )
    throw new Error('Upgrade policy target mismatch')
  const existing = previous.releases.find(item => item.version === release.version)
  if (existing && existing.sha256 !== release.sha256)
    throw new Error('A published release package is immutable')
  const edgeMap = new Map(previous.edges.map(edge => [`${edge.from}:${edge.to}`, edge]))
  for (const edge of edges) edgeMap.set(`${edge.from}:${edge.to}`, edge)
  return validateUpgradeCatalog({
    schemaVersion: 1,
    ...target,
    releases: [...previous.releases.filter(r => r.version !== release.version), release],
    edges: [...edgeMap.values()],
  })
}
