import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { standInSchedulerIntervalMs } from '../modules/stand-in-flows.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 9001
const ROLE = 'history-owner'
const MARKER = 'COORDINATION_HISTORY_NEW_WORK'
const HISTORY_COUNT = 80_000
// Each resource kind can consume a separate minute-spaced maintenance pass.
const RETENTION_TIMEOUT_MS = 3 * 60_000 + 10_000

function seedHistory(database) {
  const current = new Date().toISOString()
  const old = new Date(Date.now() - 8 * 86400000).toISOString()
  const insert = database.prepare(
    'INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at) VALUES (?,?,?,?,?)'
  )
  const facts = database.prepare(
    'INSERT INTO stand_in_history(id,resource_type,user_id,status,kind,batch_id,event_created_at) VALUES (?,?,?,?,?,?,?)'
  )
  const reference = database.prepare(
    'INSERT INTO stand_in_history_refs(owner_id,event_id) VALUES (?,?)'
  )
  const record = (kind, value, at = current, indexed = true) => {
    insert.run(value.id, kind, JSON.stringify({ userId: USER, ...value }), at, at)
    if (!indexed) return
    facts.run(
      value.id,
      kind,
      USER,
      value.status ?? null,
      value.kind ?? null,
      value.batchId ?? value.result?.snapshotId ?? null,
      value.createdAt ?? null
    )
    for (const event of value.arguments?.eventIds ?? []) reference.run(value.id, event)
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    record(
      'stand_in_event',
      {
        id: 'history-blocked-event',
        kind: 'work_state',
        status: 'pending',
        roleIds: [ROLE],
        taskId: 'failed-work-requiring-owner-recovery',
        createdAt: old,
      },
      old
    )
    for (let index = 0; index < HISTORY_COUNT; index++) {
      record('stand_in_action', {
        id: `history-failure-${index}`,
        batchId: `history-batch-${index}`,
        kind: 'continue_work',
        status: 'failed',
        createdAt: current,
        arguments: {
          eventIds: ['history-blocked-event'],
          taskId: 'failed-work-requiring-owner-recovery',
        },
        error: {
          code: 'stand_in_dispatch_failed',
          message: 'Review failed work before retrying it',
        },
      })
    }
    record(
      'stand_in_action',
      {
        id: 'history-expired-action',
        batchId: 'history-expired-batch',
        kind: 'ignore_events',
        status: 'succeeded',
        arguments: { eventIds: ['history-settled-event'] },
      },
      old
    )
    record(
      'stand_in_event',
      {
        id: 'history-settled-event',
        kind: 'connection',
        status: 'handled',
        roleScoped: true,
        message: { text: 'Expired diagnostic payload' },
        createdAt: old,
      },
      old
    )
    record(
      'stand_in_route',
      {
        id: 'history-expired-route',
        result: { snapshotId: 'history-expired-batch' },
      },
      old
    )
    for (const kind of ['stand_in_event', 'stand_in_action', 'stand_in_route']) {
      record(kind, { id: `history-legacy-expired-${kind}` }, old, false)
      record(kind, { id: `history-legacy-recent-${kind}` }, current, false)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/** Real local database, DSH scheduler, Executor and native task; only the model is scripted. */
export function createDesktopScenario({
  executorHome,
  workspacePath,
  uiTimeoutMs,
  modelResponseTimeoutMs,
}) {
  let workTurns = 0
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  async function until(load, ready, label, timeoutMs = modelResponseTimeoutMs) {
    const deadline = Date.now() + timeoutMs
    let latest
    while (Date.now() < deadline) {
      latest = await load()
      if (ready(latest)) return latest
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(`${label}: ${JSON.stringify(latest)}`)
  }
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (isReplyPredictionRequest(body) || !JSON.stringify(body.input ?? []).includes(MARKER))
        return false
      workTurns++
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated('history-work'),
          assistantMessage('HISTORY_NEW_WORK_COMPLETED'),
          responseCompleted('history-work'),
        ])
      )
      return true
    },
    async verify(control) {
      const initial = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      const project = await rpc(control, 'projects.create', {
        name: 'Scheduler history regression',
      })
      const database = new DatabaseSync(join(executorHome, 'data/tasks.sqlite'))
      database.exec('PRAGMA busy_timeout = 10000')
      try {
        const catalog = await rpc(control, 'runtime.runner.catalog', {})
        const model = catalog.models.find(item => item.runtime === 'codex' && item.is_default)
        assert.ok(model)
        await control.command('seedLocalProject', 'body', {
          value: JSON.stringify({ projectKey: MARKER, name: MARKER, path: workspacePath }),
        })
        const workspace = { projectKey: MARKER, workspacePath, executionMode: 'current_workspace' }
        await rpc(control, 'runtime.stand_in.personal.save', {
          userId: USER,
          settings: {
            ...initial,
            primary: { enabled: true, prompt: '', preferences: '', model, workspace },
            roles: [
              {
                id: ROLE,
                name: 'History owner',
                enabled: true,
                prompt: '',
                version: 0,
                executionDeviceId: initial.executionDeviceId,
                model,
                workspace,
                collaboration: {
                  enabled: true,
                  allProjects: false,
                  projects: [{ id: project.id, store: 'local' }],
                  excludedProjects: [],
                  tags: [],
                  policy: { automatic: true, askBeforeAct: true, immediate: true },
                },
              },
            ],
          },
        })
        await until(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          state => Number.isInteger(state.observedSince),
          'Scheduler observation must be established'
        )
        seedHistory(database)
        const started = Date.now()
        const issue = await rpc(control, 'todos.create', {
          project_id: project.id,
          todo: { title: MARKER, assignee_user_id: USER },
        })
        const bindings = await until(
          () => rpc(control, 'todos.bindings', { task_id: issue.id }),
          rows => rows.length === 1,
          'New work must dispatch through the real scheduler despite 80,000 historical failures'
        )
        const taskId = bindings[0].task_id
        await until(
          () => rpc(control, 'runtime.tasks.get', { taskId }),
          value => value.task?.status === 'done',
          'Native work must complete'
        )
        assert.equal(workTurns, 1)
        await until(
          async () => ({
            event: database
              .prepare("SELECT metadata FROM loop_items WHERE id='history-settled-event'")
              .get(),
            expired: database
              .prepare(
                "SELECT count(*) AS count FROM loop_items WHERE id IN ('history-expired-action','history-expired-route','history-legacy-expired-stand_in_event','history-legacy-expired-stand_in_action','history-legacy-expired-stand_in_route')"
              )
              .get().count,
          }),
          ({ event, expired }) => JSON.parse(event.metadata).compacted === true && expired === 0,
          'Scheduled maintenance must compact indexed events and delete expired actions, routes and legacy records',
          RETENTION_TIMEOUT_MS
        )
        assert.equal(
          database
            .prepare(
              "SELECT count(*) AS count FROM loop_items WHERE id IN ('history-expired-action','history-expired-route')"
            )
            .get().count,
          0
        )
        assert.equal(
          database
            .prepare(
              "SELECT count(*) AS count FROM loop_items WHERE id LIKE 'history-legacy-expired-%'"
            )
            .get().count,
          0,
          'Unindexed legacy records expire without payload backfill'
        )
        assert.equal(
          database
            .prepare(
              "SELECT count(*) AS count FROM loop_items WHERE id LIKE 'history-legacy-recent-%'"
            )
            .get().count,
          3,
          'Recent unindexed legacy records remain available'
        )
        assert.equal(
          JSON.parse(
            database
              .prepare("SELECT metadata FROM loop_items WHERE id='history-blocked-event'")
              .get().metadata
          ).status,
          'pending',
          'Failed-event recovery must remain available'
        )
        assert.equal(
          database
            .prepare(
              "SELECT count(*) AS count FROM loop_items WHERE resource_type='stand_in_action' AND json_extract(metadata,'$.status')='failed'"
            )
            .get().count,
          HISTORY_COUNT,
          'Polling must not generate another failed intent'
        )
        // Observe two configured polling intervals plus jitter, including idle passes
        // that legitimately skip commit and do not advance lastCheckAt.
        const observationEnds = Date.now() + 2 * standInSchedulerIntervalMs() + 500
        do {
          assert.equal(
            database
              .prepare(
                "SELECT count(*) AS count FROM loop_items WHERE resource_type='stand_in_action' AND json_extract(metadata,'$.status')='failed'"
              )
              .get().count,
            HISTORY_COUNT,
            'Background polling must not replan failed events'
          )
          await new Promise(resolve => setTimeout(resolve, 500))
        } while (Date.now() < observationEnds)
        assert.equal(
          database
            .prepare(
              "SELECT count(*) AS count FROM loop_items WHERE resource_type='stand_in_action' AND json_extract(metadata,'$.status')='failed'"
            )
            .get().count,
          HISTORY_COUNT
        )
        return {
          taskId,
          historicalActions: HISTORY_COUNT,
          workTurns,
          elapsedMs: Date.now() - started,
        }
      } finally {
        database.close()
        const current = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
        await rpc(control, 'runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...initial, version: current.version },
        })
      }
    },
  }
}
