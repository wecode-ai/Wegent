import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { requestExecutor } from './executor-rpc.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import { verifyConversationSwitchPosition } from './streaming-text-switch-stability.mjs'

const BOTTOM_ANCHOR = 'PLAN_SWITCH_BOTTOM_ANCHOR'
const paragraph = count => '恢复任务后保持输入框和文字位置稳定。'.repeat(count)

function historyItems(turn) {
  const prefix = `plan-switch-${turn}`
  const user = {
    id: `${prefix}-user`,
    clientId: `${prefix}-user`,
    type: 'userMessage',
    content: [{ type: 'text', text: `Plan switch request ${turn}`, text_elements: [] }],
  }
  const prose = (part, text) => ({
    id: `${prefix}-text-${part}`,
    type: 'agentMessage',
    text,
    phase: 'final_answer',
  })
  if (turn === 3)
    return [
      user,
      {
        id: `${prefix}-plan`,
        type: 'plan',
        text: [
          '# Regression plan',
          paragraph(5),
          Array.from({ length: 23 }, (_, index) => `- Step ${index}: ${paragraph(2)}`).join('\n'),
        ].join('\n\n'),
      },
    ]
  if (turn === 4)
    return [
      user,
      ...[5, 6, 7, 6].flatMap((count, index) => [
        prose(index, `${index === 3 ? BOTTOM_ANCHOR + '\n\n' : ''}${paragraph(count)}`),
        {
          id: `${prefix}-command-${index}`,
          type: 'commandExecution',
          command: 'pwd',
          cwd: '.',
          processId: null,
          source: 'unifiedExecStartup',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: 'Done',
          exitCode: 0,
          durationMs: 1,
        },
      ]),
    ]
  return [
    user,
    prose(
      0,
      turn === 0
        ? Array.from({ length: 20 }, (_, index) => `Paragraph ${index}: ${paragraph(5)}`).join(
            '\n\n'
          )
        : paragraph(turn === 1 ? 10 : 8)
    ),
  ]
}

// Use the native history fixture path shared with latest-conversation-history.
// The renderer, pagination, persisted history and scroll controller remain real.
function seedPlanHistory(sqliteHome, threadId) {
  const database = new DatabaseSync(join(sqliteHome, 'thread_history_1.sqlite'))
  try {
    database.exec('PRAGMA busy_timeout = 10000')
    const maximum = database
      .prepare('SELECT MAX(rollout_end_ordinal) AS value FROM thread_turns WHERE thread_id = ?')
      .get(threadId).value
    assert.ok(Number.isFinite(maximum), 'The task must already contain native history')
    const insertTurn = database.prepare(`INSERT INTO thread_turns
      (thread_id, turn_id, rollout_ordinal, rollout_end_ordinal, status,
       started_at, completed_at, first_user_item_id, final_agent_item_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertItem = database.prepare(`INSERT INTO thread_items
      (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    database.exec('BEGIN IMMEDIATE')
    database.prepare('DELETE FROM thread_items WHERE thread_id = ?').run(threadId)
    database.prepare('DELETE FROM thread_turns WHERE thread_id = ?').run(threadId)
    let ordinal = maximum + 1
    for (let turn = 0; turn < 5; turn += 1) {
      const turnId = `plan-switch-turn-${turn}`
      const items = historyItems(turn)
      const timestamp = Date.now() + turn * 1000
      const end = ordinal + items.length + 1
      insertTurn.run(
        threadId,
        turnId,
        ordinal,
        end,
        turn === 4 ? 'inProgress' : 'completed',
        Math.floor(timestamp / 1000),
        turn === 4 ? null : Math.floor(timestamp / 1000) + 1,
        items[0].id,
        items.findLast(item => item.type === 'agentMessage')?.id ?? null
      )
      items.forEach((item, index) =>
        insertItem.run(
          threadId,
          turnId,
          item.id,
          ordinal + index + 1,
          timestamp + index,
          JSON.stringify(item),
          item.type
        )
      )
      ordinal = end + 1
    }
    database.exec('COMMIT')
  } finally {
    database.close()
  }
}

export async function verifyPlanConversationSwitch(control, options) {
  const { address, codexSqliteHome, uiTimeoutMs } = options
  const { task } = await requestExecutor(control, 'runtime.tasks.get', { address }, uiTimeoutMs)
  assert.ok(task.threadId, 'The task must have a native thread')
  seedPlanHistory(codexSqliteHome, task.threadId)
  await control.command('click', '[data-testid="new-chat-button"]')
  await reloadMainWindow(control, 'The plan history fixture did not reopen in a fresh renderer')
  const previous = JSON.parse(
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify({ width: 1440, height: 757 }),
    })
  )
  try {
    await control.command(
      'clickWhenEnabled',
      `[data-testid="runtime-local-task-row-${address.taskId}"]`
    )
    await verifyConversationSwitchPosition(control, {
      ...options,
      name: 'plan-bottom',
      anchorText: BOTTOM_ANCHOR,
      pinned: true,
    })
  } finally {
    await control.command('setMainWindowSize', 'body', { value: JSON.stringify(previous) })
  }
}
