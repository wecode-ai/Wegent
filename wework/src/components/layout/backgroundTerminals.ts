import { commandExecutionPayload } from '@wegent/chat-core/command-execution'
import type { ToolBlock, WorkbenchMessage } from '@/types/workbench'
import type { RightWorkspaceBackgroundTerminalTab } from './workspace-panels/RightWorkspacePanel'

export interface BackgroundTerminal {
  id: string
  tabId: RightWorkspaceBackgroundTerminalTab
  command: string
  cwd: string
  block: ToolBlock
  running: boolean
  background: boolean
}

export function conversationTerminals(
  messages: WorkbenchMessage[],
  taskId: string
): BackgroundTerminal[] {
  const terminals = new Map<string, BackgroundTerminal>()
  const activeTurnIds = new Set(
    messages
      .filter(message => ['pending', 'streaming'].includes(message.runtimeStatus ?? message.status))
      .map(message => message.turnId ?? message.subtaskId)
      .filter((id): id is string => Boolean(id))
  )
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      const payload = commandExecutionPayload(block)
      if (block.type !== 'tool' || !payload || block.parentToolUseId) continue
      const command = block.toolInput?.command ?? block.toolInput?.cmd
      const running =
        block.status !== 'done' && block.status !== 'error' && payload.status === 'inProgress'
      terminals.set(block.id, {
        id: block.id,
        tabId: `background-terminal:${encodeURIComponent(taskId)}:${encodeURIComponent(block.id)}`,
        command: typeof command === 'string' ? command : '',
        cwd: typeof block.toolInput?.cwd === 'string' ? block.toolInput.cwd : '',
        block,
        running,
        background:
          running &&
          !activeTurnIds.has(message.turnId ?? message.subtaskId ?? block.subtaskId) &&
          !['pending', 'streaming'].includes(message.runtimeStatus ?? message.status ?? ''),
      })
    }
  }
  return [...terminals.values()]
}
