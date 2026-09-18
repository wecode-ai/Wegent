import type { RuntimeConversationTurn } from '@wegent/chat-core/runtime-conversation'
import {
  EMPTY_RUNTIME_LIVE_ACTIVITY,
  getLatestRuntimeLiveActivityFromTurns,
  type RuntimeLiveToolActivity,
} from '@wegent/chat-core/runtime-thinking'
import { getRuntimeTaskResponsePreview } from '@wegent/chat-core/runtime-task-response-preview'
import {
  getToolActivityFilePaths,
  getToolActivityKind,
  getToolActivitySearchItem,
  unwrapShellCommand,
} from '../conversation/blocks/toolBlockActivity'
import { getInputField } from '../conversation/blocks/toolBlockKinds'

export function runtimeTaskProgress(turns: RuntimeConversationTurn[], active: boolean) {
  return {
    activity: active ? getLatestRuntimeLiveActivityFromTurns(turns) : EMPTY_RUNTIME_LIVE_ACTIVITY,
    responsePreview: getRuntimeTaskResponsePreview(turns, active) || null,
  }
}

export function runtimeToolActivityText(
  block: RuntimeLiveToolActivity,
  t: (key: string) => string
): string {
  const kind = getToolActivityKind(block)
  const paths = getToolActivityFilePaths(block)
  const path = paths[0] ? displayActivityPath(paths[0]) : ''
  const command = getInputField(block, 'command', 'cmd', 'commandLine')?.replace(/\s+/g, ' ').trim()
  const search = getToolActivitySearchItem(block)
  const running = block.status !== 'done' && block.status !== 'error'

  if (kind === 'command') {
    return activityLabel(
      t('tool_activity.command_action'),
      command ? unwrapShellCommand(command) : undefined
    )
  }
  if (kind === 'file') {
    return activityLabel(t('tool_activity.file_action'), path)
  }
  if (kind === 'search') {
    return activityLabel(
      t(running ? 'tool_activity.search_running' : 'tool_activity.search_done'),
      search?.query
    )
  }
  if (kind === 'edit') {
    return activityLabel(t('tool_activity.edit_action'), path)
  }
  if (kind === 'create') {
    return activityLabel(t('tool_activity.create_action'), path)
  }
  return activityLabel(t('tool_activity.other_action'), block.toolName)
}

function activityLabel(label: string, detail: string | undefined): string {
  return detail ? `${label} · ${detail}` : label
}

function displayActivityPath(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? path
}
