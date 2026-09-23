import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assistantMessage,
  codexRequestKind,
  createSse,
  functionCall,
  mcpToolRequestEvents,
  namespacedFunctionCall,
  readRequestBody,
  requestContainsToolOutput,
  requestToolSearchResults,
  responseCompleted,
  responseCreated,
  selectMcpTool,
} from '../modules/response-protocol.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT = `执行者工具验收-${process.pid}`
const AGENT = `执行者智能体-${process.pid}`
const GROUP = `执行者协作小组-${process.pid}`
const ISSUE = `执行者附件验收-${process.pid}`
const STAGE = '读取 Issue 并上传附件'
const MODEL = 'wework-custom-desktop-e2e-responses'
const MARKER = `LOCAL_EXECUTOR_ISSUE_TOOLS_${process.pid}`
const ATTACHMENT = `${MARKER}.txt`
const CALLS = {
  context: `${MARKER}-context`,
  upload: `${MARKER}-upload`,
  attachments: `${MARKER}-attachments`,
}

function scoped(selector) {
  return `${CONTENT} ${selector}`
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function toolName(body, name) {
  return (body.tools ?? [])
    .map(tool => tool?.name ?? tool?.function?.name)
    .find(value => value === name || value?.endsWith(`__${name}`))
}

function outputFor(value, callId) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = outputFor(entry, callId)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  if (
    ['function_call_output', 'mcp_tool_call_output', 'custom_tool_call_output'].includes(
      value.type
    ) &&
    value.call_id === callId
  ) {
    return value.output
  }
  for (const entry of Object.values(value)) {
    const found = outputFor(entry, callId)
    if (found !== undefined) return found
  }
  return undefined
}

function writeEvents(response, responseId, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.end(createSse([responseCreated(responseId), ...events, responseCompleted(responseId)]))
}

function toolEvents(body, name, args, callId) {
  const searchCallId = `${callId}-search`
  if (requestContainsToolOutput(body, searchCallId)) {
    const searched = requestToolSearchResults(body)
    const namespace = searched.find(
      candidate =>
        candidate?.type === 'namespace' &&
        candidate.name === 'wework_space' &&
        candidate.tools?.some(tool => tool?.type === 'function' && tool.name === name)
    )
    if (namespace) {
      const tool = selectMcpTool(body, 'wework_space', name, args)
      return namespacedFunctionCall(callId, tool.namespace, tool.name, tool.arguments)
    }
    const converted = searched
      .map(tool => tool?.name ?? tool?.function?.name)
      .find(value => value === name || value?.endsWith(`__${name}`))
    assert.ok(converted, `The executor MCP search did not expose ${name}`)
    return functionCall(callId, converted, args)
  }
  return mcpToolRequestEvents(body, {
    toolName: name,
    argumentsValue: args,
    directToolName: toolName(body, name),
    searchCallId,
    toolCallId: callId,
  }).events
}

