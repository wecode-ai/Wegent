import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { holdPluginCoordinationFault } from './plugin-write-lease.mjs'
import { until } from './plugin-regression-fixture.mjs'

// Exercise the desktop IPC, real Executor broker and account adapter. Only the
// synthetic credential provider is gated; backend responses are never replaced.
export async function verifyPluginAuthCoordination({
  cloud,
  control,
  slug,
  homePath,
  installedId,
  connectionFor,
  signalAutomaticRetry,
  reconcileMarker,
  resultDir,
  timeoutMs,
}) {
  const evidence = []
  const auth = async (action, sessionId) =>
    JSON.parse(
      await control.command('localConnectorAuth', 'body', {
        value: JSON.stringify({ pluginKey: slug, connectorSlug: 'mail', action, sessionId }),
      })
    )
  const login = async expectedError => {
    const startedAt = Date.now()
    const session = await auth('start')
    const result = await until(
      () => auth('poll', session.sessionId),
      value => ['ok', 'error'].includes(value.status),
      'Desktop login did not finish before the client timeout',
      14_000
    )
    assert.ok(Date.now() - startedAt < 15_000, 'Desktop login exceeded the client timeout')
    if (expectedError) {
      assert.equal(result.status, 'error')
      assert.match(result.hint, new RegExp(expectedError))
    } else {
      assert.equal(result.status, 'ok', result.hint)
      await signalAutomaticRetry()
      await until(
        () => connectionFor('mail'),
        value => value?.status === 'connected' && value.device_ids.length > 0,
        'Explicit login did not register a real credential',
        14_000
      )
      assert.ok(
        Date.now() - startedAt < 15_000,
        'Credential enrollment exceeded the client timeout'
      )
    }
  }
  const logout = async () => {
    const startedAt = Date.now()
    assert.equal((await auth('logout')).status, 'ok')
    assert.ok(Date.now() - startedAt < 15_000, 'Desktop logout exceeded the client timeout')
  }
  const snapshot = () =>
    cloud.queryDatabase(
      `SELECT id, kind, is_active, SHA2(CAST(json AS CHAR), 256) AS digest
       FROM kinds WHERE user_id = %s AND namespace = 'plugin-auth'
       AND (kind = 'ConnectorLocalAuthPolicy' OR
         (kind = 'ConnectorConnection' AND
          JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.connectorSlug')) = 'mail') OR
         (kind = 'ConnectorMigration' AND
          JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.connector_slug')) = 'mail'))
       ORDER BY id`,
      [1]
    )
  const assertRevoked = async () => {
    assert.equal((await connectionFor('mail'))?.status, 'disconnected')
    const rows = await cloud.queryDatabase(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.status')) AS status,
       JSON_TYPE(JSON_EXTRACT(json, '$.spec.credential')) = 'NULL' AS credential_cleared,
       JSON_LENGTH(JSON_EXTRACT(json, '$.spec.deviceGrants')) AS grants
       FROM kinds WHERE user_id = %s AND namespace = 'plugin-auth'
       AND kind = 'ConnectorConnection'
       AND JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.connectorSlug')) = 'mail'`,
      [1]
    )
    assert.ok(rows.length > 0)
    assert.ok(
      rows.every(
        row => row.status === 'disconnected' && row.credential_cleared === 1 && row.grants === 0
      )
    )
  }

  await logout()
  const rowLock = await holdPluginCoordinationFault(cloud, 'user-row')
  try {
    await login()
    await logout()
    await assertRevoked()
    evidence.push({ case: 'login-and-logout-complete-while-users-row-is-locked', installedId })
  } finally {
    await rowLock.release()
  }

  for (const [mode, code] of [
    ['lease', 'plugin_write_busy'],
    ['redis-unavailable', 'plugin_write_unavailable'],
  ]) {
    let fault = await holdPluginCoordinationFault(cloud, mode)
    try {
      const before = await snapshot()
      await login(code)
      assert.deepEqual(await snapshot(), before, 'Rejected login changed account state')
    } finally {
      await fault.release()
    }
    await login()
    fault = await holdPluginCoordinationFault(cloud, mode)
    try {
      const before = await snapshot()
      await assert.rejects(() => auth('logout'), new RegExp(code))
      assert.deepEqual(await snapshot(), before, 'Rejected logout changed account state')
    } finally {
      await fault.release()
    }
    await logout()
    await assertRevoked()
    evidence.push({ case: `${mode}-rejects-auth-and-logout-with-explicit-recovery` })
  }

  const gate = join(homePath, 'account-auth-export-held')
  const inflight = join(homePath, 'account-auth-export-inflight')
  await rm(inflight, { force: true })
  await writeFile(gate, 'hold synthetic export')
  try {
    const session = await auth('start')
    await until(
      () => auth('poll', session.sessionId),
      value => value.status === 'ok',
      'Login did not create the enrollment intent'
    )
    await signalAutomaticRetry()
    await until(
      () =>
        readFile(inflight, 'utf8').catch(error => {
          if (error.code === 'ENOENT') return null
          throw error
        }),
      Boolean,
      'The real adapter did not reach its credential export fence'
    )
    const before = await readFile(reconcileMarker, 'utf8')
    await logout()
    await rm(gate)
    await until(
      () => readFile(reconcileMarker, 'utf8'),
      value => value.length > before.length,
      'The in-flight credential enrollment never settled',
      timeoutMs
    )
    await assertRevoked()
    assert.equal((await auth('health')).status, 'need_login')
    evidence.push({ case: 'logout-invalidates-inflight-native-credential-enrollment' })
  } finally {
    await rm(gate, { force: true })
  }
  await login()
  await logout()
  await writeFile(
    join(resultDir, 'plugin-auth-coordination.json'),
    JSON.stringify(evidence, null, 2)
  )
}
