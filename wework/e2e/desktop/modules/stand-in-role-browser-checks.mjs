import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { ACTIVE_WORKBENCH_SELECTOR, selectE2EModel } from './shared.mjs'
import { storyUntil } from './stand-in-source-story-evidence.mjs'
import { waitForAttribute } from './workspace-flows.mjs'
import {
  assistantMessage,
  mcpToolRequestEvents,
  requestContainsToolOutput,
} from './response-protocol.mjs'

const READ_ONLY_BROWSER_FOLLOW_UP = '请核验只读模式下的浏览器打开审批。'
const READ_ONLY_BROWSER_RESULT = '只读模式下浏览器操作已按用户拒绝停止。'
const ORDINARY_READ_ONLY_BROWSER_PROMPT = '请核验普通只读任务的浏览器打开审批。'
const ORDINARY_READ_ONLY_BROWSER_RESULT = '普通只读任务下浏览器操作已按用户拒绝停止。'
const BROWSER_APPROVAL_FOLLOW_UP = '请核验委派任务的浏览器页面与清理确认。'
const BROWSER_APPROVAL_RESULT = '委派任务浏览器已按浏览器设置完成确认与清理。'
const BROWSER_FULL_CONTROL_FOLLOW_UP = '开启浏览器完全控制后再次核验浏览器清理。'
const BROWSER_FULL_CONTROL_RESULT = '开启完全控制后浏览器已直接完成清理。'
const ORDINARY_BROWSER_APPROVAL_PROMPT = '请核验普通完整访问任务的浏览器页面与清理确认。'
const ORDINARY_BROWSER_APPROVAL_RESULT = '普通完整访问任务浏览器已按设置完成确认与清理。'
const ORDINARY_BROWSER_FULL_CONTROL_PROMPT = '普通完整访问任务开启浏览器完全控制后再次核验清理。'
const ORDINARY_BROWSER_FULL_CONTROL_RESULT = '普通完整访问任务开启完全控制后已直接完成清理。'
const BROWSER_APPROVAL_FIXTURE = '/role-browser-approval-fixture'
const BROWSER_COOKIE = 'wework_role_browser_e2e=present'

export function createNativeProfileWaiter(executorLog, uiTimeoutMs) {
  return (taskId, profile, fromOffset = 0) =>
    storyUntil(
      async () =>
        (await readFile(executorLog, 'utf8'))
          .slice(fromOffset)
          .split('\n')
          .filter(line => line.includes(`codex source sandbox applied task_id=${taskId} `)),
      lines =>
        lines.some(
          line =>
            line.includes(String.raw`\"id\":\"${profile}\"`) &&
            line.includes(String.raw`reviewer="\"user\""`)
        ),
      uiTimeoutMs,
      `Task ${taskId} must run with native profile ${profile} and the human reviewer`
    )
}

