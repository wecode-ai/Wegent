import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

function taskStates(value) {
  if (!value || typeof value !== 'object') return []
  if (typeof value.taskId === 'string' && typeof value.running === 'boolean') {
    return [
      {
        taskId: value.taskId,
        running: value.running,
        status: value.status,
        completedAt: value.completedAt ?? null,
        goalStatus: value.goalStatus,
      },
    ]
  }
  return Object.values(value).flatMap(taskStates)
}

function transportEvidence(capture) {
  if (!capture) return null
  const { value, ...timing } = capture
  return {
    ...timing,
    taskId: value.params?.taskId ?? value.payload?.taskId,
    installationId: value.params?.installationId,
    event: value.event,
    sequence: value.sequence,
    subtaskId: value.payload?.subtaskId,
    goalStatus: value.payload?.data?.goal?.status,
    toolName: value.payload?.data?.block?.tool_name,
    running: value.result?.running,
    turns: value.result?.turns?.map(turn => ({ id: turn.id, status: turn.status })),
    tasks: taskStates(value.result),
  }
}

export function runtimeTransportGates(control) {
  const command = (action, value) =>
    control.command(action, 'body', {
      value: typeof value === 'string' ? value : JSON.stringify(value),
    })
  const read = async id => JSON.parse(await command('readRuntimeTransportGate', id))
  return {
    arm: rule => command('armRuntimeTransportGate', rule),
    read,
    release: id => command('releaseRuntimeTransportGate', id),
    reset: (keep = []) => command('resetRuntimeTransportGates', keep),
    async wait(id, kick, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const evidence = await read(id)
        if (evidence) return evidence
        await kick?.()
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.fail(`The real runtime transport did not reach gate ${id}`)
    },
    async save(resultDir, filename, ids) {
      const evidence = Object.fromEntries(
        await Promise.all(ids.map(async id => [id, await read(id)]))
      )
      await writeFile(
        join(resultDir, filename),
        JSON.stringify(
          Object.fromEntries(
            Object.entries(evidence).map(([id, capture]) => [id, transportEvidence(capture)])
          ),
          null,
          2
        )
      )
      return evidence
    },
  }
}
