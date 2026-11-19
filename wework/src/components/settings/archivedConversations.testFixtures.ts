import type { ArchivedConversationItem } from '@/types/api'

export const archivedItem: ArchivedConversationItem = {
  id: 'conversation-1',
  taskId: 'codex-1',
  title: 'Greet user',
  projectKey: 'project-1',
  projectName: 'weekly-mail',
  workspacePath: '/Users/crystal/dev/git/weekly-report',
  deviceId: 'device-1',
  deviceAddress: '10.201.3.200:1420',
  source: 'local',
  createdAt: '2026-06-24T10:00:00Z',
  updatedAt: '2026-06-24T10:30:00Z',
}

export function archivedItemAt(
  index: number,
  overrides: Partial<ArchivedConversationItem> = {}
): ArchivedConversationItem {
  return {
    ...archivedItem,
    id: `conversation-${index}`,
    taskId: `codex-${index}`,
    title: `Archived conversation ${index}`,
    ...overrides,
  }
}
