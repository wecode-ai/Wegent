import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ACTIVE_COMPOSER_SELECTOR } from './shared.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import {
  applyPatchResponseEvents,
  createSse,
  responseCreated,
  responseCompleted,
} from './response-protocol.mjs'

const TOOL_CALL = 'upgrade-persisted-tool-call'
const TOOL_FILE = 'upgrade-persisted-tool.txt'
const TOOL_CONTENT = 'WEWORK_UPGRADE_REAL_TOOL_HISTORY'

/** Assert native history reaches inference, not just the restored renderer. */
export function createUpgradeConversationContinuity(control, timeoutMs) {
  const completed = []
  let threadId
  let taskId
  let toolWorkspace
  let toolSeeded = false
  return {
    nativeThread() {
      assert.ok(threadId)
      return threadId
    },
    seedTool(workspace) {
      toolWorkspace = workspace
    },
    toolResponse(body, response) {
      if (!toolWorkspace || toolSeeded) return false
      toolSeeded = true
      const patch = `*** Begin Patch\n*** Add File: ${TOOL_FILE}\n+${TOOL_CONTENT}\n*** End Patch`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([
          responseCreated(TOOL_CALL),
          ...applyPatchResponseEvents(body, TOOL_CALL, patch),
          responseCompleted(TOOL_CALL),
        ])
      )
      return true
    },
    observeModel(body) {
      const input = JSON.stringify(body.input ?? body.messages)
      for (const turn of completed) {
        assert.ok(input?.includes(turn.prompt), 'Upgrade lost a previous user input at inference')
        assert.ok(
          input?.includes(turn.answer),
          'Upgrade lost a previous assistant output at inference'
        )
      }
      if (toolSeeded && completed.length) {
        assert.ok(
          input?.includes(TOOL_CALL),
          'Upgrade lost persisted tool call/output identity at inference'
        )
        assert.ok(
          input?.includes(TOOL_CONTENT),
          'Upgrade lost the original tool arguments at inference'
        )
      }
    },
    async send(prompt, answer) {
      const client = control()
      await client.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
      await client.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: prompt })
      await client.command('clickWhenEnabled', '[data-testid="send-message-button"]')
      await client.command('waitFor', '[data-testid="message-assistant"]', {
        text: answer,
        timeoutMs,
      })
      if (toolWorkspace)
        assert.equal(
          await readFile(join(toolWorkspace, TOOL_FILE), 'utf8'),
          `${TOOL_CONTENT}\n`,
          'The real tool must create its artifact successfully'
        )
      completed.push({ prompt, answer })
    },
    async assertThread() {
      const client = control()
      const snapshot = JSON.parse(await client.command('getWorkbenchDebugSnapshot', 'body'))
      const address = snapshot.pane?.currentRuntimeTask
      assert.ok(address?.taskId, 'Upgrade continuation requires the original runtime task')
      const { task } = await requestExecutor(client, 'runtime.tasks.get', { address }, timeoutMs)
      assert.ok(task.threadId, 'Upgrade continuation requires the original native thread')
      if (threadId) {
        assert.equal(
          task.threadId,
          threadId,
          'Upgrade must not replace or replay the native thread'
        )
        assert.equal(address.taskId, taskId, 'Upgrade must retain the task identity')
      } else {
        threadId = task.threadId
        taskId = address.taskId
      }
    },
    evidence() {
      assert.ok(threadId)
      return {
        sameNativeThread: true,
        verifiedTurns: completed.length,
        ...(toolWorkspace ? { realToolHistoryPreserved: toolSeeded } : {}),
      }
    },
  }
}
