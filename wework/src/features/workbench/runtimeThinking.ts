import type {
  ProcessingBlock,
  RuntimeConversationTurn,
  ToolBlock,
  WorkbenchMessage,
} from '@/types/workbench'

const MAX_LIVE_ACTIVITY_TOOLS = 3
const MAX_LIVE_ACTIVITY_INPUT_LENGTH = 2_048
const MAX_LIVE_ACTIVITY_INPUT_DEPTH = 2
const MAX_LIVE_ACTIVITY_PROCESS_TEXT_LENGTH = 8_192
const LIVE_ACTIVITY_INPUT_KEYS = new Set([
  'command',
  'cmd',
  'commandLine',
  'file_path',
  'filePath',
  'filepath',
  'path',
  'file',
  'filename',
  'target_file',
  'targetFile',
  'notebook_path',
  'notebookPath',
  'query',
  'pattern',
  'search',
  'directory',
  'dir',
  'root',
  'cwd',
  'workdir',
  'workingDirectory',
  'patch',
  'content',
  'input',
  'arguments',
])

export type RuntimeLiveToolActivity = Pick<
  ToolBlock,
  'id' | 'status' | 'toolName' | 'toolInput' | 'createdAt' | 'completedAt' | 'durationMs'
>

export interface RuntimeLiveActivity {
  active: boolean
  thinking: string
  processText: string
  tools: RuntimeLiveToolActivity[]
}

export const EMPTY_RUNTIME_LIVE_ACTIVITY: RuntimeLiveActivity = {
  active: false,
  thinking: '',
  processText: '',
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

    return populatedRuntimeLiveActivityOrEmpty({
      active: true,
      thinking: compactLiveActivityText(getRuntimeMessageActiveThinking(message)),
      processText: compactLiveActivityText(getLatestProcessTextBlock(message.blocks)),
      tools: getLatestToolActivities(message.blocks),
    })
  }
  return EMPTY_RUNTIME_LIVE_ACTIVITY
}

export function getLatestRuntimeLiveActivityFromTurns(
  turns: RuntimeConversationTurn[]
): RuntimeLiveActivity {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (!turn || (turn.status !== 'pending' && turn.status !== 'streaming')) continue

    const lastUserIndex = turn.items.findLastIndex(item => item.type === 'user_message')
    return populatedRuntimeLiveActivityOrEmpty(runtimeLiveActivityFromTurn(turn, lastUserIndex + 1))
  }
  return EMPTY_RUNTIME_LIVE_ACTIVITY
}

function runtimeLiveActivityFromTurn(
  turn: RuntimeConversationTurn,
  start: number
): RuntimeLiveActivity {
  let thinking = turn.streamingThinkingContent?.trim() ?? ''
  let processText = ''
  const tools: RuntimeLiveToolActivity[] = []

  for (let index = turn.items.length - 1; index >= start; index -= 1) {
    const item = turn.items[index]
    if (item?.type !== 'block') continue
    const block = item.block
    if (!processText && block.type === 'text' && block.content.trim()) {
      processText = block.content.trim()
    } else if (
      !thinking &&
      block.type === 'thinking' &&
      block.status !== 'done' &&
      block.status !== 'error' &&
      block.content.trim()
    ) {
      thinking = block.content
    }
    if (block.type === 'tool' && tools.length < MAX_LIVE_ACTIVITY_TOOLS) {
      tools.push(toLiveToolActivity(block))
    }
  }

  return {
    active: true,
    thinking: compactLiveActivityText(thinking),
    processText: compactLiveActivityText(processText),
    tools: tools.reverse(),
  }
}

function populatedRuntimeLiveActivityOrEmpty(activity: RuntimeLiveActivity): RuntimeLiveActivity {
  return activity.thinking || activity.processText || activity.tools.length > 0
    ? activity
    : EMPTY_RUNTIME_LIVE_ACTIVITY
}

function getLatestProcessTextBlock(blocks: ProcessingBlock[] | undefined): string {
  if (!blocks?.length) return ''
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.type === 'text' && block.content.trim()) return block.content.trim()
  }
  return ''
}

function getLatestToolActivities(blocks: ProcessingBlock[] | undefined): RuntimeLiveToolActivity[] {
  if (!blocks?.length) return []
  const tools: RuntimeLiveToolActivity[] = []
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.type !== 'tool') continue
    tools.push(toLiveToolActivity(block))
    if (tools.length === MAX_LIVE_ACTIVITY_TOOLS) break
  }
  return tools.reverse()
}

function toLiveToolActivity(block: ToolBlock): RuntimeLiveToolActivity {
  return {
    id: block.id,
    status: block.status,
    toolName: block.toolName,
    toolInput: compactLiveActivityToolInput(block.toolInput),
    createdAt: block.createdAt,
    completedAt: block.completedAt,
    durationMs: block.durationMs,
  }
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

function compactLiveActivityToolInput(
  input: Record<string, unknown> | undefined,
  depth = 0
): Record<string, unknown> | undefined {
  if (!input || depth >= MAX_LIVE_ACTIVITY_INPUT_DEPTH) return undefined

  const compact: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!LIVE_ACTIVITY_INPUT_KEYS.has(key)) continue
    if (typeof value === 'string') {
      compact[key] = value.slice(0, MAX_LIVE_ACTIVITY_INPUT_LENGTH)
      continue
    }
    if (
      (key === 'input' || key === 'arguments') &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const nested = compactLiveActivityToolInput(value as Record<string, unknown>, depth + 1)
      if (nested) compact[key] = nested
    }
  }
  return Object.keys(compact).length > 0 ? compact : undefined
}

function compactLiveActivityText(value: string): string {
  return value.length > MAX_LIVE_ACTIVITY_PROCESS_TEXT_LENGTH
    ? value.slice(-MAX_LIVE_ACTIVITY_PROCESS_TEXT_LENGTH)
    : value
}
