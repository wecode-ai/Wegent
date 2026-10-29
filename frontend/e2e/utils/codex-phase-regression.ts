import { expect, type Page } from '@playwright/test'
import type { PhaseChangingMessage } from './mock-responses-phase'

export interface PhaseRegressionStep {
  toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>
  responseContent?: string
  doneDelayMs?: number
  preamble?: PhaseChangingMessage
}

interface PhaseRegressionContext {
  page: Page
  configure: (prompt: string, steps: PhaseRegressionStep[]) => Promise<void>
  start: (prompt: string) => Promise<number>
  waitForTerminal: (taskId: number) => Promise<void>
  readTask: (taskId: number) => Promise<{
    subtasks: Array<{ result?: { blocks?: Array<{ id: string; type: string; content?: string }> } }>
  }>
}

export async function assertCodexPhaseTransition(context: PhaseRegressionContext): Promise<void> {
  const marker = `PHASE_${Date.now()}`
  const preamble = `正在检查🙂 ${marker}`
  const answer = `检查完成 ${marker}`
  await context.configure(marker, [
    {
      toolCalls: [{ toolName: 'exec_command', arguments: { cmd: "printf 'phase-tool-done'" } }],
      preamble: {
        text: preamble,
        startedPhase: 'final_answer',
        completedPhase: 'commentary',
        doneDelayMs: 1200,
      },
    },
    { responseContent: answer, doneDelayMs: 4000 },
  ])
  const taskId = await context.start(marker)
  const messages = context.page.getByTestId('messages-container')
  await expect(messages.getByText(preamble, { exact: true })).toHaveCount(1, { timeout: 120_000 })
  await expect(messages.getByText(answer, { exact: true })).toHaveCount(1, { timeout: 120_000 })
  await expect(messages.getByText(preamble, { exact: true })).toHaveCount(1)
  await context.page.reload({ waitUntil: 'domcontentloaded' })
  await expect(messages.getByText(preamble, { exact: true })).toHaveCount(1, { timeout: 120_000 })
  await context.waitForTerminal(taskId)
  const task = await context.readTask(taskId)
  const text = task.subtasks
    .flatMap(subtask => subtask.result?.blocks ?? [])
    .filter(block => block.type === 'text')
  expect(text.filter(block => block.content === preamble)).toHaveLength(1)
  expect(text.filter(block => block.content === answer)).toHaveLength(1)
  expect(new Set(text.map(block => block.id)).size).toBe(text.length)
  await context.page.reload({ waitUntil: 'domcontentloaded' })
  await expect(messages.getByText(preamble, { exact: true })).toHaveCount(1, { timeout: 120_000 })
  await expect(messages.getByText(answer, { exact: true })).toHaveCount(1)
}
