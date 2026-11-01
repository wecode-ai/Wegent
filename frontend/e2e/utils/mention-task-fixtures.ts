/**
 * Finish real fixture executions before arranging their mention order.
 * Completion callbacks update task timestamps, so they must not race the touch.
 */
export async function settleMentionTasks(
  taskIds: number[],
  waitForTerminal: (taskId: number) => Promise<void>
): Promise<void> {
  const batchSize = 8
  for (let offset = 0; offset < taskIds.length; offset += batchSize) {
    await Promise.all(taskIds.slice(offset, offset + batchSize).map(waitForTerminal))
  }

  // Project task timestamps have second precision. The subsequent touch must
  // occupy a later second, otherwise newer fixture IDs win the timestamp tie.
  const untilNextSecond = 1000 - (Date.now() % 1000) + 1
  await new Promise<void>(resolve => setTimeout(resolve, untilNextSecond))
}
