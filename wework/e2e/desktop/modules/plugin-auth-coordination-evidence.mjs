import assert from 'node:assert/strict'

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

export function isFreshPluginAuthRecovery({ before, after, freshTargetSuccess, installedId }) {
  if (!freshTargetSuccess) return false
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
  if (intents.length !== 1) return false
  const old = intents[0]
  const completed = targetRows(after, 'ConnectorMigration').find(
    row => row.id === old.id && row.local_principal === old.local_principal
  )
  const grants =
    typeof current?.local_grants === 'string'
      ? JSON.parse(current.local_grants)
      : current?.local_grants
  return Boolean(
    previous &&
    current &&
    current.id === previous.id &&
    Number(current.is_active) === 1 &&
    current.status === 'connected' &&
    Number(current.credential_present) === 1 &&
    typeof old.local_principal === 'string' &&
    old.local_principal.length > 0 &&
    grants?.[old.local_principal] === true &&
    completed &&
    completed.operation === 'export' &&
    Number(completed.is_active) === 0 &&
    Number(completed.revision) > Number(old.revision) &&
    (completed.name !== old.name || Number(old.is_active) === 1)
  )
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
