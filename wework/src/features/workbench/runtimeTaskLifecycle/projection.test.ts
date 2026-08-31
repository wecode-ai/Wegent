import { describe, expect, test } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/api'
import {
  isRuntimePaneTranscriptConfirmedIdle,
  isRuntimeTaskExecutionRunning,
  normalizeRuntimeTaskSummary,
  projectRuntimePaneTranscript,
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
  test('confirms idle only when runtime and every turn are terminal', () => {
    const transcript = projectRuntimePaneTranscript({
      running: false,
      messages: [],
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          items: [],
        },
      ],
    })

    expect(isRuntimePaneTranscriptConfirmedIdle(transcript)).toBe(true)
  })

  test.each(['running', 'in_progress', 'pending', 'streaming'])(
    'keeps transcript active while a %s runtime turn remains',
    status => {
      const transcript = projectRuntimePaneTranscript({
        running: false,
        messages: [],
        turns: [
          {
            id: 'turn-1',
            status,
            items: [],
          },
        ],
      })

      expect(transcript.turns[0]?.status).toBe('streaming')
      expect(isRuntimePaneTranscriptConfirmedIdle(transcript)).toBe(false)
    }
  )

  test('keeps transcript active while the runtime is running', () => {
    const transcript = projectRuntimePaneTranscript({
      running: true,
      messages: [],
      turns: [],
    })

    expect(isRuntimePaneTranscriptConfirmedIdle(transcript)).toBe(false)
  })

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

  test('recognizes executor-reported running tasks before turn status catches up', () => {
    expect(isRuntimeTaskExecutionRunning(task({ running: true }))).toBe(true)
    expect(isRuntimeTaskExecutionRunning(task({ running: true, optimistic: true }))).toBe(false)
    expect(
      isRuntimeTaskExecutionRunning(task({ running: true, completedAt: 1_786_676_400_000 }))
    ).toBe(false)
  })

  test('always prefers executor state over a persisted sidebar projection', () => {
    const cached = task({
      cachedProjection: true,
      updatedAt: 1_786_676_401_000,
    })
    const running = task({
      running: true,
      status: 'running',
      threadStatus: 'active',
      turnStatus: 'inProgress',
      updatedAt: 1_786_676_400_000,
    })

    expect(shouldReplaceRuntimeTaskProjection(cached, running)).toBe(true)
    expect(shouldReplaceRuntimeTaskProjection(running, cached)).toBe(false)
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
    const completedAt = 1_786_676_400_000
    const completed = task({
      running: false,
      status: 'done',
      completedAt,
    })
    const active = task({
      running: true,
      status: 'running',
      threadStatus: 'active',
      turnStatus: 'inProgress',
      updatedAt: completedAt + 1,
    })

    expect(shouldReplaceRuntimeTaskProjection(completed, active)).toBe(true)
  })

  test('rejects a stale active projection older than prior completion', () => {
    const completedAt = 1_786_676_400_000
    const completed = task({
      running: false,
      status: 'done',
      completedAt,
    })
    const staleActive = task({
      running: true,
      status: 'running',
      threadStatus: 'active',
      turnStatus: 'inProgress',
      updatedAt: completedAt - 1,
    })

    expect(shouldReplaceRuntimeTaskProjection(completed, staleActive)).toBe(false)
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
