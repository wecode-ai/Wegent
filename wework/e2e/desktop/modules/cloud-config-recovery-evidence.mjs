import assert from 'node:assert/strict'

export function assertCloudConfigRecovery(log, { method, taskId, threadId }) {
  assert.ok(method || (taskId && threadId), 'Recovery must identify its native request or Goal')
  const lines = log.split('\n')
  const entry = lines.find(line => line.includes('codex auth degraded after cloud config failure'))
  assert.ok(entry, 'The failing cloud configuration must cause real auth degradation')
  assert.match(entry, /\bauth_mode=wework_router\b/)
  assert.match(entry, /\bpending_requests=0(?:\s|$)/)
  const recoveryMethod = entry.match(/\bmethod=([^\s]+)/)?.[1]
  assert.ok(recoveryMethod, entry)
  if (method) assert.equal(recoveryMethod, method, entry)
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
