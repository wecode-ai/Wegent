import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { until } from './plugin-regression-fixture.mjs'
import { redisCliBinary } from './shared.mjs'

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const run = promisify(execFile)

async function installedPluginName(cloud, installedId, userId) {
  const rows = await cloud.queryDatabase(
    "SELECT name FROM kinds WHERE id=%s AND user_id=%s AND kind='InstalledPlugin' AND namespace='default'",
    [installedId, userId]
  )
  assert.equal(rows.length, 1)
  return rows[0].name
}

/** A separate process owns a real token-checked lease, never a fake response. */
export async function holdPluginWriteLease(cloud, item, userId = 1) {
  const installedId = typeof item === 'number' ? item : item?.installedId
  let name
  if (installedId) {
    name = await installedPluginName(cloud, installedId, userId)
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

export async function observePausedPluginWrites(cloud, installedId, userId = 1) {
  assert.ok(cloud.redis?.pid && Number.isSafeInteger(cloud.redisPort))
  const name = await installedPluginName(cloud, installedId, userId)
  const key = `wegent:plugin-write:${userId}:${name}`
  const pauseBarrier = `${key}:pause-barrier`
  const monitor = await holdPluginCoordinationFault(cloud, 'observe-lease', userId, name)
  const redis = async (...command) => {
    try {
      const { stdout } = await run(
        redisCliBinary(),
        ['-h', '127.0.0.1', '-p', String(cloud.redisPort), ...command],
        { timeout: 1000 }
      )
      return stdout.trim()
    } catch {
      throw new Error(`The isolated Redis did not complete ${command[0]} ${command[1] ?? ''}`)
    }
  }
  let closed = false
  let paused = false
  let pausing
  let pauseOffset
  const resume = async () => {
    if (!paused) return
    assert.equal(await redis('CLIENT', 'UNPAUSE'), 'OK')
    paused = false
  }
  return {
    async pause() {
      assert.ok(!closed, 'The Redis pause fixture was already released')
      paused = true
      // The timeout is a fail-safe if the runner dies. The HTTP events decide when to resume.
      pausing = redis('CLIENT', 'PAUSE', '8000', 'WRITE')
      assert.equal(await pausing, 'OK')
      // A read-only marker puts earlier activity before this test's paused writes.
      assert.ok((await redis('ECHO', pauseBarrier)) === pauseBarrier)
      await monitor.waitFor('pause-barrier', 1000)
      pauseOffset = monitor.events.indexOf('pause-barrier') + 1
    },
    async resumeAfterTimeouts(attempts) {
      assert.ok(paused && pauseOffset > 0, 'The Redis write pause did not reach its barrier')
      await resume()
      await until(
        () => monitor.events.slice(pauseOffset).filter(event => event === 'lease-set').length,
        count => count >= attempts,
        'Redis did not execute the queued Native logout SET attempts after resuming',
        1500
      )
      await until(
        () => redis('EXISTS', key),
        count => count === '0',
        'The timed-out Native logout left a Redis lease after its SET was observed',
        1500
      )
    },
    async release() {
      closed = true
      try {
        // The confirmation callback may still be waiting on the PAUSE command.
        await pausing?.catch(() => {})
        await resume()
      } finally {
        await monitor.release()
      }
    },
  }
}

export async function holdInstalledPluginRow(cloud, installedId, userId = 1) {
  const fixture = await holdPluginCoordinationFault(cloud, 'plugin-row', userId, installedId)
  const readOwner = () =>
    cloud.queryDatabase(
      `SELECT CAST(ENGINE_TRANSACTION_ID AS CHAR) AS transaction_id,
     CAST(THREAD_ID AS CHAR) AS thread_id FROM performance_schema.data_locks
     WHERE OBJECT_SCHEMA=%s AND OBJECT_NAME='kinds' AND INDEX_NAME='PRIMARY'
     AND LOCK_TYPE='RECORD' AND LOCK_STATUS='GRANTED' AND LEFT(LOCK_MODE, 1)='X'
     AND LOCK_DATA=%s ORDER BY ENGINE_TRANSACTION_ID, THREAD_ID`,
      [cloud.databaseName, String(installedId)]
    )
  let owner
  try {
    owner = await readOwner()
    assert.equal(owner.length, 1, 'The fixture did not acquire its target record lock')
  } catch (error) {
    await fixture.release()
    throw error
  }
  return {
    ...fixture,
    async assertHeld() {
      assert.ok(!fixture.events.includes('released'), 'The target row fixture was released')
      assert.deepEqual(await readOwner(), owner, 'The target record lock owner changed')
      return { held: true, blocked: fixture.events.includes('blocked') }
    },
  }
}

export async function holdDeviceRegistrationRow(cloud, userId, recordId) {
  assert.ok(Number.isSafeInteger(recordId) && recordId > 0)
  return holdPluginCoordinationFault(cloud, 'device-row', userId, recordId)
}

export async function holdPluginScanLock(cloud, path, executorHome) {
  return holdPluginCoordinationFault(cloud, 'scan-lock', 1, undefined, { path, executorHome })
}

export async function holdPluginCoordinationFault(cloud, mode, userId = 1, recordId, scan) {
  assert.ok(
    [
      'lease',
      'observe-lease',
      'user-row',
      'device-row',
      'plugin-row',
      'redis-unavailable',
      'scan-lock',
    ].includes(mode)
  )
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
        ...(['lease', 'observe-lease'].includes(mode)
          ? { WEWORK_E2E_PLUGIN_NAME: String(recordId) }
          : {}),
        WEWORK_E2E_PLUGIN_FAULT: mode,
        ...(scan
          ? {
              WEWORK_E2E_PLUGIN_SCAN_LOCK: scan.path,
              WEWORK_E2E_EXECUTOR_HOME: scan.executorHome,
            }
          : {}),
        WEWORK_E2E_PLUGIN_MYSQL: JSON.stringify({
          ...cloud.mysqlConnectionOptions,
          database: cloud.databaseName,
        }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  const events = []
  const eventDetails = new Map()
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
      const details = JSON.parse(line)
      events.push(details.event)
      eventDetails.set(details.event, details)
    } catch {
      failure = new Error('The Redis lease helper returned invalid diagnostics')
    }
  })
  const waitFor = async (event, timeoutMs) => {
    await until(
      () => {
        if (failure) throw failure
        if (child.exitCode !== null && child.exitCode !== 0) {
          throw new Error(`Redis lease helper failed: ${stderr}`)
        }
        return events
      },
      values => values.includes(event),
      `Redis lease helper never reported ${event}`,
      timeoutMs
    )
    return eventDetails.get(event)
  }
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
