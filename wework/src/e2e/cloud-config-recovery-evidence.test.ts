// @vitest-environment node

import { expect, test } from 'vitest'
import { assertCloudConfigRecovery } from '../../e2e/desktop/modules/cloud-config-recovery-evidence.mjs'

const degradation = (method: string) =>
  `codex auth degraded after cloud config failure method=${method} auth_mode=wework_router pending_requests=0`
const resumed = (taskId = 'goal', threadId = 'original') =>
  `codex shared thread request finished task_id=${taskId} subtask_id=initial operation=thread/resume thread_id=${threadId}`
const goal = { taskId: 'goal', threadId: 'original' }

test.each(['config/read', 'thread/resume'])(
  'requires the original Goal thread after auth recovery triggered by %s',
  method => {
    expect(assertCloudConfigRecovery(`${degradation(method)}\n${resumed()}`, goal)).toBe(method)
  }
)

test('keeps method-specific fault injection exact', () => {
  expect(() =>
    assertCloudConfigRecovery(degradation('config/read'), { method: 'thread/resume' })
  ).toThrow()
})

test.each([
  degradation('config/read'),
  `${degradation('config/read')}\n${resumed('another-goal')}`,
  `${degradation('config/read')}\n${resumed('goal', 'replacement')}`,
  `${degradation('config/read')}\n${resumed().replace('finished', 'started')}`,
  `${degradation('config/read').replace('wework_router', 'local_subscription')}\n${resumed()}`,
  `${degradation('config/read').replace('pending_requests=0', 'pending_requests=1')}\n${resumed()}`,
  resumed(),
])('rejects incomplete or unrelated Goal recovery evidence', log => {
  expect(() => assertCloudConfigRecovery(log, goal)).toThrow()
})
