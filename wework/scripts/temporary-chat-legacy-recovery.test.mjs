import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

const { readFile, requestExecutor } = vi.hoisted(() => ({
  readFile: vi.fn(),
  requestExecutor: vi.fn(),
}))

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal()),
  readFile,
}))
vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor }))

import {
  createLegacyTemporaryChat,
  LEGACY_COMPLETION,
} from '../e2e/desktop/modules/temporary-chat-legacy-recovery.mjs'

test('waits for the exact completed native turn after text generation returns', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'legacy-chat-evidence-'))
  const before = 'executor is ready\n'
  const threadId = 'legacy-native-thread'
  let completedLog
  readFile.mockResolvedValueOnce(before)
  requestExecutor.mockImplementationOnce(async (_control, method, { executionRequest }) => {
    expect(method).toBe('runtime.text.generate')
    const taskId = executionRequest.task_id
    const started =
      before +
      `codex shared thread request finished task_id=${taskId} operation=thread/start thread_id=${threadId}\n` +
      `codex shared turn request finished task_id=${taskId} thread_id=unrelated outcome=completed\n`
    completedLog =
      started +
      `codex shared turn request finished task_id=${taskId} thread_id=${threadId} outcome=completed\n`
    readFile.mockResolvedValueOnce(started).mockResolvedValue(completedLog)
    return { content: LEGACY_COMPLETION }
  })
  requestExecutor.mockResolvedValueOnce({ success: false })
  try {
    const fixture = await createLegacyTemporaryChat(
      {},
      { workspacePath: '/source', resultDir, uiTimeoutMs: 1_000 }
    )
    expect(fixture.threadId).toBe(threadId)
    expect(fixture.executorLogOffset).toBe(completedLog.length)
    expect(requestExecutor.mock.calls.map(([, method]) => method)).toEqual([
      'runtime.text.generate',
      'runtime.tasks.get',
    ])
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})
