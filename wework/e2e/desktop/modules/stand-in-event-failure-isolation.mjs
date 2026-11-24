import { standInRoleFixture } from './stand-in-role-fixture.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { requestExecutor } from './executor-rpc.mjs'
import { storyUntil } from './stand-in-source-story-evidence.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const MESSAGE = 'STAND_IN_EVENT_FAILURE_ISOLATION'
const RESULT = 'The independent source event completed.'
// One coordinator pass starts cloud authorization and the next collects its result.
const EVENT_RETIREMENT_TIMEOUT_MS = 15_000

export function createEventFailureIsolation({ executorHome, uiTimeoutMs, modelResponseTimeoutMs }) {
  let modelCalls = 0
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      if (isReplyPredictionRequest(body) || !JSON.stringify(body.input ?? []).includes(MESSAGE)) {
        return false
      }
      modelCalls += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([responseCreated(MESSAGE), assistantMessage(RESULT), responseCompleted(MESSAGE)])
      )
      return true
    },
    async verify(control, cloud, { taskId }) {
      assert.ok(taskId, 'The suite must establish an existing cloud Issue conversation')
      const index = JSON.parse(
        await readFile(join(executorHome, 'runtime-work/index.json'), 'utf8')
      )
      const origin = index.tasks[taskId]?.runtime_handle?.origin
      assert.equal(origin?.projectStore, 'cloud')
      const { userId, standInId: roleId, cloudProjectId, loopItemId } = origin
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const issue = method =>
        fetch(`${cloud.backendUrl}/api/v1/loop-items/${loopItemId}`, {
          method,
          headers: { Authorization: `Bearer ${cloud.authToken}` },
          signal: AbortSignal.timeout(uiTimeoutMs),
        })
      assert.equal((await issue('DELETE')).status, 204, 'Delete the actual cloud Issue')
      assert.equal((await issue('GET')).status, 404, 'The stale Issue must really return 404')

      const original = await rpc('runtime.stand_in.personal.get', { userId })
      const primary = {
        ...original.primary,
        enabled: original.primary?.enabled ?? false,
        prompt: original.primary?.prompt ?? '',
        preferences: original.primary?.preferences ?? '',
      }
      const catalog = await rpc('runtime.runner.catalog', {})
      const model = catalog.models.find(item => item.runtime === 'codex' && item.is_default)
      assert.ok(model, 'Use the configured native E2E model')
      const source = {
        providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
        profile: 'event-isolation-fixture',
        kind: 'direct',
        id: 'isolated-peer',
        name: 'Independent direct message',
        policy: { automatic: true, askBeforeAct: true, immediate: true },
      }
      const settings = await rpc('runtime.stand_in.personal.save', {
        userId,
        settings: {
          ...original,
          primary: { ...primary, enabled: true },
          roles: [
            ...original.roles.filter(role => role.id !== roleId),
            {
              ...standInRoleFixture(original.executionDeviceId, roleId),
              name: MESSAGE,
              enabled: true,
              executionDeviceId: original.executionDeviceId,
              model,
              prompt: MESSAGE,
              connections: [source],
              collaboration: {
                enabled: true,
                allProjects: false,
                projects: [{ id: String(cloudProjectId), store: 'cloud' }],
                excludedProjects: [],
                tags: [],
                policy: { automatic: true, askBeforeAct: true },
              },
            },
          ],
        },
      })
      const database = new DatabaseSync(join(executorHome, 'data/tasks.sqlite'))
      try {
        database.exec('PRAGMA busy_timeout = 3000')
        const row = database.prepare('SELECT metadata FROM loop_items WHERE id = ?')
        const read = id => JSON.parse(row.get(id).metadata)
        const insert = database.prepare(
          "INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?,'stand_in_event',?,?,?)"
        )
        const createdAt = new Date().toISOString()
        const failed = `${MESSAGE}-missing-issue`
        const healthy = `${MESSAGE}-direct-message`
        const record = event => {
          const value = { ...event, userId, roleIds: [roleId], status: 'pending', createdAt }
          insert.run(value.id, JSON.stringify(value), createdAt, createdAt)
        }
        // Recreate the two persisted inputs in one transaction; the real
        // coordinator reads the deleted Issue and dispatches the source work.
        database.exec('BEGIN IMMEDIATE')
        try {
          record({ id: failed, kind: 'work_state', taskId, state: ['completed'] })
          record({
            id: healthy,
            kind: 'connection',
            roleScoped: true,
            source: settings.roles.find(role => role.id === roleId).connections[0],
            message: {
              id: healthy,
              text: MESSAGE,
              at: createdAt,
              conversationId: 'independent-chat',
            },
          })
          database.exec('COMMIT')
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
        await storyUntil(
          async () => ({ failed: read(failed).status, healthy: read(healthy).status }),
          status => status.failed === 'cancelled' && status.healthy === 'handled',
          EVENT_RETIREMENT_TIMEOUT_MS,
          'The missing Issue must retire independently while the direct message is dispatched'
        )
        const { items } = await rpc('runtime.stand_in.work.list', { userId })
        const work = items.find(item => item.source?.id === source.id)
        assert.ok(work?.taskId, 'A real native work must be attached to the source')
        await storyUntil(
          () => rpc('runtime.tasks.get', { taskId: work.taskId }),
          value => value.task?.status === 'done',
          modelResponseTimeoutMs,
          'The independent source must complete its real native turn'
        )
        assert.ok(modelCalls > 0, 'The independent event must reach the native model')
      } finally {
        database.close()
        await rpc('runtime.stand_in.personal.save', {
          userId,
          settings: {
            ...original,
            primary,
            version: settings.version,
          },
        })
      }
    },
  }
}
