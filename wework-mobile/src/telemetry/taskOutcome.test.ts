import { afterEach, describe, expect, it } from 'vitest'
import {
  clearMobileTaskOutcomes,
  recordMobileTaskOutcome,
  takeMobileTaskOutcome,
} from './taskOutcome'

const address = { deviceId: 'device', taskId: 'task', runtime: 'codex' as const }

describe('mobile task outcomes', () => {
  afterEach(() => clearMobileTaskOutcomes())

  it('maps terminal runtime events to bounded outcomes', () => {
    recordMobileTaskOutcome(address, 'runtime.task.cancelled')
    expect(takeMobileTaskOutcome(address)).toBe('cancelled')
    recordMobileTaskOutcome(address, 'runtime.task.failed')
    expect(takeMobileTaskOutcome(address)).toBe('failure')
    recordMobileTaskOutcome(address, 'runtime.task.completed')
    expect(takeMobileTaskOutcome(address)).toBe('success')
  })

  it('consumes each outcome once', () => {
    recordMobileTaskOutcome(address, 'response.completed')
    expect(takeMobileTaskOutcome(address)).toBe('success')
    expect(takeMobileTaskOutcome(address)).toBeNull()
  })
})