/** Browser fixture and permission comparison for the existing delegation checkpoint. */
export function createStandInRoleBrowserChecks(reply) {
  let readOnlyBrowserReported = false
  let browserFollowUpReported = false
  let browserFullControlReported = false
  let browserFixtureRequests = 0
  let browserFixtureUrl
  const browserTool = (body, name, id, args = {}) =>
    mcpToolRequestEvents(body, {
      toolName: name,
      directToolName: `mcp__wework_browser__${name}`,
      argumentsValue: args,
      searchCallId: `${id}-discovery`,
      toolCallId: id,
    }).events

  return {
    prepare(control) {
      browserFixtureUrl = `${control.url}${BROWSER_APPROVAL_FIXTURE}`
    },
    handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === BROWSER_APPROVAL_FIXTURE) {
        browserFixtureRequests += 1
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(
          `<!doctype html><html><head><meta charset="utf-8" /><title>Browser approval fixture</title></head><body><h1>Browser approval fixture</h1><script>if (new URLSearchParams(location.search).get('set') === '1') { document.cookie = '${BROWSER_COOKIE}; Path=/'; }</script></body></html>`
        )
        return true
      }
      return false
    },
    handleModel(body, latest, response) {
      if (
        latest.includes(READ_ONLY_BROWSER_FOLLOW_UP) ||
        latest.includes(ORDINARY_READ_ONLY_BROWSER_PROMPT)
      ) {
        const isOrdinary = latest.includes(ORDINARY_READ_ONLY_BROWSER_PROMPT)
        const callId = isOrdinary ? 'ordinary-readonly-browser-open' : 'readonly-browser-open'
        assert.ok(browserFixtureUrl)
        if (!requestContainsToolOutput(body, callId)) {
          reply(
            response,
            browserTool(body, 'browser_open_and_inspect', callId, {
              url: `${browserFixtureUrl}?set=1&readonly=${isOrdinary ? 'ordinary' : 'role'}`,
            })
          )
        } else {
          assert.equal(
            browserFixtureRequests,
            0,
            'Declined read-only browser MCP approval must block opening the URL'
          )
          reply(response, [
            assistantMessage(
              isOrdinary ? ORDINARY_READ_ONLY_BROWSER_RESULT : READ_ONLY_BROWSER_RESULT
            ),
          ])
        }
        return true
      }
      const handleBrowserApprovalCheck = (prefix, expectedFixturesAfterOpen, completionText) => {
        assert.ok(browserFixtureUrl)
        if (!requestContainsToolOutput(body, `${prefix}-browser-open`)) {
          reply(
            response,
            browserTool(body, 'browser_open_and_inspect', `${prefix}-browser-open`, {
              url: `${browserFixtureUrl}?set=1&scope=${prefix}`,
            })
          )
        } else if (!requestContainsToolOutput(body, `${prefix}-browser-clear-reject`)) {
          assert.equal(
            browserFixtureRequests,
            expectedFixturesAfterOpen,
            `${prefix} browser open must load directly without runtime MCP prompt`
          )
          assert.ok(
            readMcpToolOutput(body, `${prefix}-browser-open`).includes(
              'Combined: open_and_inspect ok=true'
            )
          )
          reply(
            response,
            browserTool(body, 'browser_clear_data', `${prefix}-browser-clear-reject`, {
              kinds: ['cookies'],
            })
          )
        } else if (!requestContainsToolOutput(body, `${prefix}-browser-cookie-retained`)) {
          assert.ok(
            readMcpToolOutput(body, `${prefix}-browser-clear-reject`).includes('approval_rejected')
          )
          reply(
            response,
            browserTool(body, 'browser_evaluate', `${prefix}-browser-cookie-retained`, {
              expression: `document.cookie.includes('${BROWSER_COOKIE}')`,
            })
          )
        } else if (!requestContainsToolOutput(body, `${prefix}-browser-clear-approve`)) {
          assert.equal(
            JSON.parse(readMcpToolOutput(body, `${prefix}-browser-cookie-retained`)).value,
            true
          )
          reply(
            response,
            browserTool(body, 'browser_clear_data', `${prefix}-browser-clear-approve`, {
              kinds: ['cookies'],
            })
          )
        } else if (!requestContainsToolOutput(body, `${prefix}-browser-cookie-cleared`)) {
          assert.ok(
            readMcpToolOutput(body, `${prefix}-browser-clear-approve`).includes('"success":true')
          )
          reply(
            response,
            browserTool(body, 'browser_evaluate', `${prefix}-browser-cookie-cleared`, {
              expression: `document.cookie.includes('${BROWSER_COOKIE}')`,
            })
          )
        } else {
          assert.equal(
            JSON.parse(readMcpToolOutput(body, `${prefix}-browser-cookie-cleared`)).value,
            false
          )
          reply(response, [assistantMessage(completionText)])
        }
        return true
      }
      const handleBrowserFullControlCheck = (prefix, expectedFixturesAfterOpen, completionText) => {
        assert.ok(browserFixtureUrl)
        if (!requestContainsToolOutput(body, `${prefix}-full-browser-open`)) {
          reply(
            response,
            browserTool(body, 'browser_open_and_inspect', `${prefix}-full-browser-open`, {
              url: `${browserFixtureUrl}?set=1&full=1&scope=${prefix}`,
            })
          )
        } else if (!requestContainsToolOutput(body, `${prefix}-full-browser-clear`)) {
          assert.equal(browserFixtureRequests, expectedFixturesAfterOpen)
          assert.ok(
            readMcpToolOutput(body, `${prefix}-full-browser-open`).includes(
              'Combined: open_and_inspect ok=true'
            )
          )
          reply(
            response,
            browserTool(body, 'browser_clear_data', `${prefix}-full-browser-clear`, {
              kinds: ['cookies'],
            })
          )
        } else if (!requestContainsToolOutput(body, `${prefix}-full-browser-verify`)) {
          assert.ok(
            readMcpToolOutput(body, `${prefix}-full-browser-clear`).includes('"success":true')
          )
          reply(
            response,
            browserTool(body, 'browser_evaluate', `${prefix}-full-browser-verify`, {
              expression: `document.cookie.includes('${BROWSER_COOKIE}')`,
            })
          )
        } else {
          assert.equal(
            JSON.parse(readMcpToolOutput(body, `${prefix}-full-browser-verify`)).value,
            false
          )
          reply(response, [assistantMessage(completionText)])
        }
        return true
      }
      if (latest.includes(ORDINARY_BROWSER_APPROVAL_PROMPT)) {
        return handleBrowserApprovalCheck('ordinary', 1, ORDINARY_BROWSER_APPROVAL_RESULT)
      }
      if (latest.includes(ORDINARY_BROWSER_FULL_CONTROL_PROMPT)) {
        return handleBrowserFullControlCheck('ordinary', 2, ORDINARY_BROWSER_FULL_CONTROL_RESULT)
      }
      if (latest.includes(BROWSER_APPROVAL_FOLLOW_UP)) {
        return handleBrowserApprovalCheck('role', 3, BROWSER_APPROVAL_RESULT)
      }
      if (latest.includes(BROWSER_FULL_CONTROL_FOLLOW_UP)) {
        return handleBrowserFullControlCheck('role', 4, BROWSER_FULL_CONTROL_RESULT)
      }
      return false
    },
    handleDelegatedResult({ child, writingTaskId, resultId, reported, results, latest, response }) {
      if (child === writingTaskId && JSON.stringify(results).includes(READ_ONLY_BROWSER_RESULT)) {
        assert.equal(readOnlyBrowserReported, false, 'The read-only browser check reports once')
        readOnlyBrowserReported = true
        reply(response, [])
        return true
      }
      if (child === writingTaskId && JSON.stringify(results).includes(BROWSER_APPROVAL_RESULT)) {
        assert.equal(browserFollowUpReported, false, 'The browser follow-up must report once')
        assert.ok(reported.has(child), 'The original branch must have reported first')
        assert.notEqual(resultId, reported.get(child), 'The follow-up must have a new result')
        assert.ok(latest.includes('status=done,'), 'The browser approval check must complete')
        browserFollowUpReported = true
        reply(response, [])
        return true
      }
      if (
        child === writingTaskId &&
        JSON.stringify(results).includes(BROWSER_FULL_CONTROL_RESULT)
      ) {
        assert.equal(
          browserFullControlReported,
          false,
          'The full-control browser follow-up must report once'
        )
        assert.ok(reported.has(child), 'The original branch must have reported first')
        assert.notEqual(resultId, reported.get(child), 'The follow-up must have a new result')
        assert.ok(latest.includes('status=done,'), 'The full-control browser check must complete')
        browserFullControlReported = true
        reply(response, [])
        return true
      }
      return false
    },
    async verify({
      control,
      uiTimeoutMs,
      modelResponseTimeoutMs,
      reopenDelegatedTask,
      writingTaskId,
      executorLog,
      waitForNativeProfile,
      readOnlyWorkspace,
    }) {
      const taskMode = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="permission-mode-menu-button"]`
      await reopenDelegatedTask(true)
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`,
        {
          text: '面向内部团队的公告草稿已就绪。',
        }
      )
      await control.command('clickWhenEnabled', `${taskMode}[aria-label*="工作区"]`)
      await control.command('clickWhenEnabled', '[data-testid="permission-mode-read-only"]')
      await control.command('waitFor', `${taskMode}[aria-label*="只读"]`)
      const fromOffset = (await readFile(executorLog, 'utf8')).length
      await control.command(
        'fill',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`,
        { value: readOnlyWorkspace.prompt }
      )
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`,
        {
          text: readOnlyWorkspace.result,
          timeoutMs: modelResponseTimeoutMs,
        }
      )
      await waitForNativeProfile(writingTaskId, 'wework-source-read', fromOffset)
      await assert.rejects(readFile(readOnlyWorkspace.file), { code: 'ENOENT' })
      await storyUntil(
        () => Promise.resolve(readOnlyWorkspace.reported()),
        Boolean,
        modelResponseTimeoutMs,
        'The read-only follow-up must deliver its distinct result to the original conversation'
      )
      const mcpApprovalCard = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-card"]`
      const mcpDeclineOption = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-option-__mcp_approval-1"]`
      const browserApproveButton = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-agent-approval-approve-button"]`
      const browserRejectButton = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-agent-approval-reject-button"]`
      const fullControlToggle = '[data-testid="browser-full-control-toggle"]'
      const enableFullAccessInActiveTask = async () => {
        await control.command('clickWhenEnabled', taskMode)
        await control.command('clickWhenEnabled', '[data-testid="permission-mode-full-access"]')
        await control.command('clickWhenEnabled', '[data-testid="full-access-confirm-submit"]')
        await control.command('waitFor', `${taskMode}[aria-label*="完整访问"]`, {
          timeoutMs: uiTimeoutMs,
        })
      }
      const setBrowserFullControl = async enabled => {
        await control.command('click', '[data-testid="settings-button"]')
        await control.command('click', '[data-testid="settings-menu-button"]')
        await control.command('click', '[data-testid="settings-nav-browser"]')
        await control.command('waitFor', `${fullControlToggle}:not(:disabled)`, {
          timeoutMs: uiTimeoutMs,
        })
        const checked = await control.command('getAttribute', fullControlToggle, {
          value: 'aria-checked',
        })
        if (checked !== String(enabled)) {
          await control.command('click', fullControlToggle)
        }
        await waitForAttribute(
          control,
          fullControlToggle,
          'aria-checked',
          String(enabled),
          'Browser full control was not saved'
        )
        await control.command('click', '[data-testid="settings-back-button"]')
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`,
          { timeoutMs: uiTimeoutMs }
        )
      }
      const runFullAccessBrowserSuite = async ({
        approvalPrompt,
        approvalResult,
        fullControlPrompt,
        fullControlResult,
        expectedFixturesAfterApproval,
        expectedFixturesAfterFullControl,
      }) => {
        let browserPromptCount = 0
        await control.command(
          'fill',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`,
          { value: approvalPrompt }
        )
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        await control.command('waitFor', browserRejectButton, {
          timeoutMs: modelResponseTimeoutMs,
        })
        browserPromptCount += 1
        try {
          assert.equal(
            Number(await control.command('getElementCount', mcpApprovalCard)),
            0,
            'Full-access tasks must not prompt runtime MCP approval for browser tools'
          )
        } finally {
          await control.command('clickWhenEnabled', browserRejectButton)
        }
        await control.command('waitFor', browserRejectButton, {
          visible: false,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', browserApproveButton, {
          timeoutMs: modelResponseTimeoutMs,
        })
        browserPromptCount += 1
        try {
          assert.equal(
            Number(await control.command('getElementCount', mcpApprovalCard)),
            0,
            'Full-access tasks must keep runtime MCP approval suppressed across browser steps'
          )
        } finally {
          await control.command('clickWhenEnabled', browserApproveButton)
        }
        await control.command('waitFor', browserApproveButton, {
          visible: false,
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"], ${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: approvalResult, timeoutMs: modelResponseTimeoutMs }
        )
        assert.equal(browserFixtureRequests, expectedFixturesAfterApproval)

        await setBrowserFullControl(true)
        try {
          await control.command(
            'fill',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`,
            { value: fullControlPrompt }
          )
          await control.command(
            'clickWhenEnabled',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
          )
          await control.command(
            'waitFor',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"], ${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
            { text: fullControlResult, timeoutMs: modelResponseTimeoutMs }
          )
          assert.equal(
            Number(await control.command('getElementCount', mcpApprovalCard)),
            0,
            'Full-control browser actions must not prompt runtime MCP approval'
          )
          assert.equal(
            Number(await control.command('getElementCount', browserApproveButton)),
            0,
            'Browser full control must execute browser actions without panel confirmation'
          )
          assert.equal(browserFixtureRequests, expectedFixturesAfterFullControl)
        } finally {
          await setBrowserFullControl(false)
        }
        return {
          mcpPrompts: 0,
          browserPromptsWhenDisabled: browserPromptCount,
          browserPromptsWhenEnabled: 0,
        }
      }

      // 1. In read-only mode, mutating browser calls must still require native runtime MCP approval.
      await control.command(
        'fill',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`,
        { value: READ_ONLY_BROWSER_FOLLOW_UP }
      )
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command('waitFor', mcpDeclineOption, { timeoutMs: modelResponseTimeoutMs })
      assert.equal(
        browserFixtureRequests,
        0,
        'Read-only delegated task must block browser navigation until MCP approval'
      )
      await control.command('clickWhenEnabled', mcpDeclineOption)
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`,
        { text: READ_ONLY_BROWSER_RESULT, timeoutMs: modelResponseTimeoutMs }
      )
      await storyUntil(
        () => Promise.resolve(readOnlyBrowserReported),
        Boolean,
        modelResponseTimeoutMs,
        'The declined read-only browser check must report back to the parent conversation'
      )

      // 2. Compare an ordinary task and the delegated task side-by-side under Read-Only and Full Access authorization.
      await control.command('click', '[data-testid="new-chat-button"]')
      await selectE2EModel(control)
      await control.command('clickWhenEnabled', taskMode)
      await control.command('clickWhenEnabled', '[data-testid="permission-mode-read-only"]')
      await control.command('waitFor', `${taskMode}[aria-label*="只读"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'fill',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`,
        { value: ORDINARY_READ_ONLY_BROWSER_PROMPT }
      )
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command('waitFor', mcpDeclineOption, { timeoutMs: modelResponseTimeoutMs })
      assert.equal(
        browserFixtureRequests,
        0,
        'Read-only ordinary task must block browser navigation until MCP approval'
      )
      await control.command('clickWhenEnabled', mcpDeclineOption)
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"], ${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        { text: ORDINARY_READ_ONLY_BROWSER_RESULT, timeoutMs: modelResponseTimeoutMs }
      )
      await enableFullAccessInActiveTask()
      const ordinaryEvidence = await runFullAccessBrowserSuite({
        approvalPrompt: ORDINARY_BROWSER_APPROVAL_PROMPT,
        approvalResult: ORDINARY_BROWSER_APPROVAL_RESULT,
        fullControlPrompt: ORDINARY_BROWSER_FULL_CONTROL_PROMPT,
        fullControlResult: ORDINARY_BROWSER_FULL_CONTROL_RESULT,
        expectedFixturesAfterApproval: 1,
        expectedFixturesAfterFullControl: 2,
      })

      await reopenDelegatedTask()
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`,
        { text: READ_ONLY_BROWSER_RESULT, timeoutMs: uiTimeoutMs }
      )
      const fullAccessOffset = (await readFile(executorLog, 'utf8')).length
      await enableFullAccessInActiveTask()
      const delegatedEvidence = await runFullAccessBrowserSuite({
        approvalPrompt: BROWSER_APPROVAL_FOLLOW_UP,
        approvalResult: BROWSER_APPROVAL_RESULT,
        fullControlPrompt: BROWSER_FULL_CONTROL_FOLLOW_UP,
        fullControlResult: BROWSER_FULL_CONTROL_RESULT,
        expectedFixturesAfterApproval: 3,
        expectedFixturesAfterFullControl: 4,
      })
      await waitForNativeProfile(writingTaskId, ':danger-full-access', fullAccessOffset)
      assert.deepEqual(
        delegatedEvidence,
        ordinaryEvidence,
        'Delegated Full Access tasks must match ordinary Full Access browser approval behavior'
      )
      await storyUntil(
        () => Promise.resolve(browserFollowUpReported && browserFullControlReported),
        Boolean,
        modelResponseTimeoutMs,
        'Both Full Access browser follow-ups must deliver results to the original conversation'
      )
    },
  }
}
