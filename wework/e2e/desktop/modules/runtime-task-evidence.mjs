export function findRuntimeWorkTask(runtimeWork, taskId) {
  const workspaces = Array.isArray(runtimeWork.workspaces)
    ? runtimeWork.workspaces
    : Object.values(runtimeWork.workspaces ?? {})
  const matches = workspaces
    .flatMap(workspace => (Array.isArray(workspace.tasks) ? workspace.tasks : []))
    .filter(task => task.taskId === taskId || task.task_id === taskId)
  if (matches.length > 1) throw new Error(`Duplicate owning executor task ID: ${taskId}`)
  return matches[0]
}

export async function waitForCompletedRuntimeTaskThread(control, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let observedTask = null
  const timeoutError = () =>
    new Error(
      `The owning executor did not expose a completed Codex thread for task ${taskId} within ${timeoutMs}ms: ${JSON.stringify(observedTask)}`
    )

  while (Date.now() < deadline) {
    let requestTimer
    let response
    try {
      response = await Promise.race([
        control.command('getLocalRuntimeWork', 'body'),
        new Promise((_, reject) => {
          requestTimer = setTimeout(() => reject(timeoutError()), deadline - Date.now())
        }),
      ])
    } finally {
      clearTimeout(requestTimer)
    }
    if (Date.now() >= deadline) throw timeoutError()
    const task = findRuntimeWorkTask(JSON.parse(response), taskId)
    const threadId = typeof task?.threadId === 'string' ? task.threadId.trim() : null
    observedTask = {
      taskId: task?.taskId ?? task?.task_id ?? null,
      threadId,
      running: task?.running ?? null,
    }
    if (threadId && task.running === false) return threadId
    await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())))
  }
  throw timeoutError()
}
