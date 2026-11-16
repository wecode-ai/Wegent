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
    subtasks: Array<{
      result?: { value?: string; blocks?: Array<{ id: string; type: string; content?: string }> }
    }>
  }>
}

/** Verify one text block survives a late phase change, persistence, and reload. */
export async function assertCodexPhaseTransition(
  context: PhaseRegressionContext,
  options: { rewriteCompletedText?: boolean } = {}
): Promise<void> {
  const marker = `PHASE_${Date.now()}`
  const streamedPreamble = `正在检查🙂 ${marker}`
  const preamble = options.rewriteCompletedText ? `检查计划已更新🙂 ${marker}` : streamedPreamble
  const answer = `检查完成 ${marker}`
  await context.configure(marker, [
    {
      toolCalls: [{ toolName: 'exec_command', arguments: { cmd: "printf 'phase-tool-done'" } }],
      preamble: {
        text: streamedPreamble,
        completedText: preamble,
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
  const values = task.subtasks.map(subtask => subtask.result?.value ?? '').join('\n')
  expect(values).toContain(answer)
  if (options.rewriteCompletedText) {
    expect(text.some(block => block.content === streamedPreamble)).toBe(false)
    expect(values).not.toContain(streamedPreamble)
    await expect(messages.getByText(streamedPreamble, { exact: true })).toHaveCount(0)
  }
  await context.page.reload({ waitUntil: 'domcontentloaded' })
  await expect(messages.getByText(preamble, { exact: true })).toHaveCount(1, { timeout: 120_000 })
  await expect(messages.getByText(answer, { exact: true })).toHaveCount(1)
}
