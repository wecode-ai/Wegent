import { expect, test } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/api'
import { shouldReplaceRuntimeTaskProjection } from './projection'

const started: RuntimeTaskSummary = {
  taskId: 'task-1',
  workspacePath: '/repo',
  title: 'Task',
  runtime: 'codex',
  running: true,
  status: 'running',
  turnStatus: 'inProgress',
  updatedAt: 1793117765722,
  runtimeHandle: { lastTurnId: 'turn-2' },
}

const completed: RuntimeTaskSummary = {
  ...started,
  running: false,
  status: 'done',
  turnStatus: 'completed',
  updatedAt: 1793117763014,
  completedAt: 1793117765000,
}

test('completion wins over delayed start metadata for the same provider turn', () => {
  expect(shouldReplaceRuntimeTaskProjection(completed, started)).toBe(false)
  expect(shouldReplaceRuntimeTaskProjection(started, completed)).toBe(true)
})

test('a later provider turn can start after a completed turn', () => {
  expect(
    shouldReplaceRuntimeTaskProjection(completed, {
      ...started,
      runtimeHandle: { lastTurnId: 'turn-3' },
    })
  ).toBe(true)
})
