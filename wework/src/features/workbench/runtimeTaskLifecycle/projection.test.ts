import { describe, expect, test } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/api'
import {
  normalizeRuntimeTaskSummary,
  runtimeTaskReconciliationSnapshot,
  shouldReplaceRuntimeTaskProjection,
} from './projection'

function task(overrides: Partial<RuntimeTaskSummary> = {}): RuntimeTaskSummary {
  return {
    taskId: 'task-1',
    workspacePath: '/repo/Wegent',
    title: 'Task',
    runtime: 'claude_code',
    ...overrides,
  }
}

describe('runtimeTaskProjection', () => {
  test('derives reconciliation truth through the lifecycle vocabulary', () => {
    expect(
      runtimeTaskReconciliationSnapshot(
        task({ status: 'active', running: false, turnStatus: 'completed' })
      )
    ).toEqual({
      runtimeStatus: 'active',
      running: false,
      turnStatus: 'completed',
    })
    expect(
      runtimeTaskReconciliationSnapshot(
        task({ status: 'running', running: true, turnStatus: 'inProgress' })
      )
    ).toEqual({
      runtimeStatus: 'running',
      running: true,
      turnStatus: 'inProgress',
    })
  })

  test('normalizes completed executor state into one terminal projection', () => {
    expect(
      normalizeRuntimeTaskSummary(
        task({
          running: false,
          status: 'active',
          completedAt: 1_786_676_400_000,
          optimistic: true,
        })
      )
    ).toMatchObject({
      running: false,
      status: 'done',
      turnStatus: 'completed',
      completedAt: 1_786_676_400_000,
    })
  })

  test('never replaces authoritative completion with an optimistic active projection', () => {
    const completed = task({
      running: false,
      status: 'done',
      completedAt: 1_786_676_400_000,
    })
    const staleOptimistic = task({
      running: true,
      status: 'running',
      optimistic: true,
      updatedAt: 1_786_676_401_000,
    })

    expect(shouldReplaceRuntimeTaskProjection(completed, staleOptimistic)).toBe(false)
  })

  test('lets an authoritative completion replace an optimistic active projection', () => {
    const optimistic = task({
      running: true,
      status: 'running',
      optimistic: true,
    })
    const completed = task({
      running: false,
      status: 'active',
      completedAt: 1_786_676_400_000,
    })

    expect(shouldReplaceRuntimeTaskProjection(optimistic, completed)).toBe(true)
  })

  test('preserves an in-flight optimistic start over a non-terminal idle snapshot', () => {
    const optimistic = task({
      running: true,
      status: 'running',
      optimistic: true,
    })
    const staleIdle = task({
      running: false,
      status: 'active',
    })

    expect(shouldReplaceRuntimeTaskProjection(optimistic, staleIdle)).toBe(false)
  })

  test('allows an executor-confirmed active turn after prior completion', () => {
    const completed = task({
      running: false,
      status: 'done',
      completedAt: 1_786_676_400_000,
    })
    const active = task({
      running: true,
      status: 'running',
      threadStatus: 'active',
      turnStatus: 'inProgress',
    })

    expect(shouldReplaceRuntimeTaskProjection(completed, active)).toBe(true)
  })

  test('rejects a stale active projection that still carries completion', () => {
    const completed = task({
      running: false,
      status: 'done',
      completedAt: 1_786_676_400_000,
    })
    const staleActive = task({
      running: true,
      status: 'running',
      threadStatus: 'active',
      turnStatus: 'inProgress',
      completedAt: 1_786_676_400_000,
      updatedAt: 1_786_676_401_000,
    })

    expect(shouldReplaceRuntimeTaskProjection(completed, staleActive)).toBe(false)
  })
})
