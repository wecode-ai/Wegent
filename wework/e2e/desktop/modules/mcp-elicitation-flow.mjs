import {
  MCP_ELICITATION_TIMEOUT_MS,
  readElicitationEvidence,
  readPendingElicitation,
  readMatchingElicitation,
  waitForRealMcpTimeout,
} from './mcp-elicitation-evidence.mjs'
import { verifyConcurrentMcpUserInput } from './mcp-concurrent-input-flow.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  MCP_ELICITATION_COMPLETION_TEXT,
  MCP_ELICITATION_PROMPT,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  pathExists,
  readFile,
  resultDir,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
} from './shared.mjs'
import {
  captureVerificationScreenshot,
  reloadMainWindow,
  waitForWorkbenchDebugState,
} from './workspace-flows.mjs'
import { findRuntimeWorkTask } from './runtime-task-evidence.mjs'

async function verifyMcpElicitationInFullAccess(control) {
  await verifyConcurrentMcpUserInput(control)
  const evidencePath = join(resultDir, 'mcp-elicitation-result.jsonl')
  assert.equal(
    await pathExists(evidencePath),
    false,
    'The MCP elicitation fixture produced evidence before the scenario started'
  )

  control.setScenario('mcp_elicitation')
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, ACTIVE_WORKBENCH_SELECTOR)
  await sendPromptUntilScenarioRequest(
    control,
    ACTIVE_COMPOSER_SELECTOR,
    MCP_ELICITATION_PROMPT,
    'mcp_elicitation'
  )
  await control.command('waitFor', '[data-testid="mcp-url-authorization-card"]', {
    text: 'example.com',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await pathExists(evidencePath),
    false,
    'The URL elicitation was acknowledged without user consent'
  )
  await control.command('click', '[data-testid="mcp-url-authorization-cancel"]')
  await control.command('waitFor', '[data-testid="request-user-input-card"]', {
    text: '访问范围',
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const formText = await control.command('getText', '[data-testid="request-user-input-card"]')
  for (const expectedText of ['访问范围', '所有人', '仅自己']) {
    assert.ok(formText.includes(expectedText), `The MCP elicitation form omitted ${expectedText}`)
  }
  const countdown = await control.command('getText', '[data-testid="request-user-input-deadline"]')
  assert.match(
    countdown,
    /(?:1:00|0:[0-5]\d)/,
    'A new MCP form must use the configured one-minute deadline'
  )
  const formSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    formSnapshot.testIds.includes('request-user-input-option-__codex_approval-0'),
    false,
    'The MCP tool call displayed an execution approval card instead of the business form'
  )
  const urlRecords = (await readFile(evidencePath, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.deepEqual(
    urlRecords,
    [{ event: 'url_elicitation_result', result: { action: 'cancel' } }],
    'The real MCP server must receive only cancellation before the business form is answered'
  )
  await captureVerificationScreenshot(control, 'permission-07-mcp-elicitation-form.png')

  const runningSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const taskId = runningSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(taskId, 'The MCP elicitation form was not attached to a runtime task')
  const firstForm = await readPendingElicitation(control, taskId)

  await control.command('click', '[data-testid="request-user-input-option-audience-1"]')
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: MCP_ELICITATION_COMPLETION_TEXT,
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
      snapshot.pane?.status?.isBusy === false,
    'The MCP elicitation task did not settle after the accepted form response'
  )
  const firstSummary = await revealElicitationSummary(control, 1)
  await control.command('waitFor', `${firstSummary} [data-testid="request-user-input-summary"]`, {
    text: '仅自己',
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const startedAt = Date.now()
  let evidence = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    if (await pathExists(evidencePath)) {
      const records = (await readFile(evidencePath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
      evidence = records.find(record => record.event === 'elicitation_result') ?? null
      if (evidence) break
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.deepEqual(
    evidence?.result,
    {
      action: 'accept',
      content: { audience: 'owner' },
    },
    'The MCP fixture did not receive the accepted stable audience value'
  )
  await captureVerificationScreenshot(control, 'permission-08-mcp-elicitation-complete.png')
  await verifyAnsweredElicitationReload(control, taskId, firstForm, 1)
  await verifyFollowUpElicitationRecovery(control, taskId, evidencePath)
  await verifyElicitationTimeout(control, taskId, evidencePath, 'url_timeout', 3)
  await verifyElicitationTimeout(control, taskId, evidencePath, 'form_timeout', 4)
}

async function expandLauncherWithPendingForm(control, formSelector) {
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
  await control.command('waitFor', '[data-testid="right-workspace-launcher"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="toggle-right-workspace-panel-expanded-button"]')
  await control.command('finishAnimations', 'body')
  await control.command('waitFor', formSelector, {
    text: '访问范围',
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    '[data-testid="restore-conversation-from-expanded-workspace-button"]',
    { visible: true, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
}

async function verifyFollowUpElicitationRecovery(control, taskId, evidencePath) {
  // The real MCP fixture reuses its request IDs after the first turn is answered.
  // Keep the old answered form in this chat while the new turn awaits input.
  await sendPromptUntilScenarioRequest(
    control,
    ACTIVE_COMPOSER_SELECTOR,
    `${MCP_ELICITATION_PROMPT} Ask again in the same chat.`,
    'mcp_elicitation'
  )
  await control.command('waitFor', '[data-testid="mcp-url-authorization-card"]', {
    text: 'example.com',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="mcp-url-authorization-cancel"]')
  const formSelector = '[data-testid="request-user-input-card"]'
  await control.command('waitFor', formSelector, {
    text: '访问范围',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  assert.equal(
    snapshot.workbench?.currentRuntimeTask?.taskId,
    taskId,
    'The follow-up elicitation started a different chat'
  )
  assert.equal(
    (await readElicitationEvidence(evidencePath)).filter(
      record => record.event === 'elicitation_result'
    ).length,
    1,
    'The previous answer was reused for the new pending form'
  )

  await expandLauncherWithPendingForm(control, formSelector)
  await captureVerificationScreenshot(control, 'permission-10-mcp-pending-panel-visible.png')

  await reloadMainWindow(control, 'The WebView did not reconnect with an unanswered MCP form')
  await control.command('waitFor', formSelector, {
    text: '访问范围',
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForWorkbenchDebugState(
    control,
    state => state.workbench?.currentRuntimeTask?.taskId === taskId,
    'Reload did not restore the chat owning the pending MCP form'
  )
  assert.equal(
    (await readElicitationEvidence(evidencePath)).filter(
      record => record.event === 'elicitation_result'
    ).length,
    1,
    'Reload answered the pending form without user input'
  )
  await captureVerificationScreenshot(control, 'permission-11-mcp-pending-reloaded.png')
  const secondForm = await readPendingElicitation(control, taskId)

  // Reload restores the chat with the workspace panel closed. Expand it again
  // so the second response also exercises answering above an expanded panel.
  await expandLauncherWithPendingForm(control, formSelector)
  await control.command('click', '[data-testid="request-user-input-option-audience-1"]')
  await waitForWorkbenchDebugState(
    control,
    state =>
      state.workbench?.currentRuntimeTask?.taskId === taskId &&
      state.pane?.status?.isBusy === false,
    'The restored elicitation did not settle after the second explicit answer'
  )
  await control.command(
    'click',
    '[data-testid="restore-conversation-from-expanded-workspace-button"]'
  )
  await control.command('finishAnimations', 'body')
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: `${MCP_ELICITATION_COMPLETION_TEXT}:2`,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.deepEqual(
    (await readElicitationEvidence(evidencePath))
      .filter(record => record.event === 'elicitation_result')
      .map(record => record.result),
    [
      { action: 'accept', content: { audience: 'owner' } },
      { action: 'accept', content: { audience: 'owner' } },
    ],
    'The real MCP server must receive exactly one explicit answer per turn'
  )
  await captureVerificationScreenshot(control, 'permission-12-mcp-follow-up-complete.png')
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
  await verifyAnsweredElicitationReload(control, taskId, secondForm, 2)
}

async function revealElicitationSummary(control, round) {
  const text = `${MCP_ELICITATION_COMPLETION_TEXT}:${round}`
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text,
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  // Mark the rendered message after scrolling/rendering settles; reload calls this again.
  const anchorId = `mcp-elicitation-completion-${round}`
  await control.command('markElementWithText', '[data-testid="message-assistant"]', {
    text,
    value: anchorId,
    visible: true,
  })
  const anchor = `[data-e2e-anchor-id="${anchorId}"]`
  const collapsed = `${anchor} [data-testid="final-processing-toggle"][aria-expanded="false"]`
  if (Number(await control.command('getElementCount', collapsed))) {
    await control.command('click', collapsed)
  }
  return anchor
}

async function verifyAnsweredElicitationReload(control, taskId, original, round) {
  await reloadMainWindow(control, 'The WebView did not reconnect after answering the MCP form')
  await waitForWorkbenchDebugState(
    control,
    state =>
      state.workbench?.currentRuntimeTask?.taskId === taskId &&
      state.pane?.status?.isBusy === false,
    'Reload did not restore the completed elicitation chat'
  )
  const restored = await readMatchingElicitation(control, taskId, original)
  assert.equal(restored.interactionStatus, 'answered')
  assert.deepEqual(
    restored.response,
    {
      requestId: original.requestId,
      interactionScope: original.interactionScope,
      answers: { audience: { answers: ['仅自己'] } },
    },
    'Reload lost the selected value for this exact turn/request'
  )
  const anchor = await revealElicitationSummary(control, round)
  await control.command('waitFor', `${anchor} [data-testid="request-user-input-summary"]`, {
    text: '仅自己',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="request-user-input-card"]')),
    0
  )
  await captureVerificationScreenshot(control, `permission-mcp-answered-${round}-reloaded.png`)
}

async function assertExpiredElicitation(control, taskId, original, round) {
  const restored = await readMatchingElicitation(control, taskId, original)
  assert.equal(restored.interactionStatus, 'expired')
  assert.equal(restored.expiresAtUnixMs, original.expiresAtUnixMs)
  assert.equal(restored.response, undefined, 'An expired interaction acquired an answer')
  const anchor = await revealElicitationSummary(control, round)
  await control.command('waitFor', `${anchor} [data-testid="request-user-input-expired"]`, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  for (const testId of [
    'request-user-input-card',
    'request-user-input-option-audience-1',
    'request-user-input-submit-button',
    'mcp-url-authorization-open',
  ]) {
    assert.equal(
      Number(await control.command('getElementCount', `[data-testid="${testId}"]`)),
      0,
      `Expired elicitation still exposes ${testId}`
    )
  }
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const task = findRuntimeWorkTask(
    JSON.parse(await control.command('getLocalRuntimeWork', 'body')),
    taskId
  )
  assert.ok(task, 'The executor lost the owning task')
  assert.equal(task.running, false, 'Timeout left the task running')
  assert.equal(task.interactionStatus, null, 'Timeout left the task waiting for input')
}

async function verifyElicitationTimeout(control, taskId, evidencePath, scenario, round) {
  const durationMs = MCP_ELICITATION_TIMEOUT_MS
  const isUrl = scenario === 'url_timeout'
  await sendPromptUntilScenarioRequest(
    control,
    ACTIVE_COMPOSER_SELECTOR,
    `${MCP_ELICITATION_PROMPT} ${scenario}`,
    'mcp_elicitation'
  )
  await control.command('waitFor', '[data-testid="request-user-input-card"]', {
    text: isUrl ? 'example.com' : '访问范围',
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const original = await readPendingElicitation(control, taskId)
  const remainingSeconds = Math.ceil((original.expiresAtUnixMs - Date.now()) / 1000)
  assert.ok(remainingSeconds > 0 && remainingSeconds <= durationMs / 1000)
  assert.match(
    await control.command('getText', '[data-testid="request-user-input-deadline"]'),
    /(?:1:00|0:[0-5]\d)/
  )
  assert.equal(original.interactionKind === 'mcp_url', isUrl)
  const requests = (await readElicitationEvidence(evidencePath)).filter(
    record => record.event === 'timeout_elicitation_request' && record.scenario === scenario
  )
  assert.equal(requests.length, 1)
  assert.ok(original.expiresAtUnixMs >= requests[0].startedAt + durationMs)
  assert.ok(
    original.expiresAtUnixMs <= requests[0].startedAt + durationMs + DEFAULT_STEP_TIMEOUT_MS
  )
  await captureVerificationScreenshot(control, `permission-mcp-${scenario}-pending.png`)
  await waitForRealMcpTimeout(evidencePath, scenario, durationMs)
  await waitForWorkbenchDebugState(
    control,
    state =>
      state.workbench?.currentRuntimeTask?.taskId === taskId &&
      state.pane?.status?.isBusy === false,
    `${scenario} did not release the waiting session after the real MCP cancel`
  )
  await assertExpiredElicitation(control, taskId, original, round)
  const recordsBeforeLateAnswer = await readElicitationEvidence(evidencePath)
  const response = JSON.parse(
    await control.command('answerRuntimeUserInputDirectly', 'body', {
      value: JSON.stringify({
        taskId,
        requestUserInputResponse: {
          requestId: original.requestId,
          interactionScope: original.interactionScope,
          answers: isUrl
            ? { __mcp_url: { answers: ['accept'] } }
            : { audience: { answers: ['仅自己'] } },
        },
      }),
    })
  )
  assert.equal(response.success, false, 'The real executor accepted a late response')
  assert.ok(['missing_request_user_input', 'stale_request_user_input'].includes(response.code))
  await reloadMainWindow(control, `Reload failed after ${scenario}`)
  await assertExpiredElicitation(control, taskId, original, round)
  assert.deepEqual(
    await readElicitationEvidence(evidencePath),
    recordsBeforeLateAnswer,
    'A late answer or reload sent another response to the real MCP server'
  )
  await captureVerificationScreenshot(control, `permission-mcp-${scenario}-expired-reloaded.png`)
}

export { verifyMcpElicitationInFullAccess }
