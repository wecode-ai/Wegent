import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'

export const LONG_HISTORY_ITEM_COUNT = 1_200
// High-entropy output forces several transport chunks even after compression.
const LARGE_TOOL_OUTPUT = Array.from(
  { length: 28_000 },
  (_, index) => `${createHash('sha256').update(String(index)).digest('hex')}中文🙂\n`
).join('')
export const PAGED_ITEM_COUNT = 1_250
export const PAGED_ASSISTANT_ITEM = 'paged-history-assistant'
export const PAGED_ASSISTANT_BODY = 'WEWORK_E2E_PAGED_ANCHOR_BODY'
export function appendLongRunningHistory(rollout, threadId) {
  const records = rollout
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const turnId = records.findLast(
    record => record.type === 'event_msg' && record.payload?.type === 'task_started'
  )?.payload?.turn_id
  assert.ok(turnId, 'The running-history rollout did not contain an active turn')
  const firstOrdinal = Math.max(0, ...records.map(record => Number(record.ordinal) || 0)) + 1
  return Array.from({ length: LONG_HISTORY_ITEM_COUNT }, (_, index) =>
    JSON.stringify({
      timestamp: '2026-09-13T13:23:16.000Z',
      ordinal: firstOrdinal + index,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: threadId,
        turn_id: turnId,
        item: {
          id: `long-history-command-${index}`,
          type: 'CommandExecution',
          command: ['printf', String(index)],
          status: 'completed',
          aggregatedOutput: index === 0 ? LARGE_TOOL_OUTPUT : String(index),
        },
      },
    })
  ).join('\n')
}

export async function seedPaginatedTurnHistory(sqliteHome, threadId, cwd, timeoutMs) {
  const database = new DatabaseSync(join(sqliteHome, 'thread_history_1.sqlite'))
  try {
    database.exec('PRAGMA busy_timeout = 10000')
    const readTurn = database.prepare(
      'SELECT turn_id FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1'
    )
    const deadline = Date.now() + timeoutMs
    let turn = readTurn.get(threadId)
    while (!turn && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
      turn = readTurn.get(threadId)
    }
    assert.ok(turn, 'The native running turn was not persisted')
    database.exec('BEGIN IMMEDIATE')
    const ordinal = database
      .prepare(
        'SELECT COALESCE(MAX(rollout_ordinal), 0) AS value FROM thread_items WHERE thread_id = ?'
      )
      .get(threadId).value
    const insert = database.prepare(`INSERT INTO thread_items
      (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    // Put the search target before the tool history, outside the initial item budget.
    insert.run(
      threadId,
      turn.turn_id,
      PAGED_ASSISTANT_ITEM,
      ordinal + 1,
      Date.now(),
      JSON.stringify({
        type: 'agentMessage',
        id: PAGED_ASSISTANT_ITEM,
        text: PAGED_ASSISTANT_BODY,
        phase: 'final_answer',
      }),
      'agentMessage'
    )
    for (let index = 0; index < PAGED_ITEM_COUNT; index += 1) {
      const id = `paged-history-command-${index}`
      insert.run(
        threadId,
        turn.turn_id,
        id,
        ordinal + index + 2,
        Date.now(),
        JSON.stringify({
          type: 'commandExecution',
          id,
          command: `printf ${index}`,
          cwd,
          pluginId: null,
          scriptPath: null,
          processId: null,
          source: 'agent',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: String(index),
          exitCode: 0,
          durationMs: 0,
        }),
        'commandExecution'
      )
    }
    database.exec('COMMIT')
  } finally {
    database.close()
  }
}

export async function assertLargeHistoryTransfer(executorHome, taskId, threadId) {
  const scope = createHash('sha256')
    .update(JSON.stringify([taskId, threadId]))
    .digest('hex')
  const directory = join(executorHome, 'runtime-work', 'transcript-transfers', scope)
  const snapshots = (await readdir(directory)).filter(name => name.endsWith('.gz'))
  assert.ok(snapshots.length > 0, 'The large history never used a persistent transfer snapshot')
  for (const name of snapshots) {
    const bytes = await readFile(join(directory, name))
    const packed = JSON.parse(gunzipSync(bytes).toString('utf8'))
    if (packed.strings?.some(text => text.includes(LARGE_TOOL_OUTPUT))) {
      assert.ok(bytes.length > 360 * 1024, 'The fixture did not exercise multiple transfer chunks')
      return
    }
  }
  assert.fail('The history transfer truncated or omitted the large tool output')
}

export async function findRolloutPath(directory, threadId) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findRolloutPath(path, threadId)
      if (nested) return nested
    } else if (entry.name.endsWith(`${threadId}.jsonl`)) {
      return path
    }
  }
  return null
}
