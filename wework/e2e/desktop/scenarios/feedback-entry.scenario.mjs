import assert from 'node:assert/strict'

import { DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, selectE2EModel } from '../modules/shared.mjs'
import { waitForBlankConversation } from '../modules/memory-tool-flows.mjs'
import {
  assistantMessage,
  createSse,
  latestModelInputText,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const FEEDBACK_BUTTON = '[data-testid="topnav-feedback-button"]'
const FEEDBACK_OVERLAY = '[data-testid="task-feedback-dialog-overlay"]'
const STANDARD_GROUP = '[data-testid="task-feedback-group-standard-checkbox"]'
const FULL_TASK_GROUP = '[data-testid="task-feedback-group-full-task-checkbox"]'
const ACTIVE_WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER = `${ACTIVE_WORKBENCH} [data-testid="chat-message-input"][contenteditable="true"]`
const TASK_PROMPT = 'FEEDBACK_ENTRY_TASK_CONTEXT'
const TASK_COMPLETION = `${TASK_PROMPT}_COMPLETE`

async function waitForRoute(control, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = ''
  while (Date.now() < deadline) {
    latest = await control.command('getRoute', 'body')
    if (latest === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Expected route ${expected}, received ${latest}`)
}

async function navigateTo(control, route, readySelector, timeoutMs) {
  await control.command('navigate', 'body', { value: route })
  await waitForRoute(control, route, timeoutMs)
  await control.command('waitFor', readySelector, { timeoutMs })
}

async function openFeedback(control, timeoutMs) {
  await control.command('waitFor', FEEDBACK_BUTTON, { visible: true, timeoutMs })
  await control.command('click', FEEDBACK_BUTTON)
  await control.command('waitFor', FEEDBACK_OVERLAY, { visible: true, timeoutMs })
  await control.command('waitFor', `${STANDARD_GROUP}:checked:not(:disabled)`, {
    timeoutMs,
  })
}

async function closeFeedback(control, timeoutMs) {
  await control.command('click', '[data-testid="task-feedback-close-button"]')
  await control.command('waitFor', FEEDBACK_OVERLAY, { visible: false, timeoutMs })
}

async function assertNoTaskContext(control, timeoutMs) {
  await control.command('waitFor', `${FULL_TASK_GROUP}:disabled`, { timeoutMs })
}

async function verifyExportFromPluginPage(control, uiTimeoutMs) {
  await navigateTo(control, '/plugins', '[data-testid="plugins-workspace"]', uiTimeoutMs)
  await openFeedback(control, uiTimeoutMs)
  await assertNoTaskContext(control, uiTimeoutMs)
  await control.command('fill', '[data-testid="task-feedback-note"]', {
    value: 'Desktop E2E: export diagnostics from the Plugins page.',
  })
  await control.command('click', '[data-testid="task-feedback-export-button"]')
  await control.command('waitFor', '[data-testid="task-feedback-preview-list"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', '[data-testid="task-feedback-preview-category-logs"]', {
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="task-feedback-confirm-button"]')
  await control.command('waitFor', '[data-testid="task-feedback-confirm-button"]', {
    visible: false,
    timeoutMs: uiTimeoutMs,
  })
  const exportedPath = await control.command(
    'getText',
    '[data-testid="task-feedback-dialog-overlay"] p.break-all'
  )
  assert.match(
    exportedPath.trim(),
    /\.zip$/i,
    'The Plugins page did not export a ZIP diagnostic bundle'
  )
  await closeFeedback(control, uiTimeoutMs)
}

async function verifyEntryOnPage(control, route, readySelector, uiTimeoutMs) {
  await navigateTo(control, route, readySelector, uiTimeoutMs)
  assert.equal(
    Number(await control.command('getElementCount', FEEDBACK_BUTTON)),
    1,
    `${route} must expose exactly one topbar feedback entry`
  )
  await openFeedback(control, uiTimeoutMs)
  await assertNoTaskContext(control, uiTimeoutMs)
  await closeFeedback(control, uiTimeoutMs)
}

async function verifyTaskPageContext(control, uiTimeoutMs) {
  await navigateTo(control, '/', ACTIVE_WORKBENCH, uiTimeoutMs)
  await waitForBlankConversation(control, COMPOSER)
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await control.command('fill', COMPOSER, { value: TASK_PROMPT })
  await control.command('press', COMPOSER, { key: 'Enter' })
  await control.command('waitFor', `${ACTIVE_WORKBENCH} [data-testid="message-assistant"]`, {
    text: TASK_COMPLETION,
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  assert.equal(
    Number(await control.command('getElementCount', FEEDBACK_BUTTON)),
    1,
    'The task workspace must expose only the shared topbar feedback entry'
  )
  await openFeedback(control, uiTimeoutMs)
  await control.command('waitFor', `${FULL_TASK_GROUP}:not(:disabled)`, {
    timeoutMs: uiTimeoutMs,
  })
  await closeFeedback(control, uiTimeoutMs)
}

export async function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  let active = false

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      ) {
        return false
      }

      const body = await readRequestBody(request)
      const input = latestModelInputText(body)
      if (!input.includes(TASK_PROMPT)) return false
      assert.equal(body.model, DEFAULT_MODEL_ID)
      const responseId = `feedback-entry-${Date.now()}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(responseId),
          assistantMessage(TASK_COMPLETION),
          responseCompleted(responseId),
        ])
      )
      return true
    },

    async verify(control) {
      active = true
      await verifyExportFromPluginPage(control, uiTimeoutMs)
      await captureScreenshot(control, 'feedback-entry-plugin.png', 'body')

      await verifyEntryOnPage(
        control,
        '/stand-in',
        '[data-testid="personal-stand-in-workspace"]',
        uiTimeoutMs
      )
      await verifyEntryOnPage(
        control,
        '/automations',
        '[data-testid="create-automation-button"]',
        uiTimeoutMs
      )
      await verifyEntryOnPage(
        control,
        '/settings/general',
        '[data-testid="general-settings-page"]',
        uiTimeoutMs
      )
      await verifyTaskPageContext(control, uiTimeoutMs)
      await captureScreenshot(control, 'feedback-entry-task.png', 'body')
    },

    diagnostics() {
      return { feedbackEntry: true }
    },
  }
}
