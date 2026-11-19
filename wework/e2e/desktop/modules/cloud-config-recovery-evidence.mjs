import assert from 'node:assert/strict'

export function assertCloudConfigRecovery(log, { method, methods, taskId, threadId }) {
  const expectedMethods = methods ?? (method ? [method] : null)
  assert.ok(
    expectedMethods || (taskId && threadId),
    'Recovery must identify its native request or Goal'
  )
  const lines = log.split('\n')
  const entries = lines
    .filter(line => line.includes('codex auth degraded after cloud config failure'))
    .map(line => ({ line, method: line.match(/\bmethod=([^\s]+)/)?.[1] }))
  assert.ok(entries.length > 0, 'The failing cloud configuration must cause real auth degradation')
  for (const { line } of entries) assert.match(line, /\bauth_mode=wework_router\b/)
  const entry = expectedMethods
    ? entries.find(candidate => expectedMethods.includes(candidate.method))
    : entries[0]
  if (!entry) {
    assert.fail(
      `Expected recovery through ${expectedMethods?.join(', ') ?? 'any native request'}; observed ${entries
        .map(({ method: observed }) => observed)
        .join(', ')}`
    )
  }
  const recoveryMethod = entry.method
  assert.ok(recoveryMethod, entry)
  if (taskId) {
    assert.ok(
      lines.some(line => {
        const fields = line.trim().split(/\s+/)
        return (
          line.includes('codex shared thread request finished') &&
          fields.includes(`task_id=${taskId}`) &&
          fields.includes('operation=thread/resume') &&
          fields.includes(`thread_id=${threadId}`)
        )
      }),
      `Goal ${taskId} must successfully resume its original native thread ${threadId}`
    )
  }
  return recoveryMethod
}
