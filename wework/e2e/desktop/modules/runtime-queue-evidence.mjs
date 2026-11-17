import { requestExecutor } from './executor-rpc.mjs'

function fields(source, names) {
  return Object.fromEntries(
    names.flatMap(name => {
      const value = source?.[name]
      return value === null ||
        ['string', 'boolean'].includes(typeof value) ||
        (typeof value === 'number' && Number.isFinite(value))
        ? [[name, value]]
        : []
    })
  )
}

function activeIds(capacity) {
  return [...new Set((capacity?.active_task_ids ?? []).filter(id => typeof id === 'string'))]
}

async function read(control, method, params, timeoutMs) {
  try {
    return await requestExecutor(control, method, params, timeoutMs)
  } catch {
    // Provider errors can contain private upstream data; record only availability.
    return null
  }
}

export async function collectRuntimeQueueEvidence(control, taskId, timeoutMs) {
  const capacity = await read(control, 'runtime.capacity.get', {}, timeoutMs)
  const activeTaskIds = activeIds(capacity)
  const tasks = await Promise.all(
    [...new Set([taskId, ...activeTaskIds])].map(async id => {
      const result = await read(control, 'runtime.tasks.get', { taskId: id }, timeoutMs)
      if (!result?.success || !result.task) return { taskId: id, unavailable: true }
      return {
        ...fields(result.task, [
          'taskId',
          'threadId',
          'status',
          'running',
          'queuePosition',
          'threadStatus',
          'turnStatus',
          'interactionStatus',
        ]),
        executionState: fields(result.task.executionState, [
          'phase',
          'revision',
          'epoch',
          'nativeSequence',
          'updatedAt',
          'turnId',
          'latestTurnId',
          'requestTurnId',
          'continuation',
          'outcome',
          'executionOutcome',
          'startedAt',
          'completedAt',
          'durationMs',
        ]),
      }
    })
  )
  return {
    capturedAt: new Date().toISOString(),
    capacity: capacity
      ? {
          ...fields(capacity, ['limit', 'active', 'queued']),
          activeTaskIds,
          categories: Object.fromEntries(
            ['personal', 'standIn', 'agent']
              .filter(kind => capacity.categories?.[kind])
              .map(kind => [
                kind,
                {
                  ...fields(capacity.categories[kind], ['limit', 'active', 'queued']),
                  activeTaskIds: activeIds(capacity.categories[kind]),
                },
              ])
          ),
        }
      : { unavailable: true },
    tasks,
  }
}
