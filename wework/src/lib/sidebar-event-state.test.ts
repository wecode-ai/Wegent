import { expect, test } from 'vitest'
import { sidebarEventState, preferredEventSubscription } from './sidebar-event-state'
const base = { subscription_key: 'one', source: { name: 'repo' }, status: 'armed' }
test('received delivery takes precedence over later collection failures', () => {
  expect(
    sidebarEventState({ ...base, status: 'resuming_goal', error_code: 'connector_auth_required' })
  ).toBe('received')
  expect(sidebarEventState({ ...base, status: 'error' })).toBe('execution_error')
})
test('resource snapshot failures are visible and cannot be masked by a healthy wait', () => {
  const failed = {
    ...base,
    subscription_key: 'two',
    resource_states: [
      {
        kind: 'workflow_run',
        provider: 'github',
        topicId: 'run',
        observedAt: 'now',
        data: {},
        errorCode: 'git_permission_denied',
      },
    ],
  }
  expect(sidebarEventState(failed)).toBe('observation_error')
  expect(preferredEventSubscription([base, failed])).toBe(failed)
  const received = { ...base, status: 'pending', error_code: 'connector_auth_required' }
  expect(preferredEventSubscription([failed, received])).toBe(received)
})
