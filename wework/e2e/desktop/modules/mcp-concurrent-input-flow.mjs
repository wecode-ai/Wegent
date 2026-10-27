import { performance } from 'node:perf_hooks'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  resultDir,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
  writeFile,
} from './shared.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import {
  CONCURRENT_CASES,
  CONCURRENT_SCENARIO,
  CONCURRENT_QUESTION_ID,
  concurrentCompletion,
  concurrentPrompt,
} from './mcp-concurrent-model.mjs'
import {
  MCP_ELICITATION_TIMEOUT_MS,
  readElicitationEvidence,
  readMatchingElicitation,
  readMcpInteractions,
} from './mcp-elicitation-evidence.mjs'
import {
  captureVerificationScreenshot,
  reloadMainWindow,
  waitForWorkbenchDebugState,
} from './workspace-flows.mjs'
import { waitForSnapshot } from './conversation-layout.mjs'
import { ensureTaskRowVisible } from './memory-tool-flows.mjs'
import { findRuntimeWorkTask } from './runtime-task-evidence.mjs'

const mcpOption = '[data-testid="request-user-input-option-audience-1"]'
const ordinaryOption = `[data-testid="request-user-input-option-${CONCURRENT_QUESTION_ID}-0"]`
const mcpCard = `[data-testid="request-user-input-card"]:has(${mcpOption})`
const ordinaryCard = `[data-testid="request-user-input-card"]:has(${ordinaryOption})`
const evidencePath = join(resultDir, 'mcp-elicitation-result.jsonl.concurrent')

async function waitForEvidence(predicate, description, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs
  let last
  while (performance.now() < deadline) {
    last = await predicate()
    if (last) return last
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(description)
}

async function assertWaiting(control, taskId, waiting) {
  const task = await waitForEvidence(
    async () => {
      const task = findRuntimeWorkTask(
        JSON.parse(await control.command('getLocalRuntimeWork', 'body')),
        taskId
      )
      return task?.interactionStatus === (waiting ? 'waitingForUserInput' : null) && task
    },
    `Task ${taskId} did not ${waiting ? 'retain' : 'clear'} waitingForUserInput`
  )
  assert.equal(task.running, true, 'The model completion gate must keep the native turn running')
  await ensureTaskRowVisible(control, `runtime-local-task-row-${taskId}`)
  const waitingId = `runtime-local-task-waiting-${taskId}`
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes(waitingId) === waiting,
    `Sidebar waiting indicator disagreed with the ${waiting ? 'pending' : 'settled'} requests`
  )
}

