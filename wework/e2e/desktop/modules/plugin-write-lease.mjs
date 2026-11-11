import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { until } from './plugin-regression-fixture.mjs'

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/** A separate process owns a real token-checked lease, never a fake response. */
export async function holdPluginWriteLease(cloud, item, userId = 1) {
  const installedId = typeof item === 'number' ? item : item?.installedId
  let name
  if (installedId) {
    const rows = await cloud.queryDatabase(
      "SELECT name FROM kinds WHERE id=%s AND user_id=%s AND kind='InstalledPlugin' AND namespace='default'",
      [installedId, userId]
    )
    assert.equal(rows.length, 1)
    name = rows[0].name
  } else {
    assert.ok(item?.pluginId, 'A lease fixture needs its target plugin')
    const rows = await cloud.queryDatabase(
      'SELECT catalog_namespace,slug FROM plugins WHERE id=%s',
      [item.pluginId]
    )
    assert.equal(rows.length, 1)
    const { catalog_namespace: namespace, slug } = rows[0]
    const digest = createHash('sha256').update(`${namespace}:${slug}`).digest('hex').slice(0, 10)
    name = `${slug.slice(0, 89)}-${digest}`
  }
  return holdPluginCoordinationFault(cloud, 'lease', userId, name)
}

export async function holdInstalledPluginRow(cloud, installedId, userId = 1) {
  return holdPluginCoordinationFault(cloud, 'plugin-row', userId, installedId)
}

export async function holdDeviceRegistrationRow(cloud, userId, recordId) {
  assert.ok(Number.isSafeInteger(recordId) && recordId > 0)
  return holdPluginCoordinationFault(cloud, 'device-row', userId, recordId)
}

export async function holdPluginCoordinationFault(cloud, mode, userId = 1, recordId) {
  assert.ok(['lease', 'user-row', 'device-row', 'plugin-row', 'redis-unavailable'].includes(mode))
  const redisUrl = `redis://127.0.0.1:${cloud.redisPort}/0`
  assert.equal(cloud.backendEnv.REDIS_URL, redisUrl)
  const child = spawn(
    'uv',
    [
      'run',
      '--no-sync',
      'python',
      '-u',
      resolve(repoDir, 'wework/e2e/desktop/support/plugin-write-lease.py'),
    ],
    {
      cwd: resolve(repoDir, 'backend'),
      env: {
        ...process.env,
        WEWORK_E2E_PLUGIN_REDIS_URL: redisUrl,
        WEWORK_E2E_PLUGIN_REDIS_PORT: String(cloud.redisPort),
        WEWORK_E2E_PLUGIN_USER_ID: String(userId),
        ...(recordId ? { WEWORK_E2E_DEVICE_RECORD_ID: String(recordId) } : {}),
        ...(mode === 'lease' ? { WEWORK_E2E_PLUGIN_NAME: String(recordId) } : {}),
        WEWORK_E2E_PLUGIN_FAULT: mode,
        WEWORK_E2E_PLUGIN_MYSQL: JSON.stringify({
          ...cloud.mysqlConnectionOptions,
          database: cloud.databaseName,
        }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  const events = []
  let failure
  let stderr = ''
  child.once('error', error => {
    failure = error
  })
  child.stdin.on('error', error => {
    failure ??= error
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    try {
      events.push(JSON.parse(line).event)
    } catch {
      failure = new Error('The Redis lease helper returned invalid diagnostics')
    }
  })
  const waitFor = event =>
    until(
      () => {
        if (failure) throw failure
        if (child.exitCode !== null && child.exitCode !== 0) {
          throw new Error(`Redis lease helper failed: ${stderr}`)
        }
        return events
      },
      values => values.includes(event),
      `Redis lease helper never reported ${event}`
    )
  let closed = false
  const release = async () => {
    if (closed) return
    closed = true
    child.stdin.end()
    try {
      await waitFor('released')
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        Boolean,
        'Redis lease helper did not exit after relinquishing its lease'
      )
      assert.equal(child.exitCode, 0, `Redis lease helper failed: ${stderr}`)
    } finally {
      lines.close()
      if (child.exitCode === null) child.kill('SIGTERM')
    }
  }
  try {
    await waitFor('ready')
  } catch (error) {
    await release()
    throw error
  }
  return { events, waitFor, release }
}
