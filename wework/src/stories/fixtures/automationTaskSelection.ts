import { emptyAutomationDraft } from '@/features/automations/automationDraft'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'

export function automationTaskSelectionFixture(empty = false) {
  const devices: DeviceInfo[] = [
    {
      id: 1,
      device_id: 'online',
      name: 'Available device',
      device_type: 'local',
      status: 'online',
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
      is_default: true,
    },
    {
      id: 2,
      device_id: 'offline',
      name: 'Offline device',
      device_type: 'local',
      status: 'offline',
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
      is_default: false,
    },
  ]
  const runtimeWork: RuntimeWorkListResponse = {
    projects: [],
    chats: empty
      ? []
      : devices.map((device, index) => ({
          deviceId: device.device_id,
          workspacePath: '/example/project',
          available: device.status === 'online',
          tasks: [
            {
              taskId: index === 0 ? 'ready' : 'unavailable',
              title: index === 0 ? 'Pinned review' : 'Offline task',
              workspacePath: '/example/project',
              runtime: 'codex',
              pinned: true,
            },
          ],
        })),
    totalTasks: empty ? 0 : 2,
  }
  return {
    draft: {
      ...emptyAutomationDraft('local'),
      name: 'Scheduled review',
      prompt: 'Review the pinned task',
      conversationMode: 'continue_thread' as const,
    },
    devices,
    runtimeWork,
  }
}
