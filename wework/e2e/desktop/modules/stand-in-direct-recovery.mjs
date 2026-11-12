import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { requestExecutor } from './executor-rpc.mjs'
import { storyUntil } from './stand-in-source-story-evidence.mjs'
import { seedCollectionTimeout } from './stand-in-collection-timeout.mjs'
import {
  openStandInActivity,
  verifyStandInProfileNavigation,
} from './stand-in-profile-navigation.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import {
  assistantMessage,
  createSse,
  delegatedTaskResultEvents,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const USER = 9001
const PROVIDER = '@wegent/dsh-connection-dingtalk/dingtalk'
const COORDINATOR = `stand-in-coordinator-${USER}`
const PRIMARY = `stand-in-chat-${USER}-primary`
const MARKER = 'DIRECT_RECOVERY'
const BATCH_RESULT = `${MARKER}_BATCH_DONE`

/** Protocol integration: real Electron, Executor, Codex, storage and native tool calls. */
export function createDirectRecoveryVerification(options) {
  const root = join(options.resultDir, 'direct-recovery')
  let active = false
  let coordinatorCalls = 0
  let workCalls = 0
  const resultDeliveries = []
  let round = 0
  let dispatchBatch = false
  const rpc = (control, method, params) =>
    requestExecutor(control, method, params, options.uiTimeoutMs)
  const source = kind => ({
    providerId: PROVIDER,
    profile: 'connection-test-account',
    kind,
    id: kind === 'direct' ? 'fixture-user' : 'direct-recovery-group',
    name: `${MARKER}-${kind}`,
    policy: { automatic: true, askBeforeAct: true, immediate: true },
  })
  async function publish(phase, batch = false) {
    await writeFile(
      join(root, 'messages.json'),
      JSON.stringify({
        success: true,
        result: {
          hasMore: false,
          nextCursor: '0',
          conversationMessagesList: (batch ? ['direct'] : ['direct', 'group']).map(kind => ({
            singleChat: kind === 'direct',
            openConversationId: kind === 'direct' ? 'self-chat' : 'direct-recovery-group',
            messages: (batch ? ['a', 'b'] : ['']).map(suffix => ({
              openMessageId: `${MARKER}-${kind}-${phase}${suffix}`,
              senderOpenDingTalkId: kind === 'direct' ? 'fixture-user' : 'other',
              content: `${MARKER}-${kind}-${phase}${suffix}`,
              createTime: new Date().toISOString(),
              sendType: 'user',
            })),
          })),
        },
      })
    )
  }
  return {
    async prepareApp(context) {
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'baseline-path.txt'), context.appEnvironment.DWS_BINARY_PATH)
      await writeFile(
        join(root, 'messages.json'),
        JSON.stringify({
          success: true,
          result: { hasMore: false, nextCursor: '0', conversationMessagesList: [] },
        })
      )
      await writeFile(
        join(root, 'native.json'),
        JSON.stringify({
          contractVersion: 'im.message-list.v1',
          messages: [{ conversationId: 'self-chat' }],
          paginationKnown: true,
          hasMore: false,
          failedCount: 0,
        })
      )
      const binary = join(
        options.resultDir,
        process.platform === 'win32' ? 'direct-recovery-dws.exe' : 'direct-recovery-dws'
      )
      const prepared = process.env.WEWORK_E2E_DWS_RECOVERY_FIXTURE_BIN
      if (prepared) {
        await copyFile(prepared, binary)
      } else {
        await promisify(execFile)('rustc', [
          fileURLToPath(new URL('../fixtures/direct-recovery-dingtalk-cli.rs', import.meta.url)),
          '--edition',
          '2021',
          '-o',
          binary,
        ])
      }
      context.appEnvironment.DWS_BINARY_PATH = binary
      // Persist the observed pre-native-start failure boundary before the app opens its store.
      const directory = join(options.executorHome, 'runtime-work')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'index.json'),
        JSON.stringify({
          version: 1,
          tasks: {
            [COORDINATOR]: {
              local_task_id: COORDINATOR,
              thread_id: null,
              workspace_path: options.workspacePath,
              title: '分身后台统筹',
              runtime: 'codex',
              continuable: true,
              ephemeral: false,
              runtime_handle: {
                origin: { type: 'stand_in_coordinator', userId: USER },
                executionRequest: { user_id: USER },
              },
            },
          },
          workspaces: {},
          deleted_archived_task_ids: {},
        })
      )
    },
    async handleHttp(req, response, url) {
      if (!active) return false
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input ?? [])
      let events = delegatedTaskResultEvents(body)
      const latestUser = (body.input ?? []).filter(item => item.role === 'user').at(-1)
      const deliveredTask = JSON.stringify(latestUser?.content ?? '').match(
        /Wework delegated task result:.*?taskId=([^,\s]+)/
      )?.[1]
      if (events && deliveredTask) {
        resultDeliveries.push({
          taskId: deliveredTask,
          model: body.model,
          effort: body.reasoning?.effort,
        })
      }
      if (!events && input.includes('Review this silent intake batch')) {
        coordinatorCalls++
        const read = `${MARKER}-read-${round}`
        const ignore = `${MARKER}-ignore-${round}`
        if (requestContainsToolOutput(body, ignore)) {
          assert.equal(JSON.parse(readMcpToolOutput(body, ignore)).status, 'pending')
          round++
          events = [assistantMessage('已完成后台检查。')]
        } else {
          const ready = requestContainsToolOutput(body, read)
          const args = ready
            ? {
                eventIds: JSON.parse(readMcpToolOutput(body, read)).snapshot.events.map(
                  event => event.id
                ),
                ...(dispatchBatch
                  ? { roleId: '@primary', title: 'Selected source batch' }
                  : { reason: 'Protocol regression completed' }),
              }
            : {}
          const name = ready ? (dispatchBatch ? 'create_work' : 'ignore_events') : 'read_intake'
          events = mcpToolRequestEvents(body, {
            toolName: name,
            directToolName: `mcp__wework_stand_in__${name}`,
            argumentsValue: args,
            searchCallId: `${ready ? ignore : read}-search`,
            toolCallId: ready ? ignore : read,
          }).events
        }
      } else if (!events && input.includes(MARKER)) {
        if (dispatchBatch) {
          const fresh = JSON.stringify(
            [...(body.input ?? [])].reverse().find(item => item.role === 'user')
          )
          assert.ok(fresh.includes(`${MARKER}-direct-3a`))
          assert.ok(fresh.includes(`${MARKER}-direct-3b`))
          assert.ok(
            !fresh.includes(`${MARKER}-direct-2`),
            'Ignored input must not leak into the next dispatch'
          )
        }
        workCalls++
        events = [assistantMessage(dispatchBatch ? BATCH_RESULT : `${MARKER}_DONE`)]
      }
      if (!events) return false
      const id = `${MARKER}-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      active = true
      await writeFile(join(root, 'active'), 'enabled')
      await control.command('ensureLocalModelCatalogReady', 'body', {
        timeoutMs: options.workbenchReadyTimeoutMs,
      })
      const initial = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      const catalog = await rpc(control, 'runtime.runner.catalog', {})
      const model = catalog.models.find(item => item.runtime === 'codex' && item.is_default)
      assert.ok(model)
      assert.equal(model.local_model_id, 'gpt-5.6-luna')
      assert.equal(model.default_reasoning_effort, 'none')
      assert.deepEqual(model.supported_reasoning_efforts, [])
      for (const key of ['reasoning', 'reasoningEffort']) {
        assert.equal(
          initial.primary?.modelOptions?.[key],
          undefined,
          'The regression must inherit the catalog default without an explicit effort'
        )
      }
      await control.command('seedLocalProject', 'body', {
        value: JSON.stringify({ projectKey: MARKER, name: MARKER, path: options.workspacePath }),
      })
      const settings = {
        ...initial,
        primary: {
          ...initial.primary,
          enabled: true,
          prompt: '',
          preferences: '',
          model,
          workspace: {
            projectKey: MARKER,
            workspacePath: options.workspacePath,
            executionMode: 'current_workspace',
          },
          connections: ['direct', 'group'].map(source),
        },
        roles: [],
      }
      await rpc(control, 'runtime.stand_in.personal.save', { userId: USER, settings })
      const database = new DatabaseSync(join(options.executorHome, 'data/tasks.sqlite'))
      database.exec('PRAGMA busy_timeout = 10000')
      try {
        // Establish a historical assessment failure, not a disabled identity or source.
        const changed = database
          .prepare(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.error',json(?),'$.force',json('false')) WHERE resource_type='stand_in_processing' AND json_extract(metadata,'$.userId')=?"
          )
          .run(
            JSON.stringify({
              code: 'missing_runtime_session',
              message: 'Previous coordinator never obtained a native session',
            }),
            USER
          )
        assert.equal(changed.changes, 1)
        const assertCollectionRecovered = await seedCollectionTimeout(
          database,
          USER,
          PROVIDER,
          options.modelResponseTimeoutMs
        )
        await publish(1)
        const work = await storyUntil(
          () => rpc(control, 'runtime.stand_in.work.list', { userId: USER }),
          value => value.items.filter(item => item.source?.providerId === PROVIDER).length === 2,
          options.modelResponseTimeoutMs,
          'Direct sources with empty duties must dispatch despite an unrelated coordinator failure'
        )
        assert.equal(coordinatorCalls, 0, 'Direct processing must never invoke semantic assessment')
        const ids = work.items
          .filter(item => item.source?.providerId === PROVIDER)
          .map(item => item.taskId)
        assert.equal(new Set(ids).size, 2)
        for (const taskId of ids)
          await storyUntil(
            () => rpc(control, 'runtime.tasks.get', { taskId }),
            value => value.task?.status === 'done',
            options.modelResponseTimeoutMs,
            'Direct work must complete through real Codex'
          )
        assert.equal(workCalls, 2, 'Each incoming source event executes exactly once')
        assertCollectionRecovered()
        const status = await rpc(control, 'runtime.stand_in.processing.status', { userId: USER })
        assert.equal(
          status.error.code,
          'missing_runtime_session',
          'Independent dispatch must not conceal the old assessment failure'
        )
        await rpc(control, 'runtime.stand_in.processing.check', { userId: USER })
        await storyUntil(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          value =>
            coordinatorCalls > 0 && !value.running && !value.error && value.pendingCount === 0,
          options.modelResponseTimeoutMs,
          'Explicit retry must start a real native session from the persisted sessionless coordinator'
        )
        const task = await rpc(control, 'runtime.tasks.get', { taskId: COORDINATOR })
        assert.ok(task.task.runtimeHandle.threadId)
        assert.equal(workCalls, 2, 'Coordinator recovery must not replay completed direct work')
        const threadId = task.task.runtimeHandle.threadId
        const previousCalls = coordinatorCalls
        const current = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
        current.primary.connections.forEach(connection => {
          connection.policy.immediate = false
        })
        await rpc(control, 'runtime.stand_in.personal.save', { userId: USER, settings: current })
        await publish(2)
        await storyUntil(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          value => value.pendingCount > 0,
          options.modelResponseTimeoutMs,
          'Silent input must enter the same shared collector without creating direct work'
        )
        await rpc(control, 'runtime.stand_in.processing.check', { userId: USER })
        await storyUntil(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          value =>
            coordinatorCalls > previousCalls &&
            !value.running &&
            !value.error &&
            value.pendingCount === 0,
          options.modelResponseTimeoutMs,
          'The recovered coordinator must continue handling later batches'
        )
        const resumed = await rpc(control, 'runtime.tasks.get', { taskId: COORDINATOR })
        assert.equal(
          resumed.task.runtimeHandle.threadId,
          threadId,
          'Later batches must reuse the established native conversation'
        )
        assert.equal(workCalls, 2, 'Silent handling must not become direct execution')
        const ignored = database
          .prepare(
            "SELECT metadata FROM loop_items WHERE resource_type='stand_in_event' AND json_extract(metadata,'$.userId')=? AND json_extract(metadata,'$.message.id')=?"
          )
          .get(USER, `${MARKER}-direct-2`)
        assert.ok(ignored, 'The ignored intake event must exist in durable storage')
        assert.equal(JSON.parse(ignored.metadata).status, 'handled')
        const direct = work.items.find(
          item => item.source?.providerId === PROVIDER && item.source.kind === 'direct'
        )
        const beforeBatch = await rpc(control, 'runtime.tasks.get', { taskId: direct.taskId })
        dispatchBatch = true
        await publish(3, true)
        await storyUntil(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          value => value.pendingCount >= 2,
          options.modelResponseTimeoutMs,
          'Two new messages must enter the silent source batch'
        )
        await rpc(control, 'runtime.stand_in.processing.check', { userId: USER })
        await storyUntil(
          () => rpc(control, 'runtime.tasks.get', { taskId: direct.taskId }),
          value => workCalls === 3 && value.task?.status === 'done',
          options.modelResponseTimeoutMs,
          'The selected reuse batch must execute once through the real existing conversation'
        )
        const afterBatch = await rpc(control, 'runtime.tasks.get', { taskId: direct.taskId })
        assert.equal(
          afterBatch.task.runtimeHandle.threadId,
          beforeBatch.task.runtimeHandle.threadId
        )
        assert.equal(workCalls, 3)
        dispatchBatch = false
        await storyUntil(
          () => rpc(control, 'runtime.tasks.transcript', { taskId: PRIMARY, limit: 100 }),
          value =>
            value.messages?.some(
              message =>
                message.role === 'assistant' &&
                message.content?.includes(`任务 ${direct.taskId}（done）：${BATCH_RESULT}`)
            ),
          options.modelResponseTimeoutMs,
          'The primary conversation must report the selected batch result before archiving its source'
        )
        const deliveries = resultDeliveries.filter(delivery => ids.includes(delivery.taskId))
        assert.ok(
          deliveries.length > 0,
          'A real source result must reach the native model with effort none'
        )
        for (const delivery of deliveries) {
          assert.equal(delivery.model, 'gpt-5.6-luna')
          assert.equal(
            delivery.effort,
            'none',
            'The native model request must preserve the stand-in catalog default none during result delivery'
          )
        }
        await rpc(control, 'runtime.tasks.archive', { taskId: direct.taskId })
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await openStandInActivity(control)
        await control.command(
          'clickWhenEnabled',
          `[data-testid="stand-in-activity-task-${direct.taskId}"]`
        )
        await control.command('waitFor', '[data-testid="stand-in-preview-open"]', {
          text: '取消归档',
        })
        await control.command('clickWhenEnabled', '[data-testid="stand-in-preview-open"]')
        const restored = await storyUntil(
          () => rpc(control, 'runtime.tasks.get', { taskId: direct.taskId }),
          value => value.task?.status !== 'archived',
          options.modelResponseTimeoutMs,
          'Explicit source restoration must use the existing native unarchive operation'
        )
        assert.equal(restored.task.runtimeHandle.threadId, beforeBatch.task.runtimeHandle.threadId)
        assert.equal(workCalls, 3, 'Unarchive must not start a new turn')
        await options.captureScreenshot(control, 'stand-in-source-restored.png')
        await control.command('clickWhenEnabled', '[data-testid="stand-in-work-dialog-close"]')
        await verifyStandInProfileNavigation(control, options.captureScreenshot)
        console.log(
          '[stand-in-direct-recovery]',
          JSON.stringify({
            directWorks: workCalls,
            coordinatorRequests: coordinatorCalls,
            nativeSessionRecovered: true,
            nativeSessionReused: true,
          })
        )
        await options.captureScreenshot(control, 'stand-in-direct-recovery.png')
      } finally {
        active = false
        await writeFile(join(root, 'active'), '')
        database.close()
        const current = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
        await rpc(control, 'runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...initial, version: current.version },
        })
      }
    },
    diagnostics() {
      return { coordinatorCalls, workCalls, round }
    },
  }
}
