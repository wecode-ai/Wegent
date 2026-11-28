import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { accountCommandResult } from '../modules/account-auth-command.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectedToolCall,
  selectTool,
  toolOutputText,
} from '../modules/response-protocol.mjs'
import {
  shellCommandPollResponse,
  shellCommandResponse,
} from '../modules/shell-command-response.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  selectE2EModel,
} from '../modules/shared.mjs'
import { isCollaborationSubagentRequest } from '../modules/subagent-request.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const GOAL = 'Run native diagnostics in a continuation turn'
const PROMPT = 'Prepare to run native diagnostics'
const FIRST_REPLY = 'The diagnostic command will run on the next turn.'
const CALL = 'sample-isolated-process'
const DONE = 'Native diagnostic command completed'
const CHILD_PROMPT = 'Run the separate native shell diagnostic probe'
const CHILD_CALL = 'child-native-diagnostics'
const CHILD_DONE = 'Child native diagnostic probe completed'
const SPAWN = 'spawn-native-diagnostics-probe'
const COMPLETE = 'complete-native-diagnostics-goal'
const GOAL_DONE = 'Native diagnostic Goal completed'
const FIXTURE = 'isolated-diagnostic-probe.tmp'
const MACOS_COMMAND = String.raw`set -eu
tmp=$(mktemp -d)
sleep 25 &
child=$!
trap 'kill "$child" 2>/dev/null || true; rm -rf "$tmp"' EXIT
/usr/bin/sample "$child" 1 1 -file "$tmp/threads.txt" >"$tmp/sample.stderr" 2>&1
/usr/bin/vmmap -summary "$child" >"$tmp/memory.txt" 2>"$tmp/vmmap.stderr"
test -s "$tmp/threads.txt"
test -s "$tmp/memory.txt"
printf '%s\n' '${DONE}'`

const PLATFORM_COMMAND = {
  darwin: MACOS_COMMAND,
  win32: `Remove-Item -LiteralPath './${FIXTURE}' -Force -ErrorAction Stop; Write-Output '${DONE}'`,
  linux: `rm -f './${FIXTURE}' && printf '%s\\n' '${DONE}'`,
}

export function createDesktopScenario({ workspacePath }) {
  let requests = 0
  let waits = 0
  let commandCompleted = false
  let childCompleted = false

  function runDiagnostic(body, callId) {
    const result = accountCommandResult(body.input, callId)
    if (!result) {
      return shellCommandResponse(body, callId, PLATFORM_COMMAND[process.platform], workspacePath, {
        yield_time_ms: 10_000,
      })
    }
    if (result.sessionId) return shellCommandPollResponse(body, result.pollId, result.sessionId)
    assert.ok(result.output.includes(DONE), result.output)
    return null
  }

  function childEvents(body) {
    const events = runDiagnostic(body, CHILD_CALL)
    if (events) return events
    childCompleted = true
    return [assistantMessage(CHILD_DONE)]
  }

  function goalEvents(body, input) {
    if (!commandCompleted) {
      const events = runDiagnostic(body, CALL)
      if (events) return events
      commandCompleted = true
    }
    if (toolOutputText(body, COMPLETE) != null) return [assistantMessage(GOAL_DONE)]
    if (input.includes(CHILD_DONE)) {
      return selectedToolCall(COMPLETE, selectTool(body, 'update_goal', { status: 'complete' }))
    }
    if (toolOutputText(body, SPAWN) == null) {
      return selectedToolCall(
        SPAWN,
        selectTool(body, 'spawn_agent', { task_name: 'diagnostic_probe', message: CHILD_PROMPT })
      )
    }
    assert.ok(++waits <= 3, 'The native Goal did not receive the child diagnostic result')
    return selectedToolCall(
      `wait-diagnostic-probe-${waits}`,
      selectTool(body, 'wait_agent', { timeout_ms: 10_000 })
    )
  }

  return {
    codexConfigToml: '[features.multi_agent_v2]\nenabled = true\n',
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const input = JSON.stringify(body.input)
      const isChild =
        isCollaborationSubagentRequest(request.headers) && input.includes(CHILD_PROMPT)
      if (!isChild && !input.includes(PROMPT)) return false
      const id = `goal-native-command-${++requests}`
      const events = isChild
        ? childEvents(body)
        : requests === 1
          ? [assistantMessage(FIRST_REPLY)]
          : goalEvents(body, input)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      if (process.platform !== 'darwin') {
        await writeFile(join(workspacePath, FIXTURE), 'Isolated command approval fixture')
      }
      await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]')
      await selectE2EModel(control)
      const permissions = '[data-testid="permission-mode-menu-button"]'
      await control.command('click', permissions)
      await control.command('click', '[data-testid="permission-mode-workspace-write"]')
      await control.command('click', permissions)
      await control.command('click', '[data-testid="permission-mode-full-access"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="command-approval-confirm-option-automatic"]'
      )
      await control.command('clickWhenEnabled', '[data-testid="full-access-confirm-submit"]')
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FIRST_REPLY,
        timeoutMs: 10000,
      })
      const idle = await waitForWorkbenchDebugState(
        control,
        snapshot =>
          snapshot.workbench?.currentRuntimeTask && snapshot.pane?.status?.isBusy === false,
        'The original turn did not release its local execution'
      )
      const activation = await requestExecutor(
        control,
        'runtime.tasks.goal.set',
        {
          address: idle.workbench.currentRuntimeTask,
          objective: GOAL,
          status: 'active',
        },
        10000
      )
      assert.equal(activation.goal?.status, 'active', JSON.stringify(activation))
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: GOAL_DONE,
        timeoutMs: 20_000,
      })
      assert.ok(commandCompleted, 'Codex did not receive successful native command output')
      assert.ok(childCompleted, 'The child command did not receive automatic approval')
      await waitForWorkbenchDebugState(
        control,
        snapshot =>
          snapshot.workbench?.activeLifecycle?.goalStatus === 'complete' &&
          snapshot.pane?.status?.isBusy === false,
        'The Goal remained busy after receiving the native command result'
      )
    },
    diagnostics: () => ({ requests, commandCompleted, childCompleted }),
  }
}
