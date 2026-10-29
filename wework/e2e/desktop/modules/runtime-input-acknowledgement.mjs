import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  REQUEST_USER_INPUT_COMPLETION_TEXT,
  REQUEST_USER_INPUT_PROMPT,
  REQUEST_USER_INPUT_QUESTION,
  assert,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
} from './shared.mjs'
import { until } from './plugin-regression-fixture.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'

const summary = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-summary"]`
const question = '[data-testid="request-user-input-card"]'
const readGate = async control => JSON.parse(await control.command('readRuntimeInputTransportGate'))

export async function verifyRuntimeInputAcknowledgement(
  control,
  { outcomes = ['accepted', 'switched', 'rejected'], duringEviction } = {}
) {
  control.setScenario('request_user_input')
  await control.releaseRequestUserInputResponse()
  for (const outcome of outcomes) {
    await control.command('click', '[data-testid="new-chat-button"]')
    await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, ACTIVE_WORKBENCH_SELECTOR)
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (snapshot.testIds.includes('plan-mode-pill')) {
      await control.command('click', '[data-testid="cancel-plan-mode-button"]')
    }
    await sendPromptUntilScenarioRequest(
      control,
      ACTIVE_COMPOSER_SELECTOR,
      REQUEST_USER_INPUT_PROMPT,
      'request_user_input'
    )
    await control.command('waitFor', question, { text: REQUEST_USER_INPUT_QUESTION })
    const state = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    const taskId = state.workbench?.currentRuntimeTask?.taskId
    assert.ok(taskId)
    assert.equal(
      JSON.parse(await control.command('snapshot', 'body')).testIds.includes('plan-mode-pill'),
      false,
      'The test must use Default mode'
    )
    await control.command('armRuntimeInputTransportGate', 'body', {
      value: outcome === 'rejected' ? 'request' : 'response',
    })
    try {
      await control.command('click', '[data-testid="request-user-input-option-direction-1"]')
      await until(
        () => readGate(control),
        gate => gate.held,
        'The real answer bypassed the transport gate'
      )
      if (outcome === 'rejected') {
        control.setScenario('request_user_input_cancelled')
        const cancelled = await requestExecutor(control, 'runtime.tasks.cancel', { taskId }, 10_000)
        assert.equal(cancelled.success, true)
      } else {
        assert.equal((await readGate(control)).accepted, true)
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: REQUEST_USER_INPUT_COMPLETION_TEXT,
        })
      }
      await waitForWorkbenchDebugState(
        control,
        value =>
          value.workbench?.currentRuntimeTask?.taskId === taskId &&
          value.pane?.status?.isBusy === false,
        'The real terminal event did not arrive before the acknowledgement'
      )
      assert.equal((await readGate(control)).released, false)
      if (outcome !== 'rejected') {
        // Switch to another real conversation before reopening, forcing the pane
        // to consume native terminal history while the answer RPC remains held.
        const otherRow = JSON.parse(await control.command('snapshot', 'body')).testIds.find(
          id =>
            id.startsWith('runtime-local-task-row-') && id !== `runtime-local-task-row-${taskId}`
        )
        assert.ok(otherRow, 'The permission checkpoint must provide another conversation')
        await control.command('click', `[data-testid="${otherRow}"]`)
        await until(
          async () => JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')),
          value => value.workbench?.currentRuntimeTask?.taskId !== taskId,
          'The previous conversation did not detach before reloading native history'
        )
        await control.command('armRuntimeTransportGate', 'body', {
          value: JSON.stringify({
            id: 'input-terminal-history',
            kind: 'response',
            name: 'runtime.tasks.transcript',
            where: [{ path: 'params.taskId', equals: taskId }],
            hold: false,
          }),
        })
        await control.command('click', `[data-testid="runtime-local-task-row-${taskId}"]`)
        const history = await until(
          async () =>
            JSON.parse(
              await control.command('readRuntimeTransportGate', 'body', {
                value: 'input-terminal-history',
              })
            ),
          capture => capture?.deliveries === 1,
          'The pane did not receive real terminal history before the acknowledgement'
        )
        assert.equal(history.value.result.runtime, 'codex', 'The native runtime must be Codex')
        await waitForWorkbenchDebugState(
          control,
          value =>
            value.workbench?.currentRuntimeTask?.taskId === taskId &&
            value.pane?.transcript?.loading === false &&
            value.pane?.status?.isBusy === false,
          'The pane did not consume real terminal history before the acknowledgement'
        )
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: REQUEST_USER_INPUT_COMPLETION_TEXT,
        })
        assert.equal((await readGate(control)).released, false)
      }
      if (outcome === 'switched' || outcome === 'evicted') {
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
      }
      const cachedTurns = async () =>
        Number(
          await control.command('getRuntimeCachedTurnCount', 'body', {
            value: JSON.stringify(state.workbench.currentRuntimeTask),
          })
        )
      if (outcome === 'evicted') {
        assert.ok((await cachedTurns()) > 0, 'The completed conversation was never cached')
        // The existing permission checkpoint exercises real five- and ten-minute
        // MCP deadlines. Reuse that work to cross the production cache idle TTL.
        // No clock override, fixed delay, extra model fixture, or added TTL wait.
        await duringEviction()
        assert.equal(await cachedTurns(), 0, 'The real idle cache eviction did not occur')
        assert.equal((await readGate(control)).released, false)
      }
      if (outcome !== 'rejected') {
        await control.command('armRuntimeTransportGate', 'body', {
          value: JSON.stringify({
            id: 'input-answer-delivered',
            kind: 'response',
            name: 'runtime.tasks.send',
            where: [{ path: 'params.taskId', equals: taskId }],
            hold: false,
          }),
        })
      }
      await control.command('releaseRuntimeInputTransportGate')
      if (outcome !== 'rejected') {
        await until(
          async () =>
            JSON.parse(
              await control.command('readRuntimeTransportGate', 'body', {
                value: 'input-answer-delivered',
              })
            ),
          capture => capture?.deliveries === 1 && capture.value.result.accepted === true,
          'The accepted answer acknowledgement did not reach the real consumer'
        )
      }
      if (outcome === 'rejected') {
        await until(
          () => readGate(control),
          gate => gate.accepted === false,
          'The real executor did not reject the cancelled input'
        )
        const transcript = JSON.parse(
          await control.command('getLocalRuntimeTranscript', 'body', {
            value: JSON.stringify({ taskId }),
          })
        )
        assert.equal(transcript.success, true)
        assert.equal(transcript.runtime, 'codex', 'The native runtime must be Codex')
        const answers = [...transcript.turns, ...transcript.runtimeTurns]
          .flatMap(turn =>
            turn.items
              .filter(item => item.type === 'block')
              .map(item => item.block.render_payload?.response?.answers?.direction?.answers ?? [])
          )
          .flat()
        assert.equal(
          answers.includes('Complete'),
          false,
          'Rejected input was persisted as accepted'
        )
        if (Number(await control.command('getElementCount', summary))) {
          assert.equal((await control.command('getText', summary)).includes('Complete'), false)
        }
      } else if (outcome === 'accepted') {
        await control.command('waitFor', summary, { text: 'Complete' })
      } else {
        if (outcome === 'evicted')
          assert.equal(await cachedTurns(), 0, 'Late acknowledgement resurrected the evicted form')
        // The new draft must stay empty when the old request finally acknowledges.
        await until(
          async () => JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')),
          value => value.workbench?.currentRuntimeTask?.taskId !== taskId,
          'Switching tasks did not detach the old conversation'
        )
        if (outcome === 'switched')
          assert.equal(Number(await control.command('getElementCount', summary)), 0)
        else
          assert.equal(
            (await control.command('getText', ACTIVE_WORKBENCH_SELECTOR)).includes(
              REQUEST_USER_INPUT_QUESTION
            ),
            false
          )
        await control.command('click', `[data-testid="runtime-local-task-row-${taskId}"]`)
        await control.command('waitFor', summary, { text: 'Complete' })
      }
    } finally {
      await control.command('releaseRuntimeInputTransportGate')
      await control.command('resetRuntimeTransportGates', 'body', { value: '[]' })
    }
  }
}
