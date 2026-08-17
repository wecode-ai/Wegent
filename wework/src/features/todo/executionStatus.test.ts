import { describe, expect, it } from 'vitest'
import { executionDisplayStatus, isExecutionFailed, isExecutionRunning } from './executionStatus'

describe('executionStatus', () => {
  it('maps every automation run status to one of two display states', () => {
    expect(executionDisplayStatus('pending')).toBe('running')
    expect(executionDisplayStatus('waiting_device')).toBe('running')
    expect(executionDisplayStatus('running')).toBe('running')
    expect(executionDisplayStatus('succeeded')).toBe('completed')
    expect(executionDisplayStatus('failed')).toBe('completed')
    expect(executionDisplayStatus('skipped')).toBe('completed')
    expect(executionDisplayStatus('cancelled')).toBe('completed')
  })

  it('maps message and ai_state statuses to the same two states', () => {
    expect(executionDisplayStatus('streaming')).toBe('running')
    expect(executionDisplayStatus('queued')).toBe('running')
    expect(executionDisplayStatus('claimed')).toBe('running')
    expect(executionDisplayStatus('assigned')).toBe('running')
    expect(executionDisplayStatus('pending_approval')).toBe('running')
    expect(executionDisplayStatus('in_progress')).toBe('running')
    expect(executionDisplayStatus('completed')).toBe('completed')
    expect(executionDisplayStatus('canceled')).toBe('completed')
    expect(executionDisplayStatus('interrupted')).toBe('completed')
    expect(executionDisplayStatus('stalled')).toBe('completed')
    expect(executionDisplayStatus('done')).toBe('completed')
    expect(executionDisplayStatus('idle')).toBe('completed')
  })

  it('treats unknown statuses as running and null as no status', () => {
    expect(executionDisplayStatus('future-unknown-state')).toBe('running')
    expect(executionDisplayStatus(null)).toBeNull()
    expect(executionDisplayStatus(undefined)).toBeNull()
    expect(executionDisplayStatus('')).toBeNull()
  })

  it('keeps failure detection for recovery actions without a third status', () => {
    expect(isExecutionFailed('failed')).toBe(true)
    expect(isExecutionFailed('cancelled')).toBe(true)
    expect(isExecutionFailed('interrupted')).toBe(true)
    expect(isExecutionFailed('completed')).toBe(false)
    expect(isExecutionFailed(null)).toBe(false)
    expect(isExecutionRunning('queued')).toBe(true)
    expect(isExecutionRunning('completed')).toBe(false)
  })
})
