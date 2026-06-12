import type { Task } from '@/types/api'

/**
 * Sort tasks by most-recent activity first, falling back to creation time.
 */
export function sortTasksByTime(tasks: Task[] = []): Task[] {
  return [...tasks].sort((left, right) => {
    const leftTime = new Date(left.updated_at || left.created_at || 0).getTime()
    const rightTime = new Date(right.updated_at || right.created_at || 0).getTime()
    return rightTime - leftTime
  })
}

/**
 * Whether a task belongs to a project (and therefore must not appear in the
 * standalone conversation list).
 */
export function isStandaloneTask(task: Task): boolean {
  return !task.project_id
}

/**
 * Build the standalone "conversations" list: standalone tasks only, sorted by
 * recent activity. This is the single source of truth for the partition rule
 * shared by the desktop sidebar and the mobile drawer.
 */
export function selectStandaloneConversations(recentTasks: Task[]): Task[] {
  return sortTasksByTime(recentTasks).filter(isStandaloneTask)
}
