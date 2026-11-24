import type { ArchivedConversationItem } from '@/types/api'
import type { LocalHarnessSessionDescriptor } from '@/lib/local-terminal'

export function itemAddressKey(item: ArchivedConversationItem) {
  return `${item.deviceId}\0${item.workspacePath}\0${item.taskId}`
}

export function localHarnessSessionId(item: ArchivedConversationItem): string | null {
  const handle = item.runtimeHandle
  if (!handle || handle.kind !== 'local_harness_session' || typeof handle.sessionId !== 'string') {
    return null
  }
  return handle.sessionId
}

export function localHarnessArchivedItem(
  session: LocalHarnessSessionDescriptor
): ArchivedConversationItem {
  const normalizedPath = session.cwd.replace(/[\\/]+$/, '')
  const projectName = normalizedPath.split(/[\\/]/).filter(Boolean).at(-1) || session.cwd
  return {
    id: `local-harness:${session.session_id}`,
    taskId: session.session_id,
    title: session.title,
    projectId: session.project_id,
    projectKey:
      session.project_id === null
        ? `local-harness-workspace:${session.cwd}`
        : `project:${session.project_id}`,
    projectName,
    workspacePath: session.cwd,
    workspaceKind: 'chat',
    runtimeHandle: {
      kind: 'local_harness_session',
      sessionId: session.session_id,
      harnessId: session.harness_id,
    },
    deviceId: 'local-harness',
    deviceName: 'OpenCode',
    source: 'local',
    runtime: session.harness_id,
    createdAt: new Date(session.created_at).toISOString(),
    updatedAt: new Date(session.archived_at ?? session.created_at).toISOString(),
  }
}
