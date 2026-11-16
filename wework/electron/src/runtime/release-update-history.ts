import { createHash } from 'node:crypto'
import type { WeworkUpdateRetryConfirmation } from '../host/app-update-progress.js'
import {
  compareVersions,
  planUpgrade,
  type UpgradeCatalog,
  type UpgradeRelease,
} from './upgrade-policy.mjs'

export interface ReleaseRollbackRecord {
  token: string
  version: string
  fromVersion?: string
  packageSha256?: string
  reason: WeworkUpdateRetryConfirmation['reason']
  occurredAt?: string
}

export function parseRollbackHistory(
  value: string | null,
  legacy: string | null
): ReleaseRollbackRecord[] {
  const records: unknown = value === null ? [] : JSON.parse(value)
  if (
    !Array.isArray(records) ||
    records.some(
      record =>
        !record ||
        typeof record.token !== 'string' ||
        typeof record.version !== 'string' ||
        !['startup-failed', 'rolled-back', 'legacy-rollback'].includes(record.reason) ||
        (record.packageSha256 !== undefined && !/^[a-f0-9]{64}$/.test(record.packageSha256))
    )
  )
    throw new Error('Invalid update rollback history')
  const versions: unknown = legacy === null ? [] : JSON.parse(legacy)
  if (!Array.isArray(versions) || versions.some(version => typeof version !== 'string'))
    throw new Error('Invalid rollback quarantine')
  const known = new Set(records.map(record => record.version))
  return [
    ...records,
    ...versions
      .filter(version => !known.has(version))
      .map(version => ({
        token: `legacy:${version}`,
        version,
        reason: 'legacy-rollback' as const,
      })),
  ]
}

/** Local failures require consent; only the published catalog can revoke an upgrade. */
export function planUpdateRetry(
  catalog: UpgradeCatalog,
  currentVersion: string,
  history: ReleaseRollbackRecord[]
) {
  const failures = history.filter(record =>
    catalog.releases.some(
      release =>
        release.version === record.version &&
        (!record.packageSha256 || record.packageSha256 === release.sha256)
    )
  )
  const blocked = new Set(failures.map(record => record.version))
  const automatic = planUpgrade(
    {
      ...catalog,
      releases: catalog.releases.map(release =>
        blocked.has(release.version) ? { ...release, revoked: true } : release
      ),
    },
    currentVersion
  )
  const available = planUpgrade(catalog, currentVersion)
  if (
    !available ||
    (automatic && compareVersions(automatic.targetVersion, available.targetVersion) >= 0)
  )
    return { plan: automatic, retryConfirmation: undefined }
  return {
    plan: available,
    retryConfirmation: releaseRetryConfirmation(catalog, currentVersion, available.next, history),
  }
}

/** Bind consent to the package being installed, independently of later published offers. */
export function releaseRetryConfirmation(
  catalog: UpgradeCatalog,
  currentVersion: string,
  target: UpgradeRelease,
  history: ReleaseRollbackRecord[]
): WeworkUpdateRetryConfirmation | undefined {
  const failure = history.find(
    record =>
      record.version === target.version &&
      (!record.packageSha256 || record.packageSha256 === target.sha256)
  )
  if (!failure) return undefined
  const token = createHash('sha256')
    .update(
      JSON.stringify({
        currentVersion,
        channel: catalog.channel,
        platform: catalog.platform,
        arch: catalog.arch,
        targetVersion: target.version,
        target: target.sha256,
        sourceSha: target.sourceSha,
        failure,
      })
    )
    .digest('hex')
  return { token, version: failure.version, reason: failure.reason }
}
