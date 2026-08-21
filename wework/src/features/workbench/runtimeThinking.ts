import type { ProcessingBlock, ToolBlock, WorkbenchMessage } from '@/types/workbench'

export type RuntimeLiveToolActivity = Pick<
  ToolBlock,
  'id' | 'status' | 'toolName' | 'toolInput' | 'createdAt' | 'completedAt' | 'durationMs'
>

export interface RuntimeLiveActivity {
  active: boolean
  thinking: string
  tools: RuntimeLiveToolActivity[]
}

export const EMPTY_RUNTIME_LIVE_ACTIVITY: RuntimeLiveActivity = {
  active: false,
  thinking: '',
  tools: [],
}

export function getRuntimeMessageActiveThinking(message: WorkbenchMessage): string {
  if (message.role !== 'assistant' || message.status !== 'streaming') return ''

  return message.streamingThinkingContent?.trim() || getLatestActiveThinkingBlock(message.blocks)
}

export function getLatestRuntimeLiveActivity(messages: WorkbenchMessage[]): RuntimeLiveActivity {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant' || message.status !== 'streaming') continue

    return {
      active: true,
      thinking: getRuntimeMessageActiveThinking(message),
      tools:
        message.blocks
          ?.filter(block => block.type === 'tool')
          .map(block => ({
            id: block.id,
            status: block.status,
            toolName: block.toolName,
            toolInput: block.toolInput,
            createdAt: block.createdAt,
            completedAt: block.completedAt,
            durationMs: block.durationMs,
          })) ?? [],
    }
  }
  return EMPTY_RUNTIME_LIVE_ACTIVITY
}

export function runtimeLiveActivitySnapshot(activity: RuntimeLiveActivity): string {
  if (!activity.active || (!activity.thinking && activity.tools.length === 0)) return ''
  return JSON.stringify(activity)
}

export function runtimeLiveActivityFromSnapshot(snapshot: string): RuntimeLiveActivity {
  return snapshot ? (JSON.parse(snapshot) as RuntimeLiveActivity) : EMPTY_RUNTIME_LIVE_ACTIVITY
}

function getLatestActiveThinkingBlock(blocks: ProcessingBlock[] | undefined): string {
  if (!blocks?.length) return ''

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (
      block?.type === 'thinking' &&
      block.status !== 'done' &&
      block.status !== 'error' &&
      block.content.trim()
    ) {
      return block.content
    }
  }

  return ''
}
