import { readRawRequestBody } from '../modules/response-protocol.mjs'
import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import assert from 'node:assert/strict'

import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { handleEmptyReplyPrediction } from '../modules/response-protocol.mjs'
import { verifySidebarHoverLifecycle } from '../modules/sidebar-hover.mjs'

const WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER = `${WORKBENCH} [data-testid="chat-message-input"][contenteditable="true"]`
const FIRST = 'WEWORK_E2E_SIDEBAR_FIRST'
const SECOND = 'WEWORK_E2E_SIDEBAR_SECOND'
const FILLER = 'WEWORK_E2E_SIDEBAR_FILLER_'

function streamEvents(id, text, completed) {
  const item = {
    id: `${id}-message`,
    type: 'message',
    role: 'assistant',
    status: completed ? 'completed' : 'in_progress',
    content: [{ type: 'output_text', text, annotations: [] }],
    phase: 'final_answer',
  }
  const events = completed
    ? [
        {
          type: 'response.output_text.done',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text,
        },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
        },
      ]
    : [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        {
          type: 'response.content_part.added',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
        {
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: text,
          offset: 0,
        },
      ]
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

async function listTasks(control, timeoutMs) {
  const origin = await control.command('getLocationOrigin', 'body')
  const response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'sidebar-state-list', method: 'runtime.tasks.list', params: {} }),
    timeoutMs: timeoutMs,
  })
  const payload = await response.json()
  assert.equal(response.ok, true)
  assert.equal(payload.ok, true, payload.error?.message)
  return payload.result.workspaces.flatMap(workspace => workspace.tasks)
}

async function taskSnapshot(control, taskId, running, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const task = (await listTasks(control, timeoutMs)).find(task => task.taskId === taskId)
    if (task?.running === running && (running || task.completedAt != null)) return task
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Executor task ${taskId} did not become running=${running}`)
}

export function createDesktopScenario({ uiTimeoutMs, workspacePath }) {
  let active = false
  let release
  const held = new Promise(resolve => {
    release = resolve
  })
  let requests = 0

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      )
        return false
      const body = await readRawRequestBody(request)
      if (handleEmptyReplyPrediction(JSON.parse(body), response)) return true
      assert.ok(body.includes(FIRST) || body.includes(FILLER))
      requests += 1
      const id = `sidebar-state-${requests}`
      const filler = body.match(/WEWORK_E2E_SIDEBAR_FILLER_\d+/)?.[0]
      const text = filler
        ? `${filler}_COMPLETE`
        : requests === 1
          ? `${FIRST}_COMPLETE`
          : `${SECOND}_RUNNING`
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      response.flushHeaders()
      response.write(streamEvents(id, text, false))
      if (requests === 2) await held
      response.end(streamEvents(id, text, true))
      return true
    },

    async verify(control) {
      active = true
      try {
        await createSingleRootLocalProject(control, workspacePath, 'running-sidebar-state')
        const project = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        await verifySidebarHoverLifecycle(control, project.workbench.currentProject.id, uiTimeoutMs)
        await control.command('waitFor', COMPOSER, { timeoutMs: uiTimeoutMs })
        await selectE2EModel(control, undefined, undefined, WORKBENCH)
        await control.command('fill', COMPOSER, { value: FIRST })
        await control.command('press', COMPOSER, { key: 'Enter' })
        await control.command('waitFor', `${WORKBENCH} [data-testid="message-assistant"]`, {
          text: `${FIRST}_COMPLETE`,
          timeoutMs: uiTimeoutMs,
        })
        const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        const address = debug.workbench.currentRuntimeTask
        assert.ok(address?.taskId)
        // Retain a real completed response and deliver it after the next real turn starts.
        const completed = await taskSnapshot(control, address.taskId, false, uiTimeoutMs)
        await control.command('waitFor', COMPOSER, { stableMs: 1500, timeoutMs: uiTimeoutMs })
        await control.command('fill', COMPOSER, { value: SECOND })
        await control.command('press', COMPOSER, { key: 'Enter' })
        await control.command('waitFor', `${WORKBENCH} [data-testid="message-assistant"]`, {
          text: `${SECOND}_RUNNING`,
          timeoutMs: uiTimeoutMs,
        })
        const running = await taskSnapshot(control, address.taskId, true, uiTimeoutMs)
        console.info('[running-sidebar-state] real executor snapshots', {
          completed: {
            status: completed.status,
            running: completed.running,
            completedAt: completed.completedAt,
            updatedAt: completed.updatedAt,
          },
          running: {
            status: running.status,
            running: running.running,
            completedAt: running.completedAt,
            updatedAt: running.updatedAt,
          },
        })
        assert.ok(Number(completed.completedAt) < Number(running.updatedAt))
        for (const task of [running, completed]) {
          await control.command('dispatchRuntimeLifecycleEvent', 'body', {
            value: JSON.stringify({ type: 'executor_snapshot_received', address, task }),
          })
        }
        const afterReplay = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        assert.equal(
          afterReplay.workbench.activeLifecycle.execution.running,
          true,
          'A previous turn completion snapshot cleared the live execution'
        )
        assert.equal(
          afterReplay.workbench.activeLifecycle.turn.phase,
          'streaming',
          'A previous turn completion snapshot cleared the live turn'
        )
        const spinner = `[data-testid="runtime-local-task-running-${address.taskId}"]`
        await control.command('waitFor', spinner, { stableMs: 500, timeoutMs: uiTimeoutMs })
        const projectButton = `[data-testid="project-row-${debug.workbench.currentProject.id}"] [data-testid="project-item-button"]`
        await control.command('click', projectButton)
        assert.equal(
          await control.command('getAttribute', projectButton, { value: 'aria-expanded' }),
          'false'
        )
        await control.command('click', projectButton)
        await control.command('waitFor', spinner, { stableMs: 500, timeoutMs: uiTimeoutMs })
        await control.command('waitFor', '[data-testid="pause-response-button"]', {
          timeoutMs: uiTimeoutMs,
        })
        const projectId = debug.workbench.currentProject.id
        const newConversation = `[data-testid="project-row-${projectId}"] [data-testid="project-new-conversation-button"]`
        // Move the live task below the preview limit through real completed tasks.
        for (let index = 0; index < 6; index += 1) {
          await control.command('click', newConversation)
          await control.command('waitFor', COMPOSER, { timeoutMs: uiTimeoutMs })
          await control.command('fill', COMPOSER, { value: `${FILLER}${index}` })
          await control.command('press', COMPOSER, { key: 'Enter' })
          await control.command('waitFor', `${WORKBENCH} [data-testid="message-assistant"]`, {
            text: `${FILLER}${index}_COMPLETE`,
            timeoutMs: uiTimeoutMs,
          })
        }
        await control.command('waitFor', spinner, { timeoutMs: uiTimeoutMs })
        await control.command('click', `[data-testid="project-runtime-tasks-expand-${projectId}"]`)
        await control.command('waitFor', spinner, { timeoutMs: uiTimeoutMs })
        await control.command(
          'click',
          `[data-testid="project-runtime-tasks-collapse-${projectId}"]`
        )
        await control.command('waitFor', spinner, { timeoutMs: uiTimeoutMs })
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await control.command('waitFor', '[data-testid="pause-response-button"]', {
          timeoutMs: uiTimeoutMs,
        })
        release()
        await control.command('waitFor', spinner, { visible: false, timeoutMs: uiTimeoutMs })
        assert.equal(requests, 8)
      } finally {
        release()
        active = false
      }
    },
  }
}
