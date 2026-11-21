import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { requestExecutor } from '../modules/executor-rpc.mjs'

const USER = 9001
const CONTEXT = `personal:${USER}`
const EVENT = 'dispatch-limit-event'
const ACTION = 'dispatch-limit-current'
const OLDER_ACTION = 'dispatch-limit-archived'

function seedPendingCreation(database) {
  const insert = database.prepare(
    'INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at) VALUES (?,?,?,?,?)'
  )
  const now = Date.now()
  const record = (id, type, metadata, timestamp = now) => {
    const at = new Date(timestamp).toISOString()
    insert.run(id, type, JSON.stringify({ id, userId: USER, createdAt: at, ...metadata }), at, at)
  }
  const intent = {
    kind: 'create_work',
    arguments: { eventIds: [EVENT], roleId: 'removed-role', title: 'Unassigned work' },
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    record(EVENT, 'stand_in_event', {
      kind: 'connection',
      status: 'pending',
      roleIds: ['removed-role'],
      roleScoped: true,
    })
    record(OLDER_ACTION, 'stand_in_action', { ...intent, status: 'failed' }, now - 60_000)
    record(ACTION, 'stand_in_action', { ...intent, status: 'pending' })
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function createDesktopScenario({ executorHome, workspacePath, uiTimeoutMs }) {
  return {
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const scope = { userId: USER }
      const initial = await rpc('runtime.stand_in.personal.get', scope)
      const catalog = await rpc('runtime.runner.catalog', {})
      const model = catalog.models.find(item => item.runtime === 'codex' && item.is_default)
      assert.ok(model, 'A default Codex model must be available')
      const database = new DatabaseSync(join(executorHome, 'data/tasks.sqlite'))
      database.exec('PRAGMA busy_timeout = 5000')
      try {
        await rpc('runtime.stand_in.personal.save', {
          ...scope,
          settings: {
            ...initial,
            primary: {
              ...initial.primary,
              enabled: true,
              model,
              workspace: { workspacePath, executionMode: 'current_workspace' },
            },
          },
        })
        const discovery = await rpc('runtime.coordination.contexts', {})
        const context = discovery.contexts.find(row => row.id === CONTEXT)
        assert.ok(context?.enabled, 'The personal coordination context must be enabled')
        const snapshot = () =>
          rpc('runtime.coordination.snapshot', { contextId: CONTEXT, revision: context.revision })
        const wake = () => rpc('runtime.coordination.wake', { contextId: CONTEXT })
        const load = database.prepare('SELECT metadata FROM loop_items WHERE id=?')
        const record = id => JSON.parse(load.get(id).metadata)
        seedPendingCreation(database)

        for (const failures of [1, 2, 3]) {
          if (failures > 1) await wake()
          await snapshot()
          const action = record(ACTION)
          assert.equal(action.status, 'failed', `Attempt ${failures} must finish as failed`)
          assert.equal(action.dispatchFailureCount, failures)
          assert.equal(action.error.code, 'role_removed')
        }

        const exhausted = record(ACTION)
        const older = record(OLDER_ACTION)
        await wake()
        await snapshot()
        assert.deepEqual(
          record(ACTION),
          exhausted,
          'The next explicit check must leave the failed action intact'
        )
        assert.deepEqual(
          record(OLDER_ACTION),
          older,
          'An exhausted action must not reopen an older duplicate'
        )
        assert.equal(record(EVENT).status, 'pending', 'The intake remains available in the history')
        return { dispatchFailures: exhausted.dispatchFailureCount, blockedExplicitRetry: true }
      } finally {
        database.close()
        const current = await rpc('runtime.stand_in.personal.get', scope)
        await rpc('runtime.stand_in.personal.save', {
          ...scope,
          settings: { ...initial, version: current.version },
        })
      }
    },
  }
}
