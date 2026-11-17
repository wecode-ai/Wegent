import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export function assertBackgroundPluginAuthPaused({ before, after, fence }) {
  assert.equal(fence.held, true, 'The target database fence is no longer held')
  assert.equal(fence.blocked, true, 'The target database fence did not block a real write')
  // Global cycle markers and delayed logs do not identify a fenced target write.
  assert.deepEqual(
    after.target,
    before.target,
    'Background authentication changed the fenced target account'
  )
}

export function hasFreshPluginAuthSuccess(log, offset, installedId, connectorSlug = 'mail') {
  let appended = log.slice(offset)
  if (offset > 0 && log[offset - 1] !== '\n') {
    appended = appended.slice(appended.indexOf('\n') + 1)
  }
  const lines = appended.split(/\r?\n/)
  lines.pop()
  return lines.some(line => {
    const event = line.match(
      /^(?:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[stdout\] )?\d{4}-\d\d-\d\d \d\d:\d\d:\d\d plugin auth automatic enrollment finished installed_plugin_id=(\d+) connector_slug=(\S+) ok=(true|false) code=\S*$/
    )
    return (
      event !== null &&
      Number(event[1]) === installedId &&
      event[2] === connectorSlug &&
      event[3] === 'true'
    )
  })
}

function recoveryContext({ before, after, installedId }) {
  const targetRows = (rows, kind) =>
    rows.filter(
      row =>
        row.kind === kind &&
        Number(row.installed_plugin_id) === installedId &&
        row.connector_slug === 'mail'
    )
  const previous = targetRows(before, 'ConnectorConnection')[0]
  const current = targetRows(after, 'ConnectorConnection')[0]
  const intents = targetRows(before, 'ConnectorMigration')
  const old = intents.length === 1 ? intents[0] : undefined
  const completed = old
    ? targetRows(after, 'ConnectorMigration').find(
        row => row.id === old.id && row.local_principal === old.local_principal
      )
    : undefined
  const grants =
    old &&
    (typeof current?.local_grants === 'string'
      ? JSON.parse(current.local_grants)
      : current?.local_grants)
  return { previous, current, intents, old, completed, grants }
}

function recoveryChecks(
  { freshTargetSuccess },
  { previous, current, intents, old, completed, grants }
) {
  return {
    freshTargetSuccess: Boolean(freshTargetSuccess),
    baselineConnectionPresent: Boolean(previous),
    currentConnectionPresent: Boolean(current),
    connectionIdUnchanged: Boolean(previous && current && current.id === previous.id),
    connectionActive: Number(current?.is_active) === 1,
    connectionConnected: current?.status === 'connected',
    credentialPresent: Number(current?.credential_present) === 1,
    singleTargetPrincipal: intents.length === 1,
    targetPrincipalPresent:
      typeof old?.local_principal === 'string' && old.local_principal.length > 0,
    targetPrincipalGranted: Boolean(old && grants?.[old.local_principal] === true),
    matchingMigrationPresent: Boolean(completed),
    migrationExport: completed?.operation === 'export',
    migrationInactive: Boolean(completed && Number(completed.is_active) === 0),
    migrationRevisionAdvanced: Boolean(
      completed && Number(completed.revision) > Number(old.revision)
    ),
    migrationGenerationAdvanced: Boolean(
      completed && (completed.name !== old.name || Number(old.is_active) === 1)
    ),
  }
}

export function isFreshPluginAuthRecovery(observation) {
  if (!observation.freshTargetSuccess) return false
  const checks = recoveryChecks(observation, recoveryContext(observation))
  return Object.values(checks).every(Boolean)
}

export function describePluginAuthRecovery(observation) {
  const context = recoveryContext(observation)
  const checks = recoveryChecks(observation, context)
  const digest = value =>
    value === undefined || value === null
      ? null
      : createHash('sha256').update(String(value)).digest('hex')
  const project = row => {
    const baseline = observation.before.find(
      candidate => candidate.id === row.id && candidate.kind === row.kind
    )
    const grants =
      typeof row.local_grants === 'string' ? JSON.parse(row.local_grants) : row.local_grants
    return {
      kind: row.kind,
      id: row.id,
      installedPluginId: row.installed_plugin_id,
      connectorSlug: row.connector_slug,
      isActive: row.is_active,
      status: row.status,
      revision: row.revision,
      operation: row.operation,
      credentialPresent: Number(row.credential_present) === 1,
      matchingPrincipalGrant: Boolean(
        context.old && grants?.[context.old.local_principal] === true
      ),
      principalHash: digest(row.local_principal),
      migrationNonceHash: row.kind === 'ConnectorMigration' ? digest(row.name) : null,
      migrationNonceChanged:
        row.kind === 'ConnectorMigration' && baseline ? row.name !== baseline.name : null,
    }
  }
  return {
    accepted: Object.values(checks).every(Boolean),
    checks,
    before: observation.before.map(project),
    after: observation.after.map(project),
  }
}

export async function readPluginAuthTarget(cloud, installedId) {
  const rows = await cloud.queryDatabase(
    `SELECT id, name, kind, is_active, SHA2(CAST(json AS CHAR), 256) AS state_hash,
     COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.installedPluginId')),
       JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.installed_plugin_id'))) AS installed_plugin_id,
     COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.connectorSlug')),
       JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.connector_slug'))) AS connector_slug,
     JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.localPrincipal')) AS local_principal,
     JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.operation')) AS operation,
     JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.status')) AS status,
     JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.revision')) AS revision,
     JSON_TYPE(JSON_EXTRACT(json, '$.spec.credential')) <> 'NULL' AS credential_present,
     JSON_EXTRACT(json, '$.spec.localGrants') AS local_grants
     FROM kinds WHERE user_id=1 AND (
       (id=%s AND namespace='default' AND kind='InstalledPlugin') OR
       (namespace='plugin-auth' AND kind='ConnectorConnection'
        AND JSON_EXTRACT(json, '$.spec.installedPluginId')=%s
        AND JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.connectorSlug'))='mail') OR
       (namespace='plugin-auth' AND kind='ConnectorMigration'
        AND JSON_EXTRACT(json, '$.spec.installed_plugin_id')=%s
        AND JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.connector_slug'))='mail'))
     ORDER BY id`,
    [installedId, installedId, installedId]
  )
  assert.equal(rows.filter(row => row.kind === 'InstalledPlugin').length, 1)
  assert.equal(rows.filter(row => row.kind === 'ConnectorConnection').length, 1)
  assert.equal(
    rows.filter(row => row.kind === 'ConnectorMigration').length,
    1,
    'The isolated native-auth fixture must have exactly one target principal'
  )
  return rows
}