async function visible(control, selector) {
  await control.command('waitFor', selector, { visible: true, timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
}

async function assertRemaining(control, taskId, original, ordinaryFirst, expectedStatus) {
  await assertWaiting(control, taskId, true)
  const mcp = await readMatchingElicitation(control, taskId, original)
  assert.equal(mcp.interactionStatus, ordinaryFirst ? 'pending' : expectedStatus)
  assert.equal(mcp.expiresAtUnixMs, original.expiresAtUnixMs)
  await visible(control, ordinaryFirst ? mcpOption : ordinaryOption)
  assert.equal(
    Number(await control.command('getElementCount', ordinaryFirst ? ordinaryCard : mcpCard)),
    0,
    'The settled question must no longer expose an answerable card'
  )
}

async function readMcpResult(action) {
  const records = (await readElicitationEvidence(evidencePath)).filter(
    record =>
      record.scenario === `concurrent_${action}` && record.event === 'concurrent_elicitation_result'
  )
  assert.ok(records.length <= 1, 'The real MCP server received duplicate answers')
  return records[0]
}

async function settleMcp(control, action) {
  if (action === 'timeout') {
    let nextProgress = performance.now()
    const result = await waitForEvidence(
      async () => {
        if (performance.now() >= nextProgress) {
          console.log(
            'Waiting for the real concurrent form timeout; ordinary request remains unanswered'
          )
          nextProgress += 60_000
        }
        return readMcpResult(action)
      },
      'The real concurrent MCP form did not expire',
      MCP_ELICITATION_TIMEOUT_MS + DEFAULT_STEP_TIMEOUT_MS
    )
    assert.ok(
      result.elapsedMs >= MCP_ELICITATION_TIMEOUT_MS,
      'Concurrent form expired before the configured deadline'
    )
  } else {
    await control.command(
      'click',
      action === 'cancel'
        ? `${mcpCard} [data-testid="request-user-input-ignore-button"]`
        : mcpOption
    )
    await waitForEvidence(
      () => readMcpResult(action),
      'The real MCP server did not receive the form response'
    )
  }
  const result = await readMcpResult(action)
  assert.deepEqual(
    result.result,
    ['cancel', 'timeout'].includes(action)
      ? { action: 'cancel' }
      : { action: 'accept', content: { audience: 'owner' } }
  )
}

async function verifyConcurrentCases(control) {
  control.setScenario(CONCURRENT_SCENARIO)
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, ACTIVE_WORKBENCH_SELECTOR)
  for (const [index, action] of CONCURRENT_CASES.entries()) {
    const ordinaryFirst = action === 'ordinary_first'
    let releaseOrdinary
    control.concurrentOrdinaryReady = new Promise(resolve => {
      releaseOrdinary = resolve
    })
    let releaseMcp
    control.concurrentMcpReady = new Promise(resolve => {
      releaseMcp = resolve
    })
    control.holdScenarioResponse(CONCURRENT_SCENARIO)
    try {
      await sendPromptUntilScenarioRequest(
        control,
        ACTIVE_COMPOSER_SELECTOR,
        concurrentPrompt(action),
        CONCURRENT_SCENARIO
      )
      if (ordinaryFirst) {
        // The composer shows the newest pending card. Start the MCP form first
        // for this case, then let the model publish the ordinary question.
        await control.awaitScenarioRequestCount(CONCURRENT_SCENARIO, index * 5 + 3)
        await writeFile(`${evidencePath}.concurrent_${action}.ready`, 'ready')
        await visible(control, mcpOption)
        releaseOrdinary()
        await visible(control, ordinaryOption)
      } else {
        await visible(control, ordinaryOption)
        await writeFile(`${evidencePath}.concurrent_${action}.ready`, 'ready')
        await visible(control, mcpOption)
      }
      const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const taskId = snapshot.workbench?.currentRuntimeTask?.taskId
      assert.ok(taskId)
      const interactions = await readMcpInteractions(control, taskId)
      await writeFile(
        join(resultDir, `permission-concurrent-${action}-transcript.json`),
        await control.command('getLocalRuntimeTranscript', 'body', {
          value: JSON.stringify({ taskId }),
        })
      )
      const original = interactions.find(
        payload => payload.interactionKind === 'mcp_form' && payload.interactionStatus === 'pending'
      )
      assert.ok(original, 'The real executor omitted the pending MCP form')
      const ordinary = interactions.find(
        payload =>
          payload.interactionScope === original.interactionScope &&
          payload.questions?.some(question => question.id === CONCURRENT_QUESTION_ID)
      )
      assert.ok(ordinary, 'Both real native requests must be recoverable in the same turn')
      assert.notEqual(String(ordinary.requestId), String(original.requestId))
      assert.equal(ordinary.interactionStatus, 'pending')
      assert.equal(ordinary.response, undefined)
      await assertWaiting(control, taskId, true)
      await reloadMainWindow(control, 'Reload failed while both native questions were pending')
      await visible(control, ordinaryFirst ? ordinaryOption : mcpOption)
      await assertWaiting(control, taskId, true)
      await captureVerificationScreenshot(
        control,
        `permission-concurrent-${action}-both-pending.png`
      )

      const status =
        action === 'timeout' ? 'expired' : action === 'cancel' ? 'cancelled' : 'answered'
      if (ordinaryFirst) {
        await control.command('click', ordinaryOption)
        assert.equal(
          await readMcpResult(action),
          undefined,
          'Ordinary answer settled the real MCP request'
        )
      } else await settleMcp(control, action)
      await assertRemaining(control, taskId, original, ordinaryFirst, status)
      await reloadMainWindow(control, 'Reload failed after settling only one concurrent request')
      await assertRemaining(control, taskId, original, ordinaryFirst, status)
      await captureVerificationScreenshot(
        control,
        `permission-concurrent-${action}-one-pending-reloaded.png`
      )

      if (ordinaryFirst) await settleMcp(control, action)
      else await control.command('click', ordinaryOption)
      releaseMcp()
      await control.awaitScenarioRequestCount(CONCURRENT_SCENARIO, (index + 1) * 5)
      // Assert before allowing the model to finish: turn completion cannot clear waiting for us.
      await assertWaiting(control, taskId, false)
      await reloadMainWindow(control, 'Reload failed after the last concurrent request settled')
      await assertWaiting(control, taskId, false)
      assert.equal(
        Number(await control.command('getElementCount', `${mcpCard}, ${ordinaryCard}`)),
        0
      )
      const settled = await readMatchingElicitation(control, taskId, original)
      assert.equal(settled.interactionStatus, status)
      const answeredOrdinary = await readMatchingElicitation(control, taskId, ordinary)
      assert.equal(answeredOrdinary.interactionStatus, 'answered')
      assert.deepEqual(
        answeredOrdinary.response?.answers,
        {
          [CONCURRENT_QUESTION_ID]: { answers: ['Continue'] },
        },
        'Reload lost the answer to the ordinary question'
      )
      await captureVerificationScreenshot(
        control,
        `permission-concurrent-${action}-settled-reloaded.png`
      )
    } finally {
      releaseOrdinary()
      releaseMcp()
      control.releaseScenarioResponse(CONCURRENT_SCENARIO)
    }
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: concurrentCompletion(action),
      visible: true,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await waitForWorkbenchDebugState(
      control,
      state => state.pane?.status?.isBusy === false,
      `Concurrent ${action} turn did not complete`
    )
    console.log(
      `Verified real concurrent request_user_input + MCP: ${action}, waiting and reload assertions passed`
    )
  }
}

export async function verifyConcurrentMcpUserInput(control) {
  const { models } = await requestExecutor(
    control,
    'runtime.codex.catalog.overrides.read',
    {
      slugs: [DEFAULT_MODEL_ID],
    },
    DEFAULT_STEP_TIMEOUT_MS
  )
  const model = models.find(model => model.slug === DEFAULT_MODEL_ID)
  assert.ok(model)
  await requestExecutor(
    control,
    'runtime.codex.catalog.overrides.write',
    {
      slug: DEFAULT_MODEL_ID,
      entry: { ...model.effective, tool_mode: 'code_mode' },
    },
    DEFAULT_STEP_TIMEOUT_MS
  )
  await control.command('restartLocalCodexAppServerIfIdle', 'body')
  try {
    await verifyConcurrentCases(control)
  } finally {
    await requestExecutor(
      control,
      'runtime.codex.catalog.overrides.write',
      {
        slug: DEFAULT_MODEL_ID,
        entry: model.effective,
      },
      DEFAULT_STEP_TIMEOUT_MS
    )
  }
  await control.command('restartLocalCodexAppServerIfIdle', 'body')
}
