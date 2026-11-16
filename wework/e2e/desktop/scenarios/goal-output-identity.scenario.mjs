import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createGoalStateSync } from './goal-state-sync.scenario.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
} from '../modules/shared.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import {
  activeTranscriptSelector,
  assertConversationTextOccurrences,
  assertConversationTextOrder,
} from '../modules/conversation-navigation.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import { withShortConversationViewport } from '../modules/conversation-short-layout.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const BASE = 'WEWORK_OUTPUT_IDENTITY_BASE'
const GOAL = 'WEWORK_OUTPUT_IDENTITY_GOAL'
const FOLLOW_UP = 'WEWORK_OUTPUT_IDENTITY_FOLLOW_UP'
const AFTER_RESTART = 'WEWORK_OUTPUT_IDENTITY_AFTER_RESTART'
const AFTER_RESTORE = 'WEWORK_OUTPUT_IDENTITY_AFTER_RESTORE'
const HISTORY = 'The original answer must keep its place.'
const INITIAL = 'The goal answer before restart must stay attached to its user.'
const RECOVERED = 'The recovered output must appear as a new live turn.'
const FINAL = 'The ordinary follow-up must also keep its own answer.'
const RESTARTED_FINAL = 'A completed conversation must remain sendable after recovery.'
const INTERRUPTED = 'The interrupted continuation had already saved this commentary.'
const RESTORED_FINAL = 'Restored history with an older streaming turn must remain sendable.'

function assertLatestDoneSendable({ transcript, lifecycle }) {
  const latestTurn = transcript.turns.at(-1)
  assert.equal(latestTurn?.status, 'done')
  assert.ok(lifecycle, 'The recovered conversation needs lifecycle state')
  assert.equal(lifecycle.turn.latestId, latestTurn.id)
  assert.equal(lifecycle.execution.phase, 'idle')
  assert.equal(lifecycle.turn.active, false)
  assert.equal(lifecycle.derived.canSend, true)
  assert.equal(lifecycle.derived.isBusy, false)
}

function assertCompletedRecovery(evidence, interruptedTurnId) {
  assert.equal(
    evidence.transcript.turns.find(turn => turn.id === interruptedTurnId)?.status,
    'cancelled',
    'Native history must retain and settle the interrupted historical turn'
  )
  assert.equal(evidence.transcript.running, false)
  assertLatestDoneSendable(evidence)
}

function assertRestoredRecovery(evidence, interruptedTurnId) {
  assert.equal(
    evidence.transcript.turns.find(turn => turn.id === interruptedTurnId)?.status,
    'streaming',
    'Official restoration must preserve the genuinely interrupted rollout turn'
  )
  assertLatestDoneSendable(evidence)
}

function assertNativeTurnSettled({ transcript, lifecycle }) {
  assert.ok(lifecycle?.task?.executionState, 'The live executor must publish its native owner')
  assert.equal(lifecycle.task.executionState.phase, 'idle')
  assert.equal(lifecycle.task.executionState.turnId, null)
  assert.equal(lifecycle.task.executionState.latestTurnId, transcript.turns.at(-1).id)
}

async function captureIdentityFailure(control, resultDir, evidence) {
  const transcriptSelector = '[data-testid="desktop-chat-scroll-content"]'
  const commands = {
    activeWorkspaceCount: ['getElementCount', '[data-workspace-tab-content][aria-hidden="false"]'],
    focusedPaneCount: [
      'getElementCount',
      `${ACTIVE_WORKBENCH_SELECTOR}[data-active-workbench-pane="true"]`,
    ],
    activeTranscriptCount: ['getElementCount', activeTranscriptSelector()],
    activeTranscriptText: ['getText', activeTranscriptSelector()],
    allTranscriptText: ['getText', transcriptSelector],
    viewportMetrics: ['getElementMetrics', '[data-testid="desktop-chat-scroll"]'],
    rowMetrics: ['getElementMetrics', `${transcriptSelector} [data-message-row][data-index]`],
    workbench: ['getWorkbenchDebugSnapshot', 'body'],
  }
  const diagnostics = { ...evidence }
  for (const [key, args] of Object.entries(commands)) {
    try {
      diagnostics[key] = await control.command(...args)
    } catch (error) {
      diagnostics[key] = { error: String(error) }
    }
  }
  await writeFile(
    join(resultDir, 'output-identity-failure.json'),
    JSON.stringify(diagnostics, null, 2)
  )
}

