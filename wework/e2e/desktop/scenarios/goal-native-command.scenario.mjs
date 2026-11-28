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
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const GOAL = 'Run native diagnostics in a continuation turn'
const PROMPT = 'Prepare to run native diagnostics'
const FIRST_REPLY = 'The diagnostic command will run on the next turn.'
const CALL = 'sample-isolated-process'
const DONE = 'Native diagnostic command completed'
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
  let commandCompleted = false
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body.input).includes(PROMPT)) return false
      const id = `goal-native-command-${++requests}`
      const result = accountCommandResult(body.input, CALL)
      let events
      if (requests === 1) {
        events = [assistantMessage(FIRST_REPLY)]
      } else if (!result) {
        events = shellCommandResponse(
          body,
          CALL,
          PLATFORM_COMMAND[process.platform],
          workspacePath,
          {
            yield_time_ms: 10_000,
          }
        )
      } else if (result.sessionId) {
        events = shellCommandPollResponse(body, result.pollId, result.sessionId)
      } else if (commandCompleted) {
        events = [assistantMessage(DONE)]
      } else {
        assert.ok(result.output.includes(DONE), result.output)
        commandCompleted = true
        events = selectedToolCall(
          'complete-native-diagnostics-goal',
          selectTool(body, 'update_goal', { status: 'complete' })
        )
      }
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
        text: DONE,
        timeoutMs: 15000,
      })
      assert.ok(commandCompleted, 'Codex did not receive successful native command output')
      await waitForWorkbenchDebugState(
        control,
        snapshot =>
          snapshot.workbench?.activeLifecycle?.goalStatus === 'complete' &&
          snapshot.pane?.status?.isBusy === false,
        'The Goal remained busy after receiving the native command result'
      )
    },
    diagnostics: () => ({ requests, commandCompleted }),
  }
}
