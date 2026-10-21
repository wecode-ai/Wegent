import type { WeworkNotification } from '@/api/notifications'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
export const assignment: WeworkNotification = {
  id: 'assignment',
  kind: 'issue_dispatch_assignment',
  title: 'New task',
  body: 'Assigned to you',
  url: 'wework://boards/12/issues/ISSUE-1',
  created_at: '2026-10-21T12:00:00Z',
  read_at: '2026-10-21T12:01:00Z',
  payload: {
    projectId: '12',
    itemId: 'ISSUE-1',
    humanAssignmentId: 'human-1',
    taskTitle: 'Review',
  },
}
export const runtimeItem: RuntimeTaskReminderItem = {
  key: 'device\0task',
  address: { deviceId: 'device', taskId: 'task' },
  projectName: 'Project',
  workspace: { deviceId: 'device', available: true, workspacePath: '/project', tasks: [] },
  task: {
    taskId: 'task',
    title: 'Review',
    runtime: 'codex',
    workspacePath: '/project',
    status: 'running',
    running: true,
    createdAt: '2026-10-21T12:00:00Z',
    updatedAt: '2026-10-21T12:02:00Z',
    runtimeHandle: {
      origin: {
        initiatedBy: 'stand_in',
        projectStore: 'cloud',
        cloudProjectId: '12',
        loopItemId: 'ISSUE-1',
        humanAssignmentId: 'human-1',
      },
    },
  },
}
