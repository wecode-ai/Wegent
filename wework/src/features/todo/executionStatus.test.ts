import { describe, expect, it } from 'vitest'
import {
  executionDisplayStatus,
  isExecutionActive,
  isExecutionCancellable,
  isExecutionFailed,
  isExecutionTerminal,
} from './executionStatus'

describe('executionStatus', () => {
  it('preserves distinct automation lifecycle and terminal outcomes', () => {
    expect(executionDisplayStatus('pending')).toBe('queued')
    expect(executionDisplayStatus('waiting_device')).toBe('waiting_runtime')
    expect(executionDisplayStatus('running')).toBe('running')
    expect(executionDisplayStatus('succeeded')).toBe('succeeded')
    expect(executionDisplayStatus('failed')).toBe('failed')
    expect(executionDisplayStatus('skipped')).toBe('skipped')
    expect(executionDisplayStatus('cancelled')).toBe('cancelled')
  })

  it('maps message and execution aliases without hiding state boundaries', () => {
    expect(executionDisplayStatus('streaming')).toBe('running')
    expect(executionDisplayStatus('queued')).toBe('queued')
    expect(executionDisplayStatus('claimed')).toBe('starting')
    expect(executionDisplayStatus('assigned')).toBe('queued')
    expect(executionDisplayStatus('pending_approval')).toBe('waiting_approval')
    expect(executionDisplayStatus('waiting_approval')).toBe('waiting_approval')
    expect(executionDisplayStatus('in_progress')).toBe('running')
    expect(executionDisplayStatus('completed')).toBe('succeeded')
    expect(executionDisplayStatus('canceled')).toBe('cancelled')
    expect(executionDisplayStatus('interrupted')).toBe('failed')
    expect(executionDisplayStatus('stalled')).toBe('failed')
    expect(executionDisplayStatus('done')).toBe('succeeded')
  })

  it('surfaces unknown statuses explicitly and null as no status', () => {
    expect(executionDisplayStatus('future-unknown-state')).toBe('unknown')
    expect(executionDisplayStatus(null)).toBeNull()
    expect(executionDisplayStatus(undefined)).toBeNull()
    expect(executionDisplayStatus('')).toBeNull()
  })

  it('keeps active, terminal, cancellable and failed decisions independent', () => {
    expect(isExecutionFailed('failed')).toBe(true)
    expect(isExecutionFailed('cancelled')).toBe(false)
    expect(isExecutionFailed('interrupted')).toBe(true)
    expect(isExecutionFailed('completed')).toBe(false)
    expect(isExecutionFailed(null)).toBe(false)
    expect(isExecutionActive('queued')).toBe(true)
    expect(isExecutionActive('unknown')).toBe(true)
    expect(isExecutionActive('completed')).toBe(false)
    expect(isExecutionTerminal('cancelled')).toBe(true)
    expect(isExecutionTerminal('unknown')).toBe(false)
    expect(isExecutionCancellable('running')).toBe(true)
    expect(isExecutionCancellable('cancelling')).toBe(false)
  })
})
