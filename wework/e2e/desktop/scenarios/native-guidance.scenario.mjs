import assert from 'node:assert/strict'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createNativeLifecycle } from './native-lifecycle.scenario.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const GOAL = 'WEWORK_NATIVE_GUIDANCE_GOAL'
const GUIDANCE = 'WEWORK_NATIVE_CONTINUATION_GUIDANCE'
const DONE = 'WEWORK_NATIVE_GUIDANCE_RECEIVED'

// Reuse the existing CI checkpoint and its real runtime; only model replies are simulated.
export function createDesktopScenario(options) {
  const existing = createNativeLifecycle(options)
  let active = false
  let requests = 0
  let held
  let finish
  let releaseInitial
  let codexHome
  const initial = new Promise(resolve => {
    releaseInitial = resolve
  })
  const finished = new Promise(resolve => {
    finish = resolve
  })
  return {
    ...existing,
    async prepareApp(context) {
      codexHome = context.codexHome
      await existing.prepareApp?.(context)
    },
    cleanup() {
      releaseInitial()
      finish()
      held?.end()
      existing.cleanup?.()
    },
    async handleHttp(request, response, url) {
      if (!active) return existing.handleHttp(request, response, url)
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(GOAL), 'The native continuation lost its Goal')
      const count = ++requests
      assert.ok(count <= 3, 'Guidance started a duplicate request')
      const id = `native-guidance-${count}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(createSse([responseCreated(id)]))
      if (count === 1) {
        await initial
        if (!response.destroyed)
          response.end(createSse([assistantMessage('Continue the Goal'), responseCompleted(id)]))
      } else if (count === 2) {
        held = response
      } else {
        assert.ok(JSON.stringify(body.input).includes(GUIDANCE), 'Codex did not receive guidance')
        held?.end()
        await finished
        if (!response.destroyed)
          response.end(createSse([assistantMessage(DONE), responseCompleted(id)]))
      }
      return true
    },
    async verify(control) {
      await existing.verify(control)
      active = true
      let address
      assert.equal(typeof codexHome, 'string', 'The native runtime Home was not prepared')
      const connectorSkill = join(codexHome, 'skills', 'wegent-connector-native-guidance')
      const origin = await control.command('getLocationOrigin', 'body')
      const rpc = async (method, params) => {
        const response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: `native-guidance-${method}`, method, params }),
          timeoutMs: options.uiTimeoutMs,
        })
        const payload = await response.json()
        assert.equal(response.ok, true)
        assert.equal(payload.ok, true, payload.error?.message)
        return payload.result
      }
      try {
        await mkdir(connectorSkill, { recursive: true })
        await writeFile(
          join(connectorSkill, 'SKILL.md'),
          '---\nname: wegent-connector-native-guidance\ndescription: Native guidance capability fixture\n---\n\nThis connector is no longer installed.\n'
        )
        await writeFile(join(connectorSkill, '.wegent-connector'), 'managed\n')
        await control.command('click', '[data-testid="new-chat-button"]')
        const workspace = join(options.workspacePath, 'native-guidance')
        await mkdir(workspace, { recursive: true })
        await createSingleRootLocalProject(control, workspace, 'native-guidance')
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: GOAL })
        await control.command('clickWhenEnabled', '[data-testid="send-message-button"]')
        const started = await waitForWorkbenchDebugState(
          control,
          snapshot => requests === 1 && Boolean(snapshot.workbench?.activeLifecycle?.turn.id),
          'The ordinary request did not reach the model'
        )
        address = started.workbench.currentRuntimeTask
        // Add the Goal after the ordinary request starts so its local control can finish.
        const goal = await rpc('runtime.tasks.goal.set', {
          address,
          objective: GOAL,
          status: 'active',
        })
        assert.equal(goal.accepted, true, goal.error)
        releaseInitial()
        const continued = await waitForWorkbenchDebugState(
          control,
          snapshot =>
            requests === 2 &&
            snapshot.workbench?.activeLifecycle?.task?.executionState?.continuation === true &&
            snapshot.workbench.activeLifecycle.task.executionState.phase === 'running' &&
            snapshot.pane?.status?.isBusy === true,
          'The Goal did not reach its native continuation'
        )
        address = continued.workbench.currentRuntimeTask
        const turnId = continued.workbench.activeLifecycle.task.executionState.turnId
        await waitForValue(
          () => rpc('runtime.tasks.running_count', {}),
          result => result.runningCount === 0,
          'The original local request did not release its execution control',
          options.uiTimeoutMs
        )
        const publication = JSON.parse(
          await control.command('clearLocalExecutorConnectors', 'body')
        )
        assert.equal(
          publication.changed,
          true,
          'Connector removal did not publish capability changes'
        )
        await assert.rejects(stat(connectorSkill), { code: 'ENOENT' })
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: GUIDANCE })
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
          text: GUIDANCE,
        })
        await control.command('clickWhenEnabled', '[data-testid^="queue-guidance-button-"]')
        const guided = await waitForWorkbenchDebugState(
          control,
          snapshot => requests === 3 && snapshot.pane?.status?.isBusy === true,
          'Guidance was rejected during a native continuation'
        )
        assert.equal(guided.workbench.activeLifecycle.task.executionState.turnId, turnId)
        const cleared = await rpc('runtime.tasks.goal.clear', { address })
        assert.equal(cleared.accepted, true, cleared.error)
        finish()
        await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { text: DONE })
        await waitForWorkbenchDebugState(
          control,
          snapshot => snapshot.pane?.status?.isBusy === false,
          'The guided native turn did not settle'
        )
        const rejected = await rpc('runtime.tasks.guidance', { address, message: 'too late' })
        assert.equal(rejected.accepted, false)
        assert.equal(rejected.code, 'no_active_turn')
      } finally {
        await rm(connectorSkill, { recursive: true, force: true })
        if (address) await rpc('runtime.tasks.goal.clear', { address })
        releaseInitial()
        finish()
        held?.end()
      }
    },
  }
}
