import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import { readRequestBody as readJson } from '../modules/response-protocol.mjs'
import assert from 'node:assert/strict'

import {
  functionCall,
  requestAdvertisesShellTool,
  requestContainsToolOutput,
  selectShellToolCommand,
} from '../modules/response-protocol.mjs'
import { sendPrompt } from '../modules/conversation-navigation.mjs'
import { ACTIVE_SEND_BUTTON_SELECTOR, selectE2EModel } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const SOURCE_PROMPT = 'WEWORK_CONVERSATION_REFERENCE_SOURCE: remember the launch code ORBIT-42.'
const SOURCE_COMPLETION = 'SOURCE_CONVERSATION_COMPLETE: the launch code is ORBIT-42.'
const TARGET_COMPLETION = 'REFERENCED_CONVERSATION_CONTEXT_RECEIVED'
const CLOUD_ISSUE_TITLE = 'Conversation mention Issue fixture'
const LARGE_SOURCE_PROMPT =
  'WEWORK_CONVERSATION_REFERENCE_LARGE_SOURCE: preserve only this visible conversation.'
const LARGE_SOURCE_COMPLETION = 'LARGE_SOURCE_CONVERSATION_COMPLETE'
const LARGE_TARGET_COMPLETION = 'LARGE_REFERENCED_CONVERSATION_CONTEXT_RECEIVED'
const LARGE_TOOL_CALL_ID = 'call_wework_large_conversation_reference'
const LARGE_TOOL_COMMAND =
  "node -e \"process.stdout.write(require('crypto').randomBytes(14000000).toString('base64'))\""
const MAX_REFERENCED_REQUEST_BYTES = 1024 * 1024
const CLOUD_ONLY = process.argv.includes('--cloud-only')

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function responseCompleted(id) {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  }
}

