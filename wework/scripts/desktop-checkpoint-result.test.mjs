import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { rejectRecordedCheckpointFailure } from '../e2e/desktop/checkpoint-result.mjs'

test('a zero process exit cannot hide a persisted scenario assertion failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-checkpoint-result-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = { code: 0, resultDir: directory, stderrTail: '', durationMs: 1 }
  assert.equal((await rejectRecordedCheckpointFailure(result)).code, 0)
  await writeFile(join(directory, 'failure.txt'), 'Issue receipt was not rendered')
  assert.equal((await rejectRecordedCheckpointFailure(result)).code, 1)
})

test('a nonzero process status is preserved even without assertion evidence', async () => {
  const result = { code: 2, resultDir: '/missing-checkpoint', stderrTail: 'build failed' }
  assert.equal(await rejectRecordedCheckpointFailure(result), result)
})