export function createDesktopScenario(options) {
  const existing = createGoalStateSync(options)
  let active = false
  let stage = 0
  let phase = 'setup'
  const requestTrace = []
  let restartDesktopApp
  let releaseRecovered
  let releaseFollowUp
  const recoveredHeld = new Promise(resolve => {
    releaseRecovered = resolve
  })
  const followUpHeld = new Promise(resolve => {
    releaseFollowUp = resolve
  })

  const scenario = {
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },
    async handleHttp(request, response, url) {
      if (!active) return existing.handleHttp(request, response, url)
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(BASE), 'The native session lost its earlier history')
      const current = stage++
      requestTrace.push({
        stage: current,
        phase,
        hasFollowUp: JSON.stringify(body).includes(FOLLOW_UP),
        timestamp: Date.now(),
      })
      if (current >= 4) {
        assert.ok(
          JSON.stringify(body).includes([FOLLOW_UP, AFTER_RESTART, AFTER_RESTORE][current - 4]),
          `A stopped Goal requested another model response before the follow-up: ${JSON.stringify(requestTrace)}`
        )
      }
      const text = [
        HISTORY,
        INITIAL,
        INTERRUPTED,
        RECOVERED,
        FINAL,
        RESTARTED_FINAL,
        RESTORED_FINAL,
      ][current]
      assert.notEqual(text, undefined, `Unexpected model request ${current}`)
      const stream = streamingTextEvents(
        `output-identity-${current}`,
        text,
        current === 2 ? 'commentary' : 'final_answer'
      )
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      response.write(createSse(stream.start))
      response.write(
        createSse([
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta: text,
          },
        ])
      )
      if (current === 2) {
        response.write(
          createSse(stream.finish.filter(event => event.type !== 'response.completed'))
        )
        await new Promise(resolve => response.once('close', resolve))
        return true
      }
      if (current === 3 || current === 4) {
        await Promise.race([
          current === 3 ? recoveredHeld : followUpHeld,
          new Promise(resolve => response.once('close', resolve)),
        ])
        if (response.destroyed) return true
      }
      response.end(createSse(stream.finish))
      return true
    },
    async verify(control) {
      await existing.verify(control)
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      active = true
      await control.command('setLocalStorageItem', 'body', {
        value: JSON.stringify({ key: 'wework:debug-runtime-chat-stream', value: '1' }),
      })
      await control.command('setLocalStorageItem', 'body', {
        value: JSON.stringify({ key: 'wework:debug-runtime', value: '1' }),
      })
      let address
      let recoveredTranscript
      const recoveryEvidence = {}
      const rpc = async (method, params) => {
        const origin = await control.command('getLocationOrigin', 'body')
        const response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: `output-identity-${method}`, method, params }),
          timeoutMs: options.uiTimeoutMs,
        })
        const payload = await response.json()
        assert.equal(response.ok, true)
        assert.equal(payload.ok, true, payload.error?.message)
        return payload.result
      }
      const waitText = text => control.command('waitFor', activeTranscriptSelector(), { text })
      const send = async text => {
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: text })
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      }
      const transcript = () => rpc('runtime.tasks.transcript', { address, refresh: true })
      const lifecycle = async () =>
        JSON.parse(
          await control.command('getRuntimeLifecycleState', 'body', {
            value: JSON.stringify(address),
          })
        )
      const goalUser = result =>
        result.messages.find(message => message.role === 'user' && message.content === GOAL)
      await rpc('runtime.codex.stream_debug.set', { enabled: true })
      try {
        await control.command('click', '[data-testid="new-chat-button"]')
        await createSingleRootLocalProject(control, options.workspacePath, 'output-identity')
        await send(BASE)
        await waitText(HISTORY)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`
        )
        await control.command('click', '[data-testid="set-goal-button"]')
        await send(GOAL)
        await waitText(INITIAL)
        const before = await waitForWorkbenchDebugState(
          control,
          snapshot => stage === 3 && Boolean(snapshot.workbench?.currentRuntimeTask?.taskId),
          'The native Goal did not enter its automatic continuation'
        )
        address = before.workbench.currentRuntimeTask
        const heldTranscript = await waitForValue(
          transcript,
          value =>
            value.turns.at(-1)?.items.some(item => JSON.stringify(item).includes(INTERRUPTED)),
          'The interrupted turn must persist real commentary before the crash',
          options.uiTimeoutMs
        )
        recoveryEvidence.beforeCrash = heldTranscript
        recoveryEvidence.beforeCrashLifecycle = await lifecycle()
        const originalUser = goalUser(heldTranscript)
        assert.ok(originalUser?.turnId, 'The original Goal user needs a native turn identity')
        const interruptedTurn = heldTranscript.turns.at(-1)
        assert.equal(
          interruptedTurn?.status,
          'streaming',
          'The crash needs a real active native turn'
        )
        assert.ok(interruptedTurn.id, 'The interrupted native turn needs a persisted identity')
        assert.equal(recoveryEvidence.beforeCrashLifecycle?.derived.canSend, false)
        assert.equal(recoveryEvidence.beforeCrashLifecycle?.derived.isBusy, true)
        phase = 'restart'
        await restartDesktopApp({ forceStop: true })
        await control.command('waitFor', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitText(RECOVERED)
        phase = 'reopen-recovered-conversation'
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitText(RECOVERED)
        const during = await transcript()
        recoveredTranscript = during
        const recoveredTurn = during.turns.at(-1)
        assert.equal(
          during.turns.find(turn => turn.id === interruptedTurn.id)?.status,
          'streaming',
          'Recovery must actually load the older streaming native turn'
        )
        assert.equal(recoveredTurn?.status, 'streaming')
        assert.notEqual(recoveredTurn.id, interruptedTurn.id)
        await waitForWorkbenchDebugState(
          control,
          snapshot => snapshot.workbench?.activeLifecycle?.turn.id === recoveredTurn.id,
          'The recovered execution selected an older streaming turn instead of the latest turn'
        )
        recoveryEvidence.duringRecovery = {
          transcript: during,
          lifecycle: await lifecycle(),
        }
        assert.equal(recoveryEvidence.duringRecovery.lifecycle?.turn.id, recoveredTurn.id)
        assert.equal(
          recoveryEvidence.duringRecovery.lifecycle?.task?.executionState?.turnId,
          recoveredTurn.id
        )
        assert.equal(recoveryEvidence.duringRecovery.lifecycle?.derived.canSend, false)
        assert.equal(recoveryEvidence.duringRecovery.lifecycle?.derived.isBusy, true)
        assert.equal(
          goalUser(during)?.turnId,
          originalUser.turnId,
          'Automatic recovery rebound the original user message to the recovered turn'
        )
        await withShortConversationViewport(
          control,
          'The recovered Goal identity fixture',
          async () => {
            for (const text of [BASE, HISTORY, GOAL, INITIAL, RECOVERED]) await waitText(text)
            await assertConversationTextOccurrences(
              control,
              Object.fromEntries([BASE, HISTORY, GOAL, INITIAL, RECOVERED].map(text => [text, 1]))
            )
          }
        )
        phase = 'pause-response'
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`
        )
        phase = 'wait-for-stopped-thread'
        await waitForCompletedRuntimeTaskThread(control, address.taskId, options.uiTimeoutMs)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        phase = 'clear-goal'
        await rpc('runtime.tasks.goal.clear', { address })
        await control.command('waitFor', '[data-testid="goal-status-bar"]', { visible: false })
        phase = 'send-follow-up'
        await send(FOLLOW_UP)
        phase = 'wait-for-follow-up'
        await waitText(FINAL)
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitText(FINAL)
        releaseFollowUp()
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitForWorkbenchDebugState(
          control,
          snapshot => snapshot.pane?.transcript?.loading === false,
          'The final history did not finish loading'
        )
        const completedTranscript = await transcript()
        recoveryEvidence.beforeCompletedRestart = {
          transcript: completedTranscript,
          lifecycle: await lifecycle(),
        }
        await writeFile(
          join(options.resultDir, 'output-identity-transcript.json'),
          JSON.stringify(completedTranscript, null, 2)
        )
        await withShortConversationViewport(
          control,
          'The completed Goal identity fixture',
          async () => {
            const ordered = [BASE, HISTORY, GOAL, INITIAL, RECOVERED, FOLLOW_UP, FINAL]
            for (const text of ordered) await waitText(text)
            const visible = await control.command('getText', activeTranscriptSelector())
            await assertConversationTextOccurrences(
              control,
              Object.fromEntries(ordered.map(text => [text, 1]))
            )
            assertConversationTextOrder(visible, ordered)
          }
        )
        phase = 'verify-completed-recovery'
        // Native Codex settles older open turns after the recovered turn stops.
        // The recovered streaming identity must not keep the completed UI busy.
        assertCompletedRecovery(recoveryEvidence.beforeCompletedRestart, interruptedTurn.id)
        assertNativeTurnSettled(recoveryEvidence.beforeCompletedRestart)
        phase = 'restart-completed-conversation'
        await restartDesktopApp()
        await control.command('waitFor', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitText(FINAL)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        recoveryEvidence.afterCompletedRestart = {
          transcript: await transcript(),
          lifecycle: await lifecycle(),
        }
        assertCompletedRecovery(recoveryEvidence.afterCompletedRestart, interruptedTurn.id)
        assert.equal(
          recoveryEvidence.afterCompletedRestart.lifecycle.task.executionState,
          null,
          'A cold executor must recover history without restoring the previous native owner'
        )
        phase = 'send-after-completed-restart'
        await send(AFTER_RESTART)
        await waitText(RESTARTED_FINAL)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        recoveryEvidence.afterRestartSend = {
          transcript: await transcript(),
          lifecycle: await lifecycle(),
        }
        assertCompletedRecovery(recoveryEvidence.afterRestartSend, interruptedTurn.id)
        assertNativeTurnSettled(recoveryEvidence.afterRestartSend)
        assert.notEqual(
          recoveryEvidence.afterRestartSend.transcript.turns.at(-1).id,
          recoveryEvidence.afterCompletedRestart.transcript.turns.at(-1).id
        )
        phase = 'restore-interrupted-native-history'
        const sourceProjectKey = JSON.parse(
          await control.command('getWorkbenchDebugSnapshot', 'body')
        ).workbench.activeTaskProjectKey
        assert.ok(sourceProjectKey, 'The source conversation needs its real sidebar project')
        const source = await rpc('runtime.tasks.get', { address })
        assert.equal(source.success, true)
        assert.ok(source.task.threadId)
        const transcriptId = `output-identity-${randomUUID()}`
        const encryptionKey = randomBytes(32).toString('base64')
        const exported = await rpc('runtime.tasks.transcript.export', {
          address,
          transcriptId,
          sequence: 1,
          baseSequence: 0,
          snapshot: true,
          encryptionKey,
        })
        assert.equal(exported.success, true)
        const restored = await rpc('runtime.tasks.transcript.restore', {
          taskId: transcriptId,
          transcriptId,
          encryptionKey,
          segments: [
            { path: exported.path, sha256: exported.sha256, format: exported.format, sequence: 1 },
          ],
        })
        assert.equal(restored.success, true)
        assert.equal(restored.available, true)
        assert.ok(restored.threadId)
        assert.notEqual(restored.threadId, source.task.threadId)
        const assigned = await rpc('runtime.sidebar.tasks.reorder', {
          projectKey: sourceProjectKey,
          threadId: restored.threadId,
          insertAtEnd: true,
        })
        assert.equal(assigned.success, true)
        assert.equal(assigned.accepted, true)
        const sidebar = await rpc('runtime.tasks.list', {})
        assert.equal(sidebar.success, true)
        const restoredSidebarTask = sidebar.workspaces
          .flatMap(workspace => workspace.tasks)
          .find(task => task.taskId === restored.taskId)
        assert.ok(
          restoredSidebarTask,
          'The restored conversation must pass the real project filter'
        )
        assert.equal(restoredSidebarTask.workspacePath, restored.workspacePath)
        address = {
          ...address,
          taskId: restored.taskId,
          threadId: restored.threadId,
          workspacePath: restored.workspacePath,
        }
        const restoredTranscript = await transcript()
        assert.equal(
          restoredTranscript.turns.find(turn => turn.id === interruptedTurn.id)?.status,
          'streaming'
        )
        assert.equal(restoredTranscript.turns.at(-1)?.status, 'done')
        recoveryEvidence.restored = {
          transcript: restoredTranscript,
          restored,
          sidebarTask: restoredSidebarTask,
          sha256: exported.sha256,
        }
        phase = 'restart-restored-conversation'
        await restartDesktopApp()
        await control.command('waitFor', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitText(RESTARTED_FINAL)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        recoveryEvidence.afterRestoredRestart = {
          transcript: await transcript(),
          lifecycle: await lifecycle(),
        }
        assertRestoredRecovery(recoveryEvidence.afterRestoredRestart, interruptedTurn.id)
        assert.equal(recoveryEvidence.afterRestoredRestart.lifecycle.task.executionState, null)
        phase = 'send-after-restored-restart'
        await send(AFTER_RESTORE)
        await waitText(RESTORED_FINAL)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        recoveryEvidence.afterRestoredSend = {
          transcript: await transcript(),
          lifecycle: await lifecycle(),
        }
        assertRestoredRecovery(recoveryEvidence.afterRestoredSend, interruptedTurn.id)
        assertNativeTurnSettled(recoveryEvidence.afterRestoredSend)
        assert.notEqual(
          recoveryEvidence.afterRestoredSend.transcript.turns.at(-1).id,
          recoveryEvidence.afterRestoredRestart.transcript.turns.at(-1).id
        )
        await writeFile(
          join(options.resultDir, 'output-identity-recovery.json'),
          JSON.stringify({ ...recoveryEvidence, requestTrace }, null, 2)
        )
      } catch (error) {
        console.error('[goal-output-identity] verification failed', { phase, requestTrace }, error)
        try {
          await captureIdentityFailure(control, options.resultDir, {
            error: { name: error.name, message: error.message, stack: error.stack },
            phase,
            requestTrace,
            recoveredTranscript,
            recoveryEvidence,
          })
        } catch (diagnosticError) {
          console.error('[goal-output-identity] failed to retain diagnostics', diagnosticError)
        }
        throw error
      } finally {
        phase = 'cleanup'
        releaseRecovered()
        releaseFollowUp()
        if (address) await rpc('runtime.tasks.goal.clear', { address })
      }
    },
  }
  return scenario
}
