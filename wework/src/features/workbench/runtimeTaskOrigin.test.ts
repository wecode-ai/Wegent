import { describe, expect, it } from 'vitest'
import { isProjectAutomationManagerRuntimeTask } from './runtimeTaskOrigin'

describe('isProjectAutomationManagerRuntimeTask', () => {
  it('recognizes project automation manager sessions', () => {
    expect(
      isProjectAutomationManagerRuntimeTask({
        runtimeHandle: {
          origin: {
            type: 'project_automation',
            automationRole: 'manager',
            run_id: 'run-1',
          },
        },
      })
    ).toBe(true)
  })

  it('does not treat project robot executions as automation manager sessions', () => {
    expect(
      isProjectAutomationManagerRuntimeTask({
        runtimeHandle: {
          origin: {
            type: 'project_automation',
            run_id: 'run-1',
          },
        },
      })
    ).toBe(false)
  })
})
