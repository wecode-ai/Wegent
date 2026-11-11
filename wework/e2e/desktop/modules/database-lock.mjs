import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import { join, repoDir } from './shared.mjs'

/** Hold a real database transaction while independent backend requests reach its lock. */
export async function holdDatabaseLock(environment, sql, params = []) {
  const child = spawn(
    'uv',
    ['run', 'python', join(repoDir, 'wework/e2e/desktop/support/mysql-helper.py')],
    {
      cwd: join(repoDir, 'backend'),
      env: {
        ...process.env,
        WEWORK_E2E_MYSQL_REQUEST: JSON.stringify({
          ...environment.mysqlConnectionOptions,
          database: environment.databaseName,
          operation: 'lock',
          sql,
          params,
        }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }
  )
  let diagnostics = ''
  let holderConnectionId
  child.stderr.setEncoding('utf8').on('data', value => {
    diagnostics += value
  })
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`Database lock process exited ${code}: ${diagnostics}`))
    })
  })
  // Register rejection handling immediately, including startup failures.
  void closed.catch(() => {})
  try {
    const lines = createInterface({ input: child.stdout })
    const ready = new Promise((resolve, reject) => {
      lines.once('line', line => {
        try {
          const state = JSON.parse(line)
          assert.equal(state.locked, true)
          holderConnectionId = state.connectionId
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
    await Promise.race([
      ready,
      closed.then(() => assert.fail('Database lock process exited before acquiring the lock')),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Database lock acquisition timed out')),
          10_000
        )
        timer.unref()
        void ready.finally(() => clearTimeout(timer)).catch(() => {})
      }),
    ])
  } catch (error) {
    child.stdin.end()
    child.kill()
    await closed.catch(() => {})
    throw error
  }
  return {
    async waitForBlockedQueries(count, table = 'loop_item_executions', { heldOnly = false } = {}) {
      const deadline = Date.now() + 10_000
      let rows = []
      do {
        rows = heldOnly
          ? await environment.queryDatabase(
              `SELECT requesting.PROCESSLIST_ID AS requesting_connection_id,
            blocking.PROCESSLIST_ID AS blocking_connection_id,
            held.INDEX_NAME AS blocking_index, held.LOCK_DATA AS blocking_data
           FROM performance_schema.data_lock_waits waits
           JOIN performance_schema.data_locks held ON held.ENGINE_LOCK_ID=waits.BLOCKING_ENGINE_LOCK_ID
           JOIN performance_schema.data_locks requested ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
           JOIN performance_schema.threads requesting ON requesting.THREAD_ID=waits.REQUESTING_THREAD_ID
           JOIN performance_schema.threads blocking ON blocking.THREAD_ID=waits.BLOCKING_THREAD_ID
           WHERE blocking.PROCESSLIST_ID=%s AND requested.OBJECT_SCHEMA=%s AND requested.OBJECT_NAME=%s`,
              [holderConnectionId, environment.databaseName, table]
            )
          : await environment.queryDatabase(
              "SELECT trx_mysql_thread_id, trx_query FROM information_schema.innodb_trx WHERE trx_state = 'LOCK WAIT' AND trx_query LIKE %s",
              [`%${table}%`]
            )
        if (rows.length >= count) return rows
        await new Promise(resolve => setTimeout(resolve, 50))
      } while (Date.now() < deadline)
      assert.fail(`Expected ${count} transactions blocked on ${table}: ${JSON.stringify(rows)}`)
    },
    async waitForHeldRowLock(table) {
      assert.ok(Number.isSafeInteger(holderConnectionId))
      return this.waitForBlockedQueries(1, table, { heldOnly: true })
    },
    async release({ commit = false } = {}) {
      child.stdin.end(commit ? 'commit\n' : '\n')
      await closed
    },
  }
}