function assistantMessage(text) {
  return {
    type: 'response.output_item.done',
    item: {
      id: `wework-conversation-mention-message-${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  }
}

async function waitForConversationOption(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    const option = snapshot.testIds.find(testId =>
      testId.startsWith('conversation-reference-option-')
    )
    if (option) return option
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The referenced conversation did not appear in the @ menu')
}

async function selectConversationOption(control, query, timeoutMs, prefix = '') {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    await control.command('fill', COMPOSER_SELECTOR, { value: '' })
    await control.command('fill', COMPOSER_SELECTOR, {
      value: `${prefix}${query}`,
    })
    const optionTestId = await waitForConversationOption(control, timeoutMs)
    try {
      await control.command('click', `[data-testid="${optionTestId}"]`)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error('The referenced conversation could not be selected from the @ menu')
}

async function waitForNewTaskRow(control, knownTaskRows, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const taskRow = snapshot.testIds.find(
      testId => testId.startsWith('runtime-local-task-row-') && !knownTaskRows.has(testId)
    )
    if (taskRow) return taskRow
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The conversation mention task row did not appear')
}

/** Opens the completed target Runtime task and verifies its transcript. */
async function openTargetTask(control, route, timeoutMs) {
  await control.command('navigate', 'body', { value: route })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: TARGET_COMPLETION,
    timeoutMs,
  })
}

/** Exercises Issue navigation from sent messages and composer chips. */
async function verifyComposerIssueReference(
  control,
  issueReference,
  targetTaskRoute,
  { issueFixture, issueTitle, timeoutMs }
) {
  assert.ok(issueFixture, 'The conversation mention Issue fixture is missing')
  const expectedIssueId = issueFixture.issue.id
  const composerIssueReference = `${ACTIVE_WORKBENCH_SELECTOR} [data-composer-reference-kind="issue"]`

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs })
  await control.command('fill', COMPOSER_SELECTOR, { value: issueReference })
  await control.command('waitFor', composerIssueReference, { timeoutMs })
  await control.command('click', composerIssueReference)
  await control.command(
    'waitFor',
    '[data-testid^="workspace-tab-select-board-"][aria-selected="true"]',
    { timeoutMs }
  )
  const boardTabTestId = await control.command(
    'getAttribute',
    '[data-testid^="workspace-tab-select-board-"][aria-selected="true"]',
    { value: 'data-testid' }
  )
  assert.ok(boardTabTestId?.startsWith('workspace-tab-select-board-'))
  const boardLocation = JSON.parse(await control.command('snapshot', 'body')).location
  assert.equal(
    new URL(boardLocation).searchParams.get('itemId'),
    expectedIssueId,
    'The composer Issue reference did not preserve the referenced Issue id'
  )
  await control.command('waitFor', '[data-testid="collaboration-issue-detail"]', {
    text: issueTitle,
    timeoutMs,
  })
  const boardTabId = boardTabTestId.slice('workspace-tab-select-'.length)
  await control.command('clickWhenEnabled', `[data-testid="workspace-tab-close-${boardTabId}"]`, {
    timeoutMs,
  })
  await control.command('waitFor', `[data-testid="${boardTabTestId}"]`, {
    visible: false,
    timeoutMs,
  })
  await openTargetTask(control, targetTaskRoute, timeoutMs)

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs })
  await control.command('fill', COMPOSER_SELECTOR, {
    value: '[$#missing](wework-issue://project-only)',
  })
  await control.command('waitFor', composerIssueReference, { timeoutMs })
  const activeTaskTabBefore = await control.command(
    'getAttribute',
    '[data-tab-kind="task"][aria-selected="true"]',
    { value: 'data-testid' }
  )
  await control.command('click', composerIssueReference)
  await control.command(
    'waitFor',
    '[data-testid^="workspace-tab-select-board-"][aria-selected="true"]',
    { visible: false, stableMs: 300, timeoutMs }
  )
  const activeTaskTabAfter = await control.command(
    'getAttribute',
    '[data-tab-kind="task"][aria-selected="true"]',
    { value: 'data-testid' }
  )
  assert.equal(
    activeTaskTabAfter,
    activeTaskTabBefore,
    'A malformed Issue reference navigated away from the active task'
  )
  await control.command('fill', COMPOSER_SELECTOR, { value: '' })
  await openTargetTask(control, targetTaskRoute, timeoutMs)
}

export function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workspacePath,
}) {
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)
  let active = false
  let sourceRequest = null
  let targetRequest = null
  let largeSourceToolRequested = false
  let largeTargetRequest = null
  let cloud = null
  let issueFixture = null
  const createdCloudResources = { workspace: null, project: null }

  /** Calls the real cloud API and rejects unsuccessful fixture operations. */
  const requestCloud = async (path, method = 'GET', values) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
      ...(values === undefined ? {} : { body: JSON.stringify(values) }),
    })
    const body = await response.text()
    assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${body}`)
    return body ? JSON.parse(body) : null
  }

  return {
    codexConfigToml: '\n[features]\nplugins = false\n',
    requiresCloudEnvironment: CLOUD_ONLY,

    async prepareCloud(environment) {
      cloud = environment
      await requestCloud('/api/admin/setup-complete', 'POST')
      const workspace = await requestCloud('/api/v1/workspaces', 'POST', {
        name: `Conversation mention ${process.pid}`,
      })
      createdCloudResources.workspace = workspace
      const project = await requestCloud('/api/v1/cloud-projects', 'POST', {
        workspace_id: workspace.id,
        name: `Conversation mention ${process.pid}`,
        task_provider: 'local',
        visibility: 'private',
      })
      createdCloudResources.project = project
      const issue = await requestCloud(`/api/v1/cloud-projects/${project.id}/loop-items`, 'POST', {
        title: CLOUD_ISSUE_TITLE,
      })
      issueFixture = { workspace, project, issue }
    },

    async handleHttp(request, response, url) {
      if (!active) return false
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }

      const body = await readJson(request)
      const serialized = JSON.stringify(body)
      const responseId = `wework-conversation-mention-${Date.now()}`
      let completion = ''
      let output = []

      if (
        serialized.includes('wework-conversation://') &&
        serialized.includes(LARGE_SOURCE_PROMPT)
      ) {
        largeTargetRequest = body
        completion = LARGE_TARGET_COMPLETION
      } else if (serialized.includes('wework-conversation://')) {
        targetRequest = body
        completion = TARGET_COMPLETION
      } else if (requestContainsToolOutput(body, LARGE_TOOL_CALL_ID)) {
        completion = LARGE_SOURCE_COMPLETION
      } else if (serialized.includes(LARGE_SOURCE_PROMPT) && requestAdvertisesShellTool(body)) {
        const tool = selectShellToolCommand(body, LARGE_TOOL_COMMAND, workspacePath)
        largeSourceToolRequested = true
        output = selectedToolCall(LARGE_TOOL_CALL_ID, tool)
      } else if (serialized.includes(SOURCE_PROMPT)) {
        sourceRequest = body
        completion = SOURCE_COMPLETION
      }

      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        sse([
          responseCreated(responseId),
          ...output,
          ...(completion ? [assistantMessage(completion)] : []),
          responseCompleted(responseId),
        ])
      )
      return true
    },

    async verify(control) {
      active = true
      let issueReference = null
      if (CLOUD_ONLY) {
        assert.ok(issueFixture, 'The conversation mention Issue fixture is missing')
        issueReference = `[$#${issueFixture.issue.sequence_number ?? issueFixture.issue.id} ${CLOUD_ISSUE_TITLE}](wework-issue://${encodeURIComponent(issueFixture.project.id)}/${encodeURIComponent(issueFixture.issue.id)})`
      }
      await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', '[data-testid="new-chat-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      const initialTaskRows = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      )
      await sendPrompt(control, COMPOSER_SELECTOR, SOURCE_PROMPT)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: SOURCE_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      assert.ok(sourceRequest, 'The source conversation was not sent through the real runtime')
      await waitForNewTaskRow(control, initialTaskRows, uiTimeoutMs)

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      const sourceOnlyTaskRows = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      )
      await control.command('fill', COMPOSER_SELECTOR, {
        value: '@WEWORK_CONVERSATION_REFERENCE_SOURCE',
      })
      await waitForConversationOption(control, uiTimeoutMs)
      const menuSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
      assert.ok(
        menuSnapshot.text.includes('WEWORK_CONVERSATION_REFERENCE_SOURCE'),
        'The @ menu selected an unrelated conversation'
      )
      await capture(control, 'conversation-mention-01-menu.png')
      await selectConversationOption(
        control,
        '@WEWORK_CONVERSATION_REFERENCE_SOURCE',
        uiTimeoutMs,
        issueReference ? `${issueReference} ` : ''
      )
      await control.command('waitFor', '[data-testid^="conversation-chip-"]', {
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'conversation-mention-02-chip.png')
      await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, {
        enabled: true,
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: TARGET_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await waitForNewTaskRow(control, sourceOnlyTaskRows, uiTimeoutMs)
      const targetTaskLocation = JSON.parse(await control.command('snapshot', 'body')).location
      const targetTaskUrl = new URL(targetTaskLocation)
      const targetTaskRoute = `${targetTaskUrl.pathname.replace(/^\/wework\/app/, '')}${targetTaskUrl.search}`

      assert.ok(targetRequest, 'Selecting the conversation mention did not send a model request')
      const serializedTarget = JSON.stringify(targetRequest)
      assert.ok(
        serializedTarget.includes('untrusted background context'),
        'The referenced conversation was not marked as untrusted background context'
      )
      assert.ok(
        serializedTarget.includes(SOURCE_PROMPT),
        'The referenced conversation omitted its user message'
      )
      assert.ok(
        serializedTarget.includes(SOURCE_COMPLETION),
        'The referenced conversation omitted its completed assistant message'
      )
      assert.ok(
        serializedTarget.includes('ORBIT-42'),
        'The referenced conversation content was not delivered to the model'
      )
      await capture(control, 'conversation-mention-03-sent.png')

      const targetTaskTabTestId = await control.command(
        'getAttribute',
        '[data-tab-kind="task"][aria-selected="true"]',
        { value: 'data-testid' }
      )
      assert.ok(
        targetTaskTabTestId === 'workspace-tab-select-fixed-task' ||
          targetTaskTabTestId?.startsWith('workspace-tab-select-task-'),
        `The target task tab was not active before issue reference navigation: ${targetTaskTabTestId}`
      )
      if (CLOUD_ONLY) {
        assert.ok(issueReference, 'The cloud conversation mention Issue reference is missing')
        await control.command('waitFor', '[data-testid^="sent-issue-token-"]', {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', '[data-testid^="sent-issue-token-"]')
        await control.command(
          'waitFor',
          '[data-testid^="workspace-tab-select-board-"][aria-selected="true"]',
          {
            timeoutMs: uiTimeoutMs,
          }
        )
        const issueBoardTabTestId = await control.command(
          'getAttribute',
          '[data-testid^="workspace-tab-select-board-"][aria-selected="true"]',
          { value: 'data-testid' }
        )
        assert.ok(
          issueBoardTabTestId?.startsWith('workspace-tab-select-board-'),
          'The issue reference did not open a project-space board tab'
        )
        const issueBoardLocation = JSON.parse(await control.command('snapshot', 'body')).location
        assert.equal(
          new URL(issueBoardLocation).searchParams.get('itemId'),
          issueFixture.issue.id,
          'The issue reference did not preserve the referenced Issue id'
        )
        await control.command('waitFor', '[data-testid="collaboration-issue-detail"]', {
          text: CLOUD_ISSUE_TITLE,
          timeoutMs: uiTimeoutMs,
        })
        await captureScreenshot(control, 'conversation-mention-04-issue-reference.png', 'body')
        const issueBoardTabId = issueBoardTabTestId.slice('workspace-tab-select-'.length)
        await control.command('click', `[data-testid="${targetTaskTabTestId}"]`)
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: TARGET_COMPLETION,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', `[data-testid="workspace-tab-close-${issueBoardTabId}"]`)
        await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      }

      if (CLOUD_ONLY) {
        assert.ok(issueReference, 'The cloud conversation mention Issue reference is missing')
        await verifyComposerIssueReference(control, issueReference, targetTaskRoute, {
          issueFixture,
          issueTitle: CLOUD_ISSUE_TITLE,
          timeoutMs: uiTimeoutMs,
        })
      }

      await control.command('waitFor', '[data-testid^="sent-conversation-token-"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid^="sent-conversation-token-"]')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: SOURCE_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'conversation-mention-05-chip-navigation.png')
      await openTargetTask(control, targetTaskRoute, uiTimeoutMs)
      const restoredSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        !restoredSnapshot.text.includes(SOURCE_COMPLETION),
        'Switching back exposed the referenced assistant response in the user message'
      )
      assert.ok(
        !restoredSnapshot.text.includes('untrusted background context'),
        'Switching back exposed the serialized referenced-conversation context'
      )
      assert.ok(
        !restoredSnapshot.text.includes('{"role":"assistant"'),
        'Switching back rendered referenced-conversation JSON as user-visible text'
      )
      await capture(control, 'conversation-mention-06-restored.png')

      await selectConversationOption(control, '@WEWORK_CONVERSATION_REFERENCE_SOURCE', uiTimeoutMs)
      await control.command('waitFor', '[data-testid^="conversation-chip-"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid^="conversation-chip-"]')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: SOURCE_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'conversation-mention-07-composer-chip-navigation.png')
      await openTargetTask(control, targetTaskRoute, uiTimeoutMs)
      await control.command('fill', COMPOSER_SELECTOR, { value: '' })

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await selectE2EModel(control, undefined, undefined, ACTIVE_WORKBENCH_SELECTOR)
      await sendPrompt(control, COMPOSER_SELECTOR, LARGE_SOURCE_PROMPT)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: LARGE_SOURCE_COMPLETION,
        // This includes starting the sandbox and processing 18 MB of real tool output.
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.ok(
        largeSourceToolRequested,
        'The large referenced conversation did not execute the real shell tool'
      )

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await selectConversationOption(
        control,
        '@WEWORK_CONVERSATION_REFERENCE_LARGE_SOURCE',
        uiTimeoutMs
      )
      await control.command('waitFor', '[data-testid^="conversation-chip-"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, {
        enabled: true,
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: LARGE_TARGET_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      assert.ok(
        largeTargetRequest,
        'The large referenced conversation did not reach the model request'
      )
      const serializedLargeTarget = JSON.stringify(largeTargetRequest)
      assert.ok(
        serializedLargeTarget.includes(LARGE_SOURCE_PROMPT),
        'The large referenced conversation omitted its user message'
      )
      assert.ok(
        serializedLargeTarget.includes(LARGE_SOURCE_COMPLETION),
        'The large referenced conversation omitted its assistant message'
      )
      assert.ok(
        Buffer.byteLength(serializedLargeTarget) < MAX_REFERENCED_REQUEST_BYTES,
        `The referenced model request still contained oversized process data: ${Buffer.byteLength(serializedLargeTarget)} bytes`
      )
    },

    async cleanup() {
      if (!cloud) return
      try {
        const createdProject = createdCloudResources.project
        if (createdProject) {
          const project = await requestCloud(`/api/v1/cloud-projects/${createdProject.id}`)
          await requestCloud(
            `/api/v1/cloud-projects/${createdProject.id}?version=${project.version}`,
            'DELETE'
          )
        }
      } finally {
        const createdWorkspace = createdCloudResources.workspace
        if (createdWorkspace) {
          const workspace = await requestCloud(`/api/v1/workspaces/${createdWorkspace.id}`)
          await requestCloud(
            `/api/v1/workspaces/${createdWorkspace.id}?version=${workspace.version}`,
            'DELETE'
          )
        }
      }
    },

    diagnostics() {
      return {
        receivedSourceRequest: Boolean(sourceRequest),
        receivedTargetRequest: Boolean(targetRequest),
        requestedLargeSourceTool: largeSourceToolRequested,
        receivedLargeTargetRequest: Boolean(largeTargetRequest),
      }
    },
  }
}
