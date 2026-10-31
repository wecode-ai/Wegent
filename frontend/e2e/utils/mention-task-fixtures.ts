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
}
