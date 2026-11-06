import { expect, test } from 'vitest'
import { assertCloudConfigDegradation } from '../e2e/desktop/scenarios/codex-cloud-config-recovery.scenario.mjs'

const transition = (method, extra = 'auth_mode=wework_router pending_requests=0') =>
  `codex auth degraded after cloud config failure method=${method} error="cloud config bundle failed" ${extra}`
const resume = taskId =>
  `codex shared thread request started task_id=${taskId} subtask_id=${taskId}-initial operation=thread/resume mcp_config_key_count=17`

test.each(['config/read', 'thread/resume'])(
  'observes safe cold-start degradation through %s and the same Goal resume',
  method => {
    const log = `${transition(method)}\n${resume('cloud-config-goal')}`
    expect(assertCloudConfigDegradation(log, { resumedTaskId: 'cloud-config-goal' })).toBe(method)
  }
)

test('keeps exact method coverage for targeted request recovery', () => {
  expect(
    assertCloudConfigDegradation(transition('thread/resume'), { expectedMethod: 'thread/resume' })
  ).toBe('thread/resume')
  expect(() =>
    assertCloudConfigDegradation(transition('config/read'), { expectedMethod: 'thread/resume' })
  ).toThrow()
})

test.each([
  transition('config/read'),
  `${transition('config/read')}\n${resume('another-goal')}`,
  `${transition('config/read')}\n${resume('cloud-config-goal-extra')}`,
  `${transition('config/read')}\n${resume('cloud-config-goal').replace('task_id=', 'owner_id=')}`,
  `${transition('config/read', 'auth_mode=local_subscription pending_requests=0')}\n${resume('cloud-config-goal')}`,
  `${transition('config/read', 'auth_mode=wework_router pending_requests=1')}\n${resume('cloud-config-goal')}`,
])('rejects an unsafe transition or missing Goal resume: %s', log => {
  expect(() => assertCloudConfigDegradation(log, { resumedTaskId: 'cloud-config-goal' })).toThrow()
})
