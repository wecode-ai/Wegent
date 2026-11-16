import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { requestExecutor } from './executor-rpc.mjs'
import { DEFAULT_MODEL_ID, MODEL_PROVIDER_ID } from './shared.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

export const SOURCE_LOOKUP_PROMPT = 'DISCUSSION_SOURCE_WITHOUT_CACHED_PATH'
export const SOURCE_LOOKUP_SEED_PROMPT = 'DISCUSSION_LEGACY_PROVIDER_SOURCE'
export const SOURCE_LOOKUP_REPLY = '跨 provider 原会话已找到，可以继续讨论。'

export async function verifyQuestionDiscussionSourceLookup(
  control,
  { appEnvironment, codexHome, codexSqliteHome, source }
) {
  const rpc = (method, params) => requestExecutor(control, method, params, 10_000)
  const { task } = await rpc('runtime.tasks.get', { taskId: source.taskId })
  assert.ok(task.threadId, 'The original question must have a persisted native thread')
  // Create a legacy-provider source through real Codex, without rewriting its database.
  const execution = promisify(execFile)(
    appEnvironment.CODEX_BINARY_PATH,
    [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-c',
      `model_provider=${JSON.stringify(MODEL_PROVIDER_ID)}`,
      SOURCE_LOOKUP_SEED_PROMPT,
    ],
    {
      cwd: source.workspacePath,
      env: { ...appEnvironment, CODEX_HOME: codexHome, WEGENT_CODEX_HOME: codexHome },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }
  )
  execution.child.stdin.end()
  const { stdout } = await execution
  const events = stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  const sourceThreadId = events.find(event => event.type === 'thread.started')?.thread_id
  assert.ok(sourceThreadId, 'Real Codex must create the cross-provider source')
  assert.ok(events.some(event => event.type === 'turn.completed'))
  const database = new DatabaseSync(join(codexSqliteHome, 'state_5.sqlite'), {
    readOnly: true,
  })
  try {
    const metadata = database
      .prepare('SELECT model_provider, rollout_path FROM threads WHERE id = ?')
      .get(sourceThreadId)
    assert.ok(metadata?.rollout_path, 'The source must already be persisted')
    assert.notEqual(metadata.model_provider, 'wework-router')
  } finally {
    database.close()
  }
  const taskId = `discussion-source-lookup-${randomUUID()}`
  const created = await rpc('runtime.tasks.create', {
    taskId,
    runtime: 'codex',
    workspacePath: source.workspacePath,
    message: SOURCE_LOOKUP_PROMPT,
    ephemeral: true,
    // Match a freshly created task address: no cached rollout path or runtime handle.
    sideSource: {
      deviceId: source.deviceId,
      taskId: sourceThreadId,
      threadId: sourceThreadId,
      workspacePath: source.workspacePath,
    },
    executionRequest: {
      task_id: taskId,
      subtask_id: `${taskId}-turn`,
      prompt: SOURCE_LOOKUP_PROMPT,
      project_workspace_path: source.workspacePath,
      new_session: true,
      model_config: { model_id: DEFAULT_MODEL_ID, model_provider: MODEL_PROVIDER_ID },
    },
  })
  assert.equal(created.accepted, true, 'A persisted source must not time out on provider filtering')
  await waitForValue(
    () => rpc('runtime.tasks.transcript', { taskId, limit: 100 }),
    transcript => JSON.stringify(transcript.messages).includes(SOURCE_LOOKUP_REPLY),
    'The real fork must deliver the independent discussion response',
    10_000
  )
  const original = await rpc('runtime.tasks.get', { taskId: source.taskId })
  assert.equal(original.task.threadId, task.threadId, 'Discussion must not replace the source')
  assert.equal(original.task.interactionStatus, 'awaitingUserReply')
}
