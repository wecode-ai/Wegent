/** Keep fixture requests below the shared Backend connection budget. */
export async function forEachTaskFixtureBatch(
  taskIds: number[],
  operation: (taskId: number) => Promise<void>
): Promise<void> {
  const batchSize = 8
  for (let offset = 0; offset < taskIds.length; offset += batchSize) {
    const results = await Promise.allSettled(
      taskIds.slice(offset, offset + batchSize).map(operation)
    )
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}

/**
 * Finish real fixture executions before arranging their mention order.
 * Completion callbacks update task timestamps, so they must not race the touch.
 */
export async function settleMentionTasks(
  taskIds: number[],
  waitForTerminal: (taskId: number) => Promise<void>
): Promise<void> {
  await forEachTaskFixtureBatch(taskIds, waitForTerminal)

  // Project task timestamps have second precision. The subsequent touch must
  // occupy a later second, otherwise newer fixture IDs win the timestamp tie.
  const untilNextSecond = 1000 - (Date.now() % 1000) + 1
  await new Promise<void>(resolve => setTimeout(resolve, untilNextSecond))
}

/** Attempt independent cleanup stages before reporting their failures. */
export async function cleanupFixtureStages(stages: Array<() => Promise<void>>): Promise<void> {
  const errors: unknown[] = []
  for (const stage of stages) {
    try {
      await stage()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Independent fixture cleanup stages failed')
}
