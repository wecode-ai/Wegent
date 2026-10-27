import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'
import { requestExecutor } from './executor-rpc.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

const RESTORED = 'ISSUE_LARGE_TRANSCRIPT_RESTORED'
const RECOVERED = 'ISSUE_LARGE_TRANSCRIPT_RETRY_RECOVERED'
const OUTPUT = Array.from({ length: 56_000 }, (_, index) =>
  createHash('sha256').update(String(index)).digest('hex')
).join('\n')

function seedLargeOutput(sqliteHome, threadId, workspacePath) {
  const database = new DatabaseSync(join(sqliteHome, 'thread_history_1.sqlite'))
  try {
    database.exec('PRAGMA busy_timeout = 10000')
    const rows = database
      .prepare(
        `SELECT item_id, turn_id, rollout_ordinal, item_json
      FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal`
      )
      .all(threadId)
    const assistant = rows.findLast(row => JSON.parse(row.item_json).type === 'agentMessage')
    assert.ok(assistant, 'The real Issue session must have a persisted assistant message')
    const turnId = 'issue-large-history-turn'
    const ordinal = Number(rows.at(-1).rollout_ordinal) + 1
    const timestamp = Date.now()
    const tool = {
      type: 'commandExecution',
      id: 'issue-large-history-tool',
      command: 'history-fixture',
      cwd: workspacePath,
      status: 'completed',
      commandActions: [],
      aggregatedOutput: OUTPUT,
      exitCode: 0,
      durationMs: 0,
      source: 'agent',
      pluginId: null,
      scriptPath: null,
      processId: null,
    }
    database.exec('BEGIN IMMEDIATE')
    database
      .prepare(
        `INSERT INTO thread_turns
      (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at,
       first_user_item_id, final_agent_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        threadId,
        turnId,
        ordinal,
        'completed',
        Math.floor(timestamp / 1000),
        Math.floor(timestamp / 1000) + 1,
        `${turnId}-user`,
        `${turnId}-assistant`
      )
    const insert = database.prepare(`INSERT INTO thread_items
      (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const items = [
      {
        type: 'userMessage',
        id: `${turnId}-user`,
        content: [{ type: 'text', text: 'Read large history', text_elements: [] }],
      },
      tool,
      { ...JSON.parse(assistant.item_json), id: `${turnId}-assistant`, text: RESTORED },
    ]
    items.forEach((item, index) =>
      insert.run(
        threadId,
        turnId,
        item.id,
        ordinal + index + 1,
        timestamp + index,
        JSON.stringify(item),
        item.type
      )
    )
    database.exec('COMMIT')
  } finally {
    database.close()
  }
}

function updateFixtureReply(sqliteHome, threadId) {
  const database = new DatabaseSync(join(sqliteHome, 'thread_history_1.sqlite'))
  try {
    database.exec('PRAGMA busy_timeout = 10000')
    const itemId = 'issue-large-history-turn-assistant'
    const row = database
      .prepare('SELECT item_json FROM thread_items WHERE thread_id = ? AND item_id = ?')
      .get(threadId, itemId)
    assert.ok(row, 'The large history reply must exist before testing recovery')
    database
      .prepare('UPDATE thread_items SET item_json = ? WHERE thread_id = ? AND item_id = ?')
      .run(JSON.stringify({ ...JSON.parse(row.item_json), text: RECOVERED }), threadId, itemId)
  } finally {
    database.close()
  }
}

async function verifyCachedInitialRecovery({
  control,
  proxy,
  scope,
  binding,
  sqliteHome,
  threadId,
}) {
  const modal = scope('[data-testid="ai-chat-modal"]')
  const start = proxy.requests.length
  await control.command('click', scope('[data-testid="ai-chat-modal-close"]'))
  proxy.rule = entry =>
    entry.method === 'POST' && entry.path === '/api/runtime-work/transcript'
      ? 'drop-response'
      : null
  try {
    await control.command(
      'click',
      scope(`[data-testid="cloud-todo-open-task-conversation-${binding.id}"]`)
    )
    await control.command('waitFor', `${modal} [data-testid="runtime-transcript-error"]`)
    assert.match(await control.command('getText', modal), new RegExp(RESTORED))
    assert.ok(
      proxy.requests.slice(start).some(entry => entry.dropped && entry.status === 200),
      'The real successful transcript response must be interrupted after reaching the backend'
    )
    updateFixtureReply(sqliteHome, threadId)
  } finally {
    proxy.rule = () => null
  }
  await control.command('clickWhenEnabled', `${modal} [data-testid="runtime-transcript-retry"]`)
  await control.command('waitFor', `${modal} [data-testid="message-assistant"]`, {
    text: RECOVERED,
  })
  assert.equal(
    Number(
      await control.command('getElementCount', `${modal} [data-testid="runtime-transcript-error"]`)
    ),
    0,
    'The recovered initial history request must clear its error'
  )
}

export async function verifyIssueTranscriptTransfer({
  control,
  request,
  fixture,
  binding,
  codexSqliteHome,
  timeoutMs,
  scope,
  proxy,
}) {
  const address = {
    deviceId: binding.device_id ?? binding.deviceId,
    taskId: binding.task_id ?? binding.taskId,
  }
  let { task } = await requestExecutor(control, 'runtime.tasks.get', { address }, timeoutMs)
  const deadline = Date.now() + 10_000
  while (task?.running && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    task = (await requestExecutor(control, 'runtime.tasks.get', { address }, timeoutMs)).task
  }
  assert.equal(task?.running, false, 'The real Issue execution must finish before seeding history')
  assert.ok(task?.threadId, 'The Issue must resolve to its actual native session')
  seedLargeOutput(codexSqliteHome, task.threadId, task.workspacePath)
  const packet = await requestExecutor(
    control,
    'runtime.tasks.transcript',
    {
      ...address,
      limit: 5,
      transcriptProtocolVersion: 2,
    },
    timeoutMs
  )
  assert.ok(packet.transfer.totalBytes > 980_000, 'History must exceed the legacy relay limit')

  const query = {
    ...address,
    projectSession: { projectId: fixture.project.id, issueId: fixture.issue.id },
    transcriptProtocolVersion: 2,
    limit: 5,
  }
  const chunks = []
  let offset = 0
  let snapshotId
  let totalBytes
  for (;;) {
    const response = await request('/api/runtime-work/transcript', {
      ...query,
      ...(offset ? { transcriptTransfer: { snapshotId, offset } } : {}),
    })
    assert.equal(response.transcriptProtocolVersion, 2)
    const transfer = response.transfer
    snapshotId ??= transfer.snapshotId
    totalBytes ??= transfer.totalBytes
    assert.equal(transfer.snapshotId, snapshotId)
    assert.equal(transfer.totalBytes, totalBytes)
    assert.equal(transfer.offset, offset)
    const bytes = Buffer.from(transfer.payload, 'base64')
    assert.ok(bytes.length > 0)
    chunks.push(bytes)
    offset += bytes.length
    if (transfer.nextOffset === null) break
    assert.equal(transfer.nextOffset, offset)
    assert.ok(offset < totalBytes)
  }
  assert.equal(offset, totalBytes)
  assert.ok(chunks.length > 1)
  const packed = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8'))
  assert.ok(
    packed.strings.some(text => text.includes(OUTPUT)),
    'Project HTTP history must preserve full tool output'
  )

  // Reload clears the renderer cache so the drawer must use its HTTP read path.
  await reloadMainWindow(control, 'The large Issue history did not reload')
  await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-board"]', {
    timeoutMs,
  })
  await control.command(
    'waitFor',
    scope(`[data-testid="collaboration-workspace-project-${fixture.project.id}"]`)
  )
  await control.command(
    'click',
    scope(`[data-testid="collaboration-workspace-project-${fixture.project.id}"]`)
  )
  await control.command(
    'clickWhenEnabled',
    scope(`[data-testid="cloud-todo-card-${fixture.issue.id}"]`)
  )
  await control.command(
    'click',
    scope(`[data-testid="cloud-todo-open-task-conversation-${binding.id}"]`)
  )
  await control.command(
    'waitFor',
    scope('[data-testid="ai-chat-modal"] [data-testid="message-assistant"]'),
    {
      text: RESTORED,
    }
  )
  assert.doesNotMatch(
    await control.command('getText', scope('[data-testid="ai-chat-modal"]')),
    /Response exceeded the transport payload limit|暂时无法加载会话/
  )
  await verifyCachedInitialRecovery({
    control,
    proxy,
    scope,
    binding,
    sqliteHome: codexSqliteHome,
    threadId: task.threadId,
  })
  await control.command('click', scope('[data-testid="ai-chat-modal-close"]'))
  await control.command('click', scope('[data-testid="cloud-todo-detail-close"]'))
}
