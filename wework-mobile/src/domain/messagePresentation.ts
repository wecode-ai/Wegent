import type { ChatProcessingBlock, ChatToolBlock } from '@/types/runtime'

export type ToolActivityKind =
  'web' | 'file' | 'search' | 'command' | 'create' | 'edit' | 'guidance' | 'tool'

export type MessageDisplayRow =
  | { type: 'narrative'; id: string; block: Exclude<ChatProcessingBlock, ChatToolBlock> }
  | { type: 'tool'; id: string; block: ChatToolBlock; kind: ToolActivityKind }
  | {
      type: 'tool-group'
      id: string
      blocks: ChatToolBlock[]
      kind: ToolActivityKind
      label: string
      failed: boolean
    }

const COMMAND_TOOLS = new Set([
  'bash',
  'exec',
  'exec_command',
  'execute_command',
  'functions.exec',
  'functions.exec_command',
  'run_terminal_command',
])
const FILE_TOOLS = new Set(['read', 'read_file'])
const CREATE_TOOLS = new Set(['write', 'create_file', 'write_file'])
const EDIT_TOOLS = new Set([
  'edit',
  'edit_file',
  'multi_edit',
  'multiedit',
  'notebook_edit',
  'notebookedit',
  'str_replace',
  'str_replace_editor',
  'apply_patch',
  'functions.apply_patch',
])
const GUIDANCE_TOOLS = new Set(['conversation_guidance', 'user_guidance'])
const HIDDEN_TOOLS = new Set(['write_stdin', 'functions.write_stdin', 'runtime_reconnecting'])
const SEARCH_COMMANDS = new Set(['rg', 'grep', 'find', 'fd', 'ls', 'tree', 'ag', 'ack'])
const FILE_COMMANDS = new Set(['cat', 'sed', 'head', 'tail', 'wc', 'nl', 'stat', 'file'])

export function buildMessageDisplayRows(
  blocks: ChatProcessingBlock[] | undefined,
  finalContent: string
): MessageDisplayRow[] {
  const rows: MessageDisplayRow[] = []
  let completedTools: ChatToolBlock[] = []
  let completedKind: ToolActivityKind | null = null

  const flushCompletedTools = () => {
    if (!completedTools.length || !completedKind) return
    rows.push({
      type: 'tool-group',
      id: `tool-group-${completedTools[0]?.id}-${completedTools.at(-1)?.id}`,
      blocks: completedTools,
      kind: completedKind,
      label: summarizeToolActivity(completedTools, completedKind),
      failed: completedTools.some(block => block.status === 'error'),
    })
    completedTools = []
    completedKind = null
  }

  for (const block of blocks ?? []) {
    if (block.type === 'thinking') continue
    if (block.type !== 'tool') {
      flushCompletedTools()
      if (block.type === 'text' && block.content.trim() === finalContent.trim()) continue
      if (block.content.trim()) rows.push({ type: 'narrative', id: block.id, block })
      continue
    }
    if (isHiddenTool(block)) continue

    const kind = getToolActivityKind(block)
    const completed = block.status === 'done' || block.status === 'error'
    if (!completed) {
      flushCompletedTools()
      rows.push({ type: 'tool', id: block.id, block, kind })
      continue
    }
    if (completedKind && completedKind !== kind) flushCompletedTools()
    completedKind = kind
    completedTools.push(block)
  }

  flushCompletedTools()
  return rows
}

export function getToolActivityKind(block: ChatToolBlock): ToolActivityKind {
  const name = normalizeToolName(block.toolName)
  if (name === 'web_search') return 'web'
  if (matchesToolName(name, FILE_TOOLS)) return 'file'
  if (matchesToolName(name, CREATE_TOOLS)) return 'create'
  if (matchesToolName(name, EDIT_TOOLS)) return 'edit'
  if (matchesToolName(name, GUIDANCE_TOOLS)) return 'guidance'
  if (['search', 'grep', 'glob'].some(hint => name.includes(hint))) return 'search'
  if (matchesToolName(name, COMMAND_TOOLS)) return commandActivityKind(commandFrom(block))
  return 'tool'
}

export function summarizeToolActivity(
  blocks: ChatToolBlock[],
  kind = getGroupKind(blocks)
): string {
  const count = blocks.length
  const failed = blocks.some(block => block.status === 'error')
  if (failed) return kind === 'command' ? `运行失败 ${count} 条命令` : `执行失败 ${count} 个工具`
  switch (kind) {
    case 'web':
      return `已搜索网页 ${count} 次`
    case 'file':
      return `已读取 ${count} 个文件`
    case 'search':
      return `已搜索代码 ${count} 次`
    case 'command':
      return `已运行 ${count} 条命令`
    case 'create':
      return `已新增 ${count} 个文件`
    case 'edit':
      return `已编辑 ${count} 个文件`
    case 'guidance':
      return '已引导对话'
    case 'tool':
      return `已调用 ${count} 个工具`
  }
}

export function buildThinkingPreview(content: string, maximumLength = 96): string {
  const normalized = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[#>*_[\]()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return ''
  const segments = normalized
    .split(/[。！？!?]+|\.(?=\s|$)/)
    .map(segment => segment.trim())
    .filter(Boolean)
  const preview = segments.at(-1) ?? normalized
  return preview.length <= maximumLength
    ? preview
    : `${preview.slice(0, Math.max(0, maximumLength - 3))}...`
}

function getGroupKind(blocks: ChatToolBlock[]): ToolActivityKind {
  const kinds = blocks.map(getToolActivityKind)
  const first = kinds[0]
  return first && kinds.every(kind => kind === first) ? first : 'tool'
}

function isHiddenTool(block: ChatToolBlock): boolean {
  const name = normalizeToolName(block.toolName)
  return HIDDEN_TOOLS.has(name)
}

function commandActivityKind(command?: string): ToolActivityKind {
  const executable = command
    ?.trim()
    .replace(/^\/?bin\/[^\s]+\s+-lc\s+['"]?/, '')
    .split(/\s+/)[0]
    ?.split('/')
    .pop()
    ?.toLowerCase()
  if (!executable) return 'command'
  if (SEARCH_COMMANDS.has(executable)) return 'search'
  if (FILE_COMMANDS.has(executable)) return 'file'
  if (executable === 'git' && /\s(?:grep|ls-files)(?:\s|$)/.test(command ?? '')) return 'search'
  return 'command'
}

function commandFrom(block: ChatToolBlock): string | undefined {
  for (const key of ['command', 'cmd', 'commandLine']) {
    const value = block.toolInput?.[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function matchesToolName(name: string, names: Set<string>): boolean {
  if (names.has(name)) return true
  const suffix = name.split(/__|\./).at(-1)
  return suffix ? names.has(suffix) : false
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase()
}
