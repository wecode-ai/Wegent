// @vitest-environment node

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { followUpAgentHistory } from '../e2e/desktop/modules/follow-up-agent-history.mjs'

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal()),
  writeFile: vi.fn(async () => {}),
}))

const options = {
  workspacePath: join(tmpdir(), 'wework-history-budget-fixture'),
  uiTimeoutMs: 10_000,
  modelResponseTimeoutMs: 30_000,
}
const initialPrompt = 'WeworkReusedAgentHistory'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => vi.useRealTimers())

function history() {
  return followUpAgentHistory(options, 'main', () => {
    throw new Error('The initial history must finish before requesting a held command')
  })
}

function initialControl(parentDoneAt, childDoneAt) {
  const nextPhase = new Error('The original history message is ready')
  const commands = []
  return {
    nextPhase,
    commands,
    async command(action, selector, values) {
      commands.push({ action, selector, values, at: Date.now() })
      if (action === 'getWorkbenchDebugSnapshot') {
        return JSON.stringify({
          workbench: { currentRuntimeTask: { taskId: 'initial-history' } },
          pane: {
            messageSummary: {
              lastMessage: {
                role: 'assistant',
                status: Date.now() >= parentDoneAt ? 'done' : 'streaming',
              },
            },
            subagentStatuses:
              childDoneAt === undefined
                ? []
                : [{ status: Date.now() >= childDoneAt ? 'done' : 'running' }],
          },
        })
      }
      // Stop at the next assertion, keeping this test at the initial native-turn boundary.
      if (action === 'getAttribute') throw nextPhase
      expect(['click', 'fill', 'waitFor', 'press']).toContain(action)
      return ''
    },
  }
}

test('waits for normal parent and child completion beyond the UI budget', async () => {
  const control = initialControl(12_000, 11_000)
  let outcome
  const result = history()
    .verify(control, {})
    .catch(error => {
      outcome = { error, at: Date.now() }
    })

  await vi.advanceTimersByTimeAsync(options.uiTimeoutMs)
  expect(outcome).toBeUndefined()
  expect(control.commands.some(command => command.action === 'getAttribute')).toBe(false)
  await vi.advanceTimersByTimeAsync(2_000)
  await result

  expect(outcome).toEqual({ error: control.nextPhase, at: 12_000 })
  expect(writeFile).toHaveBeenCalledExactlyOnceWith(
    join(options.workspacePath, 'reused-agent-command-release'),
    'release'
  )
  expect(vi.getTimerCount()).toBe(0)
})

test.each([
  ['unfinished parent', Infinity, 0],
  ['missing child', 0, undefined],
  ['running child', 0, Infinity],
])('rejects %s at the existing model deadline', async (_label, parentDoneAt, childDoneAt) => {
  const control = initialControl(parentDoneAt, childDoneAt)
  const result = history()
    .verify(control, {})
    .catch(error => ({ error, at: Date.now() }))

  await vi.advanceTimersByTimeAsync(options.modelResponseTimeoutMs)
  const outcome = await result

  expect(outcome.error.message).toContain('The first native turn and its child agent must finish')
  expect(outcome.at).toBe(options.modelResponseTimeoutMs)
  expect(control.commands.some(command => command.action === 'getAttribute')).toBe(false)
  expect(writeFile).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

const request = { headers: {} }
function modelBody(callId, agentStatus) {
  return {
    tools: ['spawn_agent', 'list_agents'].map(name => ({ type: 'function', name })),
    input: [
      { role: 'user', content: initialPrompt },
      ...(callId
        ? [
            {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify({
                agents: [
                  { agent_name: '/root/follow_up_history_child', agent_status: agentStatus },
                ],
              }),
            },
          ]
        : []),
    ],
  }
}
const response = () => ({ writeHead: vi.fn(), end: vi.fn() })

test('keeps polling the native child after the UI budget and requires its completed result', async () => {
  const fixture = history()
  await fixture.handle(request, modelBody(), response())
  await fixture.handle(request, modelBody(), response())
  vi.setSystemTime(12_000)
  await fixture.handle(request, modelBody('history-child-status-1', 'running'), response())
  expect(fixture.diagnostics().initialReady).toBe(false)

  const completed = response()
  await fixture.handle(
    request,
    modelBody('history-child-status-2', { completed: 'Child work completed' }),
    completed
  )

  expect(fixture.diagnostics().initialReady).toBe(true)
  expect(completed.end.mock.calls[0][0]).toContain(`${initialPrompt} completed result`)
})

test('does not renew the model deadline while the native child remains running', async () => {
  const fixture = history()
  await fixture.handle(request, modelBody(), response())
  await fixture.handle(request, modelBody(), response())
  vi.setSystemTime(options.modelResponseTimeoutMs - 1)
  await fixture.handle(request, modelBody('history-child-status-1', 'running'), response())
  vi.setSystemTime(options.modelResponseTimeoutMs)
  const expired = response()

  await expect(
    fixture.handle(request, modelBody('history-child-status-2', 'running'), expired)
  ).rejects.toThrow('The real child agent must finish before parent execution')
  expect(expired.end).not.toHaveBeenCalled()
  expect(fixture.diagnostics().initialReady).toBe(false)
})
