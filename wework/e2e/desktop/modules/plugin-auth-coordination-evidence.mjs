import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export function assertBackgroundPluginAuthPaused({ before, after, fence }) {
  assert.equal(fence.held, true, 'The target database fence is no longer held')
  assert.equal(fence.blocked, true, 'The target database fence did not block a real write')
  // Global cycle markers and delayed logs do not identify a fenced target write.
  assert.ok(
    isDeepStrictEqual(after.target, before.target),
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
        row => row.id === old.id && row.device_id === old.device_id
      )
    : undefined
  const decode = value => (typeof value === 'string' ? JSON.parse(value) : value)
  return {
    previous,
    current,
    intents,
    old,
    completed,
    grants: old && decode(current?.device_grants),
    binding: old && decode(old.binding),
    completedBinding: completed && decode(completed.binding),
  }
}

function recoveryChecks(
  { freshTargetSuccess, expectedDeviceId, expectedDeviceBinding },
  { previous, current, intents, old, completed, grants, binding, completedBinding }
) {
  const appRecord =
    typeof expectedDeviceId === 'string' && expectedDeviceId.match(/^app-record-([1-9]\d*)$/)
  return {
    freshTargetSuccess: Boolean(freshTargetSuccess),
    baselineConnectionPresent: Boolean(previous),
    currentConnectionPresent: Boolean(current),
    connectionIdUnchanged: Boolean(previous && current && current.id === previous.id),
    connectionActive: Number(current?.is_active) === 1,
    connectionConnected: current?.status === 'connected',
    credentialPresent: Number(current?.credential_present) === 1,
    singleTargetDevice: intents.length === 1,
    expectedAppDevice: Boolean(
      appRecord &&
      expectedDeviceBinding?.deviceRowId === Number(appRecord[1]) &&
      expectedDeviceBinding.runtimeDeviceId === expectedDeviceId &&
      typeof expectedDeviceBinding.runtimeInstanceId === 'string' &&
      expectedDeviceBinding.runtimeInstanceId.length > 0
    ),
    targetDeviceMatches: Boolean(old && old.device_id === expectedDeviceId),
    targetAppBindingValid: Boolean(binding && isDeepStrictEqual(binding, expectedDeviceBinding)),
    targetDeviceGranted: Boolean(binding && isDeepStrictEqual(grants?.[expectedDeviceId], binding)),
    matchingMigrationPresent: Boolean(completed),
    migrationBindingUnchanged: Boolean(completed && isDeepStrictEqual(completedBinding, binding)),
    migrationExport: completed?.operation === 'export',
    migrationInactive: Boolean(completed && Number(completed.is_active) === 0),
    migrationNoncePresent: Boolean(
      typeof old?.name === 'string' &&
      /^[a-f0-9]{64}$/.test(old.name) &&
      typeof completed?.name === 'string' &&
      /^[a-f0-9]{64}$/.test(completed.name)
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
  const bindingHash = value => {
    const binding = typeof value === 'string' ? JSON.parse(value) : value
    return binding
      ? digest(
          JSON.stringify([binding.deviceRowId, binding.runtimeDeviceId, binding.runtimeInstanceId])
        )
      : null
  }
  const project = row => {
    const baseline = observation.before.find(
      candidate => candidate.id === row.id && candidate.kind === row.kind
    )
    const grants =
      typeof row.device_grants === 'string' ? JSON.parse(row.device_grants) : row.device_grants
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
      matchingDeviceGrant: Boolean(
        context.binding &&
        isDeepStrictEqual(grants?.[observation.expectedDeviceId], context.binding)
      ),
      deviceHash: digest(row.device_id),
      bindingHash: bindingHash(row.binding),
      migrationNonceHash: row.kind === 'ConnectorMigration' ? digest(row.name) : null,
      migrationNonceChanged:
        row.kind === 'ConnectorMigration' && baseline ? row.name !== baseline.name : null,
    }
  }
  return {
    accepted: Object.values(checks).every(Boolean),
    expectedDeviceHash: digest(observation.expectedDeviceId),
    expectedBindingHash: bindingHash(observation.expectedDeviceBinding),
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
     JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.device_id')) AS device_id,
     JSON_EXTRACT(json, '$.spec.binding') AS binding,
     JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.operation')) AS operation,
     JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.status')) AS status,
     JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.revision')) AS revision,
     JSON_TYPE(JSON_EXTRACT(json, '$.spec.credential')) <> 'NULL' AS credential_present,
     JSON_EXTRACT(json, '$.spec.deviceGrants') AS device_grants
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
    'The isolated Socket auth fixture must have exactly one target App device'
  )
  return rows
}
