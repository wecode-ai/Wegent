import { describe, expect, it } from 'vitest'
import {
  getRuntimePhaseForTaskStatus,
  isActiveExecutionTaskStatus,
  isTerminalTaskStatus,
  isWaitingForUserTaskStatus,
} from '..'

describe('taskStatusClassifier', () => {
  it.each(['PENDING', 'RUNNING', 'CANCELLING'] as const)(
    'classifies %s as active execution',
    status => {
      expect(isActiveExecutionTaskStatus(status)).toBe(true)
      expect(isTerminalTaskStatus(status)).toBe(false)
      expect(getRuntimePhaseForTaskStatus(status, false)).toBe('running')
      expect(getRuntimePhaseForTaskStatus(status, true)).toBe('streaming')
    }
  )

  it.each(['COMPLETED', 'FAILED', 'CANCELLED', 'DELETE'] as const)(
    'classifies %s as terminal',
    status => {
      expect(isTerminalTaskStatus(status)).toBe(true)
      expect(isActiveExecutionTaskStatus(status)).toBe(false)
      expect(getRuntimePhaseForTaskStatus(status, true)).toBe('terminal')
    }
  )

  it('classifies PENDING_CONFIRMATION as waiting for user', () => {
    expect(isWaitingForUserTaskStatus('PENDING_CONFIRMATION')).toBe(true)
    expect(getRuntimePhaseForTaskStatus('PENDING_CONFIRMATION', true)).toBe('waiting_for_user')
  })

  it('treats missing task status as unknown', () => {
    expect(getRuntimePhaseForTaskStatus(undefined, false)).toBe('unknown')
  })
})
