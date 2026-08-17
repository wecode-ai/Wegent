import { beforeEach, describe, expect, test } from 'vitest'
import {
  peekGenerationOutcome,
  recordGenerationOutcome,
  resetGenerationOutcomesForTests,
  takeGenerationOutcome,
} from './runtimeGenerationOutcome'
import type { RuntimeTaskAddress } from '@/types/api'

const address: RuntimeTaskAddress = { deviceId: 'local-device', taskId: 'task-42' }

describe('runtimeGenerationOutcome', () => {
  beforeEach(() => {
    resetGenerationOutcomesForTests()
  })

  test('peek returns the recorded outcome without clearing it', () => {
    recordGenerationOutcome(address, 'failure')

    expect(peekGenerationOutcome(address)).toBe('failure')
    expect(peekGenerationOutcome(address)).toBe('failure')
  })

  test('take returns the recorded outcome and clears it', () => {
    recordGenerationOutcome(address, 'cancelled')

    expect(takeGenerationOutcome(address)).toBe('cancelled')
    expect(takeGenerationOutcome(address)).toBeNull()
  })

  test('returns null when no outcome is recorded', () => {
    expect(peekGenerationOutcome(address)).toBeNull()
    expect(takeGenerationOutcome(address)).toBeNull()
  })

  test('keeps the most recent outcome for the same run', () => {
    recordGenerationOutcome(address, 'cancelled')
    recordGenerationOutcome(address, 'success')

    expect(takeGenerationOutcome(address)).toBe('success')
  })

  test('outcomes are scoped by device and task', () => {
    recordGenerationOutcome(address, 'failure')

    expect(peekGenerationOutcome({ deviceId: 'other-device', taskId: 'task-42' })).toBeNull()
    expect(peekGenerationOutcome({ deviceId: 'local-device', taskId: 'task-99' })).toBeNull()
  })
})
