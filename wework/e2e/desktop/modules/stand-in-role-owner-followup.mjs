import assert from 'node:assert/strict'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { assistantMessage, requestContainsToolOutput } from './response-protocol.mjs'
import { waitForCompletedOwnerTaskThread } from './runtime-task-evidence.mjs'

export const ownerFollowupRoles = [
  { id: 'dispatch-assistant', name: '分配助理', prompt: '负责分配任务。' },
  { id: 'conversation-assistant', name: '记录助理', prompt: '负责记录对话。' },
]

const turns = [
  {
    input: '请让记录助理创建一条记录。',
    call: 'owner-create-dialog-task',
    historyCall: 'owner-check-initial-history',
    brief: '写入第一项内容。',
    result: '第一项内容已写入。',
  },
  {
    input: '在刚才的记录中追加一项。',
    call: 'owner-continue-dialog-task',
    historyCall: 'owner-find-dialog-task',
    brief: '追加第二项内容。',
    result: '第二项内容已追加。',
  },
]

const title = '条目记录'

export function createOwnerFollowupStory({ tool, reply }) {
  const [dispatcher, specialist] = ownerFollowupRoles
  let taskId
  return {
    handleRequest(body, response, latest) {
      const work = turns.find(turn => latest.includes(turn.brief))
      if (work) {
        reply(response, [assistantMessage(work.result)])
        return true
      }
      const turn = turns.find(turn => latest.includes(turn.input))
      if (!turn) return false
      const followup = turn === turns[1]
      if (!requestContainsToolOutput(body, turn.call)) {
        if (!requestContainsToolOutput(body, turn.historyCall)) {
          const args = followup ? {} : { scope: 'conversation' }
          reply(response, tool(body, 'list_role_tasks', turn.historyCall, args))
          return true
        }
        const history = JSON.parse(readMcpToolOutput(body, turn.historyCall))
        let target = { roleId: specialist.id, title }
        if (followup) {
          const { tasks, previousAssignments } = history
          assert.deepEqual(tasks, [], 'The new user message starts a new delegation group')
          const matches = previousAssignments.tasks.filter(
            task => task.title === title && task.roleId === specialist.id
          )
          assert.equal(matches.length, 1, 'The dispatcher must find its original assignment')
          target = { taskId: matches[0].taskId, roleId: matches[0].roleId }
        } else {
          assert.deepEqual(history, { tasks: [], nextCursor: null })
        }
        reply(
          response,
          tool(body, 'delegate_role_task', turn.call, {
            ...target,
            requestId: turn.call,
            message: turn.brief,
          })
        )
      } else {
        const output = readMcpToolOutput(body, turn.call)
        assert.ok(output.startsWith('{'), `Delegation failed: ${output}`)
        const accepted = JSON.parse(output)
        assert.equal(accepted.accepted, true)
        if (followup) assert.equal(accepted.taskId, taskId)
        else taskId = accepted.taskId
        reply(response, [])
      }
      return true
    },

    async verify({ control, rpc, send, waitForReply, userId, uiTimeoutMs }) {
      const tab = `[data-testid="stand-in-overview-role-${dispatcher.id}"]`
      await control.command('clickWhenEnabled', tab)
      await control.command('waitFor', `${tab}[aria-current="page"]`, { timeoutMs: uiTimeoutMs })
      const parentId = `stand-in-chat-${userId}-role-${dispatcher.id}`
      assert.equal((await rpc('runtime.tasks.get', { taskId: parentId })).code, 'task_not_found')
      await send(turns[0].input)
      await waitForReply(turns[0].result)
      const readTask = async id => (await rpc('runtime.tasks.get', { taskId: id })).task
      const parentThread = await waitForCompletedOwnerTaskThread(readTask, parentId, uiTimeoutMs)
      const { task: original } = await rpc('runtime.tasks.get', { taskId })
      assert.equal(original.taskId, taskId)
      assert.equal(original.runtimeHandle.origin.standInId, specialist.id)
      assert.ok(original.threadId)
      assert.ok(original.workspacePath)
      assert.equal(original.status, 'done')

      await send(turns[1].input)
      await waitForReply(turns[1].result)
      assert.equal((await readTask(parentId)).threadId, parentThread)
      const { task: resumed } = await rpc('runtime.tasks.get', { taskId })
      assert.equal(resumed.taskId, original.taskId)
      assert.equal(resumed.threadId, original.threadId)
      assert.equal(resumed.workspacePath, original.workspacePath)
      const { items } = await rpc('runtime.stand_in.role_task.branches', {
        userId,
        taskId: parentId,
      })
      assert.deepEqual(
        items.map(branch => branch.taskId),
        [taskId]
      )
      assert.equal(items[0].attempt, 1)
      assert.equal(items[0].status, 'done')
      assert.equal(items[0].statusSource, 'local_execution')
    },
  }
}