export async function createDesktopScenario({ executorHome, modelResponseTimeoutMs, uiTimeoutMs }) {
  const attachmentPath = join(executorHome, ATTACHMENT)
  await mkdir(executorHome, { recursive: true })
  await writeFile(attachmentPath, `${MARKER}\n`, 'utf8')
  let active = false
  let contextSeen = false
  let attachmentSeen = false
  let completed = false

  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/models/unified') {
        json(response, 200, {
          data: [
            {
              name: MODEL,
              type: 'public',
              displayName: 'Desktop E2E Public',
              namespace: 'default',
              isActive: true,
            },
          ],
        })
        return true
      }
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(request)
      if (!JSON.stringify(body).includes(MARKER)) return false
      const responseId = `local-executor-${Date.now()}`
      const kind = codexRequestKind(body)
      if (kind === 'prewarm' || kind === 'compaction') {
        writeEvents(response, responseId, [assistantMessage('Ready')])
        return true
      }
      if (requestContainsToolOutput(body, CALLS.attachments)) {
        const output = JSON.stringify(outputFor(body.input ?? [], CALLS.attachments))
        assert.ok(output.includes(ATTACHMENT), 'The uploaded Issue attachment was not persisted')
        attachmentSeen = true
        completed = true
        writeEvents(response, responseId, [assistantMessage(`${MARKER}:completed`)])
        return true
      }
      let name = 'get_current_context'
      let args = {}
      let callId = CALLS.context
      if (requestContainsToolOutput(body, CALLS.upload)) {
        const output = JSON.stringify(outputFor(body.input ?? [], CALLS.upload))
        assert.ok(output.includes(ATTACHMENT), 'The Issue attachment upload failed')
        name = 'list_item_attachments'
        callId = CALLS.attachments
      } else if (requestContainsToolOutput(body, CALLS.context)) {
        const output = JSON.stringify(outputFor(body.input ?? [], CALLS.context))
        assert.ok(output.includes(ISSUE), 'The executor did not receive its bound Issue')
        contextSeen = true
        name = 'upload_item_attachment'
        args = { file_path: attachmentPath, display_name: ATTACHMENT, content_type: 'text/plain' }
        callId = CALLS.upload
      }
      writeEvents(response, responseId, toolEvents(body, name, args, callId))
      return true
    },

    async verify(control) {
      active = true
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)

      await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-settings-participants"]')
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-participants-tab-agents"]')
      )
      await control.command('clickWhenEnabled', scoped('[data-testid="project-agent-add"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
        value: AGENT,
      })
      await control.command('select', '[data-testid="cloud-project-chat-agent-model"]', {
        value: MODEL,
      })
      await control.command(
        'click',
        '[data-testid="cloud-project-chat-agent-editor-advanced-toggle"]'
      )
      await control.command('fill', '[data-testid="cloud-project-chat-agent-system-prompt"]', {
        value: `${MARKER} Use get_current_context, upload_item_attachment, and list_item_attachments.`,
      })
      await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'click',
        scoped('[data-testid="collaboration-participants-tab-groups"]')
      )
      await control.command('click', scoped('[data-testid="collaboration-group-open-create"]'))
      await control.command('fill', scoped('[data-testid="collaboration-group-name"]'), {
        value: GROUP,
      })
      await control.command(
        'click',
        scoped('[data-testid="collaboration-group-create-add-members"]')
      )
      const memberTestId = await waitForTestIdByText(
        control,
        CONTENT,
        'collaboration-group-create-member-agent-',
        AGENT,
        uiTimeoutMs
      )
      await control.command('click', `[data-testid="${memberTestId}"]`)
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="collaboration-group-create"]'),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-group-detail-tab-rules"]'),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('click', scoped('[data-testid="collaboration-group-detail-tab-rules"]'))
      await control.command('click', scoped('[data-testid="collaboration-group-stage-add"]'))
      const snapshot = JSON.parse(await control.command('snapshot', CONTENT))
      const stageTestId = snapshot.testIds.find(
        testId =>
          testId.startsWith('collaboration-group-stage-') &&
          testId !== 'collaboration-group-stage-add'
      )
      assert.ok(stageTestId, 'The preset executor stage was not added')
      await control.command('fill', scoped(`[data-testid="${stageTestId}"] input`), {
        value: STAGE,
      })
      await control.command('fill', scoped(`[data-testid="${stageTestId}"] textarea`), {
        value: 'Read the bound Issue and upload the requested attachment.',
      })
      const agentId = memberTestId.slice('collaboration-group-create-member-agent-'.length)
      await control.command('select', scoped(`[data-testid="${stageTestId}"] select`), {
        value: `agent:${agentId}`,
      })
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="collaboration-group-detail-save"]'),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      const groupTestId = await waitForTestIdByText(
        control,
        CONTENT,
        'collaboration-group-detail-local-group-',
        GROUP,
        uiTimeoutMs
      )
      const groupId = groupTestId.slice('collaboration-group-detail-'.length)

      await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
      await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
      await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
        value: `${ISSUE} ${MARKER}`,
      })
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="cloud-todo-create-confirm"]'),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped('[data-testid="cloud-todo-detail-assignee"]'))
      await control.command(
        'click',
        `[data-testid="cloud-todo-detail-assignee-option-group:${groupId}"]`
      )
      await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        scoped('[data-testid^="cloud-task-activity-execution-status-"][data-status="succeeded"]'),
        {
          timeoutMs: modelResponseTimeoutMs,
        }
      )
      assert.ok(contextSeen, 'The executor did not read the bound Issue through real MCP')
      assert.ok(attachmentSeen, 'The executor did not list its uploaded Issue attachment')
      assert.ok(completed, 'The executor model sequence did not finish')
    },

    diagnostics() {
      return { contextSeen, attachmentSeen, completed }
    },
  }
}
