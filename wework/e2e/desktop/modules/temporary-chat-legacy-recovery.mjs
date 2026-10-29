import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from './executor-rpc.mjs'
import { DEFAULT_MODEL_ID } from './shared.mjs'

export const LEGACY_PROMPT = 'WEWORK_LEGACY_TEMPORARY_CHAT_NATIVE_EPHEMERAL'
export const LEGACY_COMPLETION = 'Legacy temporary chat fixture completed.'

const EXPIRED_MESSAGE = 'Temporary chat session has expired. Open a new temporary chat to continue.'

function taskLines(log, event, taskId) {
  return log.split('\n').filter(line => line.includes(`${event} task_id=${taskId} `))
}

async function saveEvidence(resultDir, evidence) {
  await writeFile(
    join(resultDir, 'temporary-chat-legacy-recovery.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8'
  )
}

export async function createLegacyTemporaryChat(
  control,
  { workspacePath, resultDir, uiTimeoutMs }
) {
  const taskId = `e2e-legacy-temporary-${randomUUID()}`
  // A unique workspace prevents recovery from selecting an unrelated formal task.
  const legacyWorkspacePath = join(resultDir, 'legacy-temporary-workspace')
  await mkdir(legacyWorkspacePath, { recursive: true })
  const executorLogPath = join(resultDir, 'executor.log')
  const before = (await readFile(executorLogPath, 'utf8')).length
  const executionRequest = {
    task_id: taskId,
    subtask_id: `${taskId}-initial`,
    prompt: LEGACY_PROMPT,
    project_workspace_path: legacyWorkspacePath,
    model_config: { model_id: DEFAULT_MODEL_ID },
    ephemeral: true,
    new_session: true,
  }
  const generated = await requestExecutor(
    control,
    'runtime.text.generate',
    { executionRequest },
    Math.max(uiTimeoutMs, 30_000)
  )
  assert.equal(generated.content, LEGACY_COMPLETION)
  const log = await readFile(executorLogPath, 'utf8')
  const created = taskLines(log.slice(before), 'codex shared thread request finished', taskId)
  assert.equal(created.length, 1, 'Legacy setup must create exactly one real native thread')
  assert.ok(created[0].includes(' operation=thread/start '))
  const threadId = / thread_id=(\S+)/.exec(created[0])?.[1]
  assert.ok(threadId, 'The real ephemeral generation did not report a native thread ID')
  assert.equal(
    taskLines(log.slice(before), 'codex shared turn request finished', taskId).filter(
      line => line.includes(` thread_id=${threadId} `) && line.includes(' outcome=completed')
    ).length,
    1,
    'Legacy setup must complete its real Codex turn'
  )
  const lookup = await requestExecutor(control, 'runtime.tasks.get', { taskId }, uiTimeoutMs)
  assert.equal(lookup.success, false, 'Auxiliary generation unexpectedly created a formal task')
  const fixture = {
    taskId,
    threadId,
    executionRequest,
    executorLogOffset: log.length,
    sourceWorkspacePath: workspacePath,
    createdAt: new Date().toISOString(),
  }
  await saveEvidence(resultDir, { fixture })
  return fixture
}

export async function assertExpiredLegacyTemporaryChat(
  control,
  { fixture, resultDir, uiTimeoutMs }
) {
  const executorLogPath = join(resultDir, 'executor.log')
  const evidence = { fixture }
  try {
    const before = (await readFile(executorLogPath, 'utf8')).length
    const accepted = await requestExecutor(
      control,
      'runtime.tasks.send',
      {
        taskId: fixture.taskId,
        threadId: fixture.threadId,
        workspacePath: fixture.executionRequest.project_workspace_path,
        ephemeral: true,
        executionRequest: {
          ...fixture.executionRequest,
          subtask_id: `${fixture.taskId}-expired-follow-up`,
          prompt: 'Continue the expired temporary chat.',
          new_session: false,
        },
      },
      uiTimeoutMs
    )
    assert.equal(accepted.accepted, true)
    const deadline = performance.now() + uiTimeoutMs
    while (performance.now() < deadline) {
      const log = await readFile(executorLogPath, 'utf8')
      const recent = log.slice(before)
      const failures = taskLines(recent, 'runtime work turn failed', fixture.taskId)
      if (failures.length > 0) {
        assert.equal(failures.length, 1, 'Legacy continuation unexpectedly retried its failure')
        assert.ok(failures[0].includes(EXPIRED_MESSAGE), failures[0])
        assert.ok(failures[0].includes(`thread not found: ${fixture.threadId}`), failures[0])
        const direct = taskLines(recent, 'codex shared thread request skipped', fixture.taskId)
        assert.equal(direct.length, 1)
        assert.ok(direct[0].includes(` operation=thread/direct thread_id=${fixture.threadId}`))
        assert.equal(
          taskLines(recent, 'codex shared thread request started', fixture.taskId).length,
          0,
          'An expired legacy session must not silently start, fork, or resume a replacement'
        )
        assert.ok(
          log
            .slice(fixture.executorLogOffset)
            .includes('codex shared app-server process starting '),
          'The legacy fixture was not followed by a real native process replacement'
        )
        const lookup = await requestExecutor(
          control,
          'runtime.tasks.get',
          { taskId: fixture.taskId },
          uiTimeoutMs
        )
        assert.equal(lookup.success, true)
        assert.equal(lookup.task.status, 'failed')
        assert.equal(lookup.task.running, false)
        evidence.failure = { message: EXPIRED_MESSAGE, task: lookup.task }
        evidence.completedAt = new Date().toISOString()
        return evidence
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail('The expired legacy temporary chat did not report its actionable failure')
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await saveEvidence(resultDir, evidence)
  }
}
