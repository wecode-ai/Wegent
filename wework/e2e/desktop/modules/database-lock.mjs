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
          assert.equal(JSON.parse(line).locked, true)
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
    async waitForBlockedQueries(count, table = 'loop_item_executions') {
      const deadline = Date.now() + 10_000
      let rows = []
      do {
        rows = await environment.queryDatabase(
          "SELECT trx_mysql_thread_id, trx_query FROM information_schema.innodb_trx WHERE trx_state = 'LOCK WAIT' AND trx_query LIKE %s",
          [`%${table}%`]
        )
        if (rows.length >= count) return rows
        await new Promise(resolve => setTimeout(resolve, 50))
      } while (Date.now() < deadline)
      assert.fail(`Expected ${count} transactions blocked on ${table}: ${JSON.stringify(rows)}`)
    },
    async release() {
      child.stdin.end('\n')
      await closed
    },
  }
}
