import assert from 'node:assert/strict'

interface MentionTask {
  task_id: number
  task_title: string
  task_status: string
  updated_at?: string | null
}

export interface VisibleMentionTask {
  taskId: number
  title: string
}

interface ProjectMentionSetup {
  taskIds: number[]
  visibleTasks: VisibleMentionTask[]
  waitForCompleted: (taskId: number) => Promise<void>
  touchTask: (task: VisibleMentionTask) => Promise<void>
  readProjectTasks: () => Promise<MentionTask[]>
}

/** Establish menu ordering after every real fixture turn has finished. */
export async function prepareProjectMentionTasks({
  taskIds,
  visibleTasks,
  waitForCompleted,
  touchTask,
  readProjectTasks,
}: ProjectMentionSetup): Promise<void> {
  for (const taskId of taskIds) await waitForCompleted(taskId)

  // Project summaries truncate updated_at to seconds. Cross that precision
  // boundary once so a smaller target id cannot lose a timestamp tie to fillers.
  await new Promise(resolve => setTimeout(resolve, 1_100))
  for (const task of visibleTasks) await touchTask(task)

  const tasks = await readProjectTasks()
  assert.deepEqual(
    tasks.map(task => task.task_id).sort((left, right) => left - right),
    [...taskIds].sort((left, right) => left - right),
    'Project mention fixtures must be present exactly once'
  )
  for (const task of tasks) {
    assert.equal(task.task_status, 'COMPLETED', `Fixture task ${task.task_id} is not complete`)
    assert.ok(
      Number.isFinite(Date.parse(task.updated_at ?? '')),
      `Fixture task ${task.task_id} has no valid ordering timestamp`
    )
  }
  const visibleIds = new Set(visibleTasks.map(task => task.taskId))
  const newestFiller = Math.max(
    ...tasks
      .filter(task => !visibleIds.has(task.task_id))
      .map(task => Math.floor(Date.parse(task.updated_at!) / 1_000))
  )
  for (const visible of visibleTasks) {
    const task = tasks.find(task => task.task_id === visible.taskId)
    assert.ok(task, `Mention target ${visible.taskId} is missing`)
    assert.equal(task.task_title, visible.title, 'The mention fixture title changed')
    assert.ok(
      Math.floor(Date.parse(task.updated_at!) / 1_000) > newestFiller,
      `Mention target ${visible.taskId} must sort ahead of every filler`
    )
  }
}
