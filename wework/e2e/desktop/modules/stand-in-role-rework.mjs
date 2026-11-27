import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { accountCommandResult } from './account-auth-command.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { assistantMessage, requestContainsToolOutput } from './response-protocol.mjs'
import { shellCommandPollResponse, shellCommandResponse } from './shell-command-response.mjs'
import { storyUntil } from './stand-in-source-story-evidence.mjs'

const REQUEST = '先创建初稿，再请另一个助理评审，并把意见交回原任务。'
const PREREQUISITE_BRIEF = '生成初稿供评审。'
const DEPENDENT_BRIEF = '读取初稿并给出评审意见。'
const PREREQUISITE_RESULT = '初稿内容已记录。'
const REVIEW_RESULT = '初稿缺少结论，请补充。'
const REWORK_BRIEF = '按评审意见修订初稿。'
const REWORK_RESULT = '原稿已补充结论。'
const FINAL = '初稿已按评审意见修订完成。'
const REWORK_CALL = 'draft-revision'
const WRITE_CALL = 'draft-revision-write'
const FILE = 'draft-revision.txt'

export function createRoleReworkStory({
  roles,
  reply,
  tool,
  writeProbe,
  writeAllowed,
  uiTimeoutMs,
  modelResponseTimeoutMs,
}) {
  const tasks = new Map()
  const held = new Map()
  let prerequisiteReleased = false
  let dependentStarted = false
  let firstReceipt
  let workspace

  function hold(key, response) {
    assert.equal(held.has(key), false, `Duplicate model request for ${key}`)
    held.set(key, response)
    response.once('close', () => {
      if (held.get(key) === response) held.delete(key)
    })
  }

  function release(key, result) {
    const response = held.get(key)
    if (!response) return
    held.delete(key)
    if (!response.destroyed && !response.writableEnded) reply(response, [assistantMessage(result)])
  }

  return {
    get prerequisiteId() {
      return tasks.get(0)
    },

    handleRequest(body, response, latest) {
      if (latest.includes(PREREQUISITE_BRIEF)) {
        hold('prerequisite', response)
      } else if (latest.includes(DEPENDENT_BRIEF)) {
        assert.equal(prerequisiteReleased, true, 'Review began before its prerequisite completed')
        assert.ok(latest.includes(PREREQUISITE_RESULT), 'Review requires the actual first result')
        dependentStarted = true
        hold('review', response)
      } else if (latest.includes(REWORK_BRIEF)) {
        assert.ok(latest.includes(REVIEW_RESULT), 'The resumed specialist needs the actual review')
        const result = accountCommandResult(body.input, WRITE_CALL)
        if (!result) {
          reply(response, shellCommandResponse(body, WRITE_CALL, writeProbe(FILE), workspace))
        } else if (result.sessionId) {
          reply(response, shellCommandPollResponse(body, result.pollId, result.sessionId))
        } else {
          assert.ok(result.output.includes(writeAllowed), 'The resumed task must be able to write')
          reply(response, [assistantMessage(REWORK_RESULT)])
        }
      } else if (latest.includes(REQUEST)) {
        for (const [index, item] of [
          { title: '准备初稿', message: PREREQUISITE_BRIEF },
          { title: '评审初稿', message: DEPENDENT_BRIEF },
        ].entries()) {
          const id = `dependency-delegation-${index}`
          if (!requestContainsToolOutput(body, id)) {
            reply(
              response,
              tool(body, 'delegate_role_task', id, {
                roleId: roles[index].id,
                requestId: id,
                ...item,
                ...(index === 1 ? { dependsOn: [tasks.get(0)] } : {}),
              })
            )
            return true
          }
          const result = JSON.parse(readMcpToolOutput(body, id))
          assert.equal(result.accepted, true)
          if (index === 1) assert.equal(result.status, 'waiting_for_dependencies')
          tasks.set(index, result.taskId)
        }
        reply(response, [assistantMessage('已安排初稿准备和评审。')])
      } else {
        return false
      }
      return true
    },

    handleResult(body, response, child, latest, results) {
      if (results[0]?.item?.role !== 'assistant' || ![...tasks.values()].includes(child)) {
        return false
      }
      assert.ok(latest.includes('status=done,'), 'Both branches must finish successfully')
      if (child === tasks.get(1)) {
        assert.ok(JSON.stringify(results).includes(REVIEW_RESULT))
        if (requestContainsToolOutput(body, REWORK_CALL)) {
          const result = JSON.parse(readMcpToolOutput(body, REWORK_CALL))
          assert.equal(result.accepted, true)
          assert.equal(result.taskId, tasks.get(0), 'Rework must be accepted on the original task')
          reply(response, [])
        } else {
          reply(
            response,
            tool(body, 'delegate_role_task', REWORK_CALL, {
              taskId: tasks.get(0),
              roleId: roles[0].id,
              requestId: REWORK_CALL,
              message: REWORK_BRIEF,
              dependsOn: [child],
            })
          )
        }
      } else {
        const receipt = latest.match(/resultId=([^,]+),/)?.[1]
        assert.ok(receipt, 'Each completed attempt needs a receipt')
        if (!firstReceipt) {
          assert.ok(JSON.stringify(results).includes(PREREQUISITE_RESULT))
          firstReceipt = receipt
          reply(response, [])
        } else {
          assert.notEqual(receipt, firstReceipt, 'The parent must receive a distinct second result')
          assert.ok(JSON.stringify(results).includes(REWORK_RESULT))
          reply(response, [assistantMessage(FINAL)])
        }
      }
      return true
    },

    async verify({
      control,
      send,
      rpc,
      waitForReply,
      waitForLocalCompletion,
      openCard,
      expandDelegation,
      capture,
      workspace: roleWorkspace,
      userId,
    }) {
      workspace = roleWorkspace
      await send(REQUEST)
      await waitForReply('已安排初稿准备和评审。')
      const taskId = tasks.get(0)
      const { card, row, toggle } = await openCard(taskId)
      await control.command('waitFor', row, {
        text: '等待前置任务',
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', `${card} li`, {
        text: '依赖 准备初稿',
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(dependentStarted, false)
      await storyUntil(
        () => held.has('prerequisite'),
        Boolean,
        modelResponseTimeoutMs,
        'The prerequisite should start'
      )
      await capture('10-wait-for-prerequisite.png')
      prerequisiteReleased = true
      release('prerequisite', PREREQUISITE_RESULT)

      await storyUntil(
        () => held.has('review') && Boolean(firstReceipt),
        Boolean,
        modelResponseTimeoutMs,
        'The parent must read the first result and the review must start before requesting rework'
      )
      const { task: original } = await rpc('runtime.tasks.get', { taskId })
      assert.ok(original.threadId)
      assert.equal(original.taskId, taskId)
      assert.equal(await realpath(original.workspacePath), workspace)
      assert.equal(original.runtimeHandle.taskPermissions.permissionMode, 'read-only')
      const { taskPermissions } = await rpc('runtime.tasks.permissions.set', {
        userId,
        taskId,
        taskPermissions: { permissionMode: 'workspace-write' },
      })
      assert.equal(taskPermissions.permissionMode, 'workspace-write')
      release('review', REVIEW_RESULT)

      await waitForReply(FINAL)
      const { items } = await waitForLocalCompletion([...tasks.values()])
      const revised = items.find(branch => branch.taskId === taskId)
      assert.equal(revised.attempt, 1)
      assert.deepEqual(revised.prerequisiteTaskIds, [tasks.get(1)])
      assert.equal(items.filter(branch => branch.root === revised.root).length, 2)
      const { task: resumed } = await rpc('runtime.tasks.get', { taskId })
      assert.equal(resumed.taskId, taskId)
      assert.equal(resumed.threadId, original.threadId)
      assert.equal(resumed.workspacePath, original.workspacePath)
      assert.equal(resumed.title, original.title)
      assert.deepEqual(resumed.runtimeHandle.taskPermissions, taskPermissions)
      const { messages } = await rpc('runtime.tasks.transcript', { taskId })
      const answers = messages
        .filter(message => message.role === 'assistant')
        .map(message => message.content)
      assert.ok(answers.includes(PREREQUISITE_RESULT), 'First result missing from the task')
      assert.ok(answers.includes(REWORK_RESULT), 'Revised result missing from the same task')
      assert.equal(await readFile(join(workspace, FILE), 'utf8'), writeAllowed)
      await control.command('waitFor', toggle, { text: '已完成 2/2', timeoutMs: uiTimeoutMs })
      await expandDelegation()
      await capture('11-dependency-completed.png')
    },

    close() {
      for (const response of held.values()) {
        if (!response.destroyed && !response.writableEnded) response.end()
      }
      held.clear()
    },
  }
}
