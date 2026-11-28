import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { toolOutputText } from './response-protocol.mjs'

const probeTool = 'mcp__personalprobe__probe_environment'

export function handleNegativeProbe(cell, body, response, writeText, writeToolCall) {
  const attempt = cell.permissionTest
  if (!attempt || !JSON.stringify(body.input).includes(attempt.prompt)) return false
  const id = attempt.prompt.replaceAll(' ', '-')
  const result = toolOutputText(body, id)
  if (result) {
    assert.equal(attempt.action, 'decline', 'Cancelled probe returned to the model')
    assert.match(result, /denied|declin|reject|not approved/i)
    assert.ok(!result.includes('MCP_RECEIPT:'))
    attempt.denial = result
    writeText(response, id + '-complete', attempt.result)
  } else if (
    !body.tools?.some(entry => entry.name === probeTool) &&
    !toolOutputText(body, id + '-search')
  ) {
    writeToolCall(response, id + '-search', id + '-search', 'ToolSearch', {
      query: 'select:' + probeTool,
    })
  } else {
    writeToolCall(response, id, id, probeTool, {})
  }
  return true
}

async function cancelAndReplay(control, deviceId, taskId, form) {
  const cancellation = JSON.parse(
    await control.command('cancelRuntimeTaskDirectly', 'body', {
      value: JSON.stringify({ deviceId, taskId }),
    })
  )
  assert.equal(cancellation.accepted, true, 'Cancellation must settle the active turn')
  const duplicate = JSON.parse(
    await control.command('answerRuntimeUserInputDirectly', 'body', {
      value: JSON.stringify({
        taskId,
        requestUserInputResponse: {
          requestId: form.requestId,
          interactionScope: form.interactionScope,
          answers: { __mcp_approval: { answers: ['Allow'] } },
        },
      }),
    })
  )
  assert.equal(duplicate.success, false, 'A cancelled Claude request accepted a late approval')
  assert.match(duplicate.code, /^(missing|stale|closed)_request_user_input$/)
  return duplicate.code
}

async function runApprovalTurn(context, target, action) {
  const { control, chat, cell, deviceId, taskId, captureScreenshot } = context
  const decisions = []
  const handled = context.handled
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const view = JSON.parse(await control.command('snapshot', chat))
    if (target && view.text.includes(target)) return decisions
    if (view.testIds.some(id => id.startsWith('request-user-input-option-'))) {
      const messages = JSON.parse(
        await control.command('getRuntimeConversationMessages', 'body', {
          value: JSON.stringify({ deviceId, taskId }),
        })
      )
      const form = messages
        .flatMap(message => message.blocks ?? [])
        .map(block => block.renderPayload)
        .findLast(
          payload => payload?.questions?.[0]?.id === '__mcp_approval' && payload.requestId != null
        )
      if (form && !handled.has(form.requestId)) {
        const [question] = form.questions
        assert.ok(form.interactionScope, 'Approval must bind to the current Subtask')
        const name = form.toolName
        assert.ok(
          ['Bash', 'ToolSearch', 'Agent', 'Task', probeTool].includes(name),
          'Unexpected tool approval: ' + name
        )
        const selected = action !== 'allow' && name === probeTool ? action : 'allow'
        const labels = question.options.map(option => option.label)
        assert.deepEqual(labels, ['Allow', 'Decline'], 'Claude approves at most one tool call')
        const allowed = 0
        const declined = 1
        const button =
          chat +
          ' [data-testid="request-user-input-option-' +
          question.id +
          '-' +
          (selected === 'decline' ? declined : allowed) +
          '"]:not(:disabled)'
        if (Number(await control.command('getElementCount', button))) {
          handled.add(form.requestId)
          decisions.push({
            requestId: form.requestId,
            interactionScope: form.interactionScope,
            tool: name,
            decision: selected,
          })
          await captureScreenshot(
            control,
            cell.id + '-' + action + '-approval-' + decisions.length + '.png',
            chat
          )
          if (selected === 'cancel') {
            decisions.at(-1).lateResponse = await cancelAndReplay(control, deviceId, taskId, form)
            return decisions
          }
          await control.command('clickWhenEnabled', button)
        }
      }
    }
    await delay(100)
  }
  throw new Error(
    'Timed out waiting for Claude ' + action + ' in ' + cell.id + ': ' + JSON.stringify(decisions)
  )
}

export async function approvePersonalClaude(context) {
  const approvals = await runApprovalTurn(context, context.cell.result, 'allow')
  assert.ok(
    approvals.some(row => row.tool === probeTool),
    'MCP execution requires its own visible approval'
  )
  return approvals
}

export async function verifyNegativeProbes(context) {
  const { cell, control, chat, captureScreenshot } = context
  const evidence = []
  for (const action of ['decline', 'cancel']) {
    const prompt = cell.id + ' exercise ' + action
    const result = cell.id + ' declined by user'
    cell.permissionTest = { action, prompt, result }
    const initial = cell.probe.receipts.length
    await control.command('fill', chat + ' [data-testid="chat-message-input"]', { value: prompt })
    await control.command('clickWhenEnabled', chat + ' [data-testid="send-message-button"]')
    const decisions = await runApprovalTurn(context, action === 'cancel' ? null : result, action)
    assert.ok(decisions.some(row => row.tool === probeTool && row.decision === action))
    if (action === 'decline') assert.ok(cell.permissionTest.denial)
    assert.equal(cell.probe.receipts.length, initial, 'Rejected tool reached the MCP service')
    await captureScreenshot(control, cell.id + '-' + action + '-result.png', chat)
    evidence.push({ action, decisions, newMcpReceipts: 0 })
  }
  delete cell.permissionTest
  return evidence
}
