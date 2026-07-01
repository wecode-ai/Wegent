import type { ProcessingBlock, ToolBlock } from '@/types/workbench'
import {
  getInputField,
  isCommandToolName,
  isFileCreateToolName,
  isFileEditToolName,
  isFileReadToolName,
  isGuidanceToolName,
  isContextCompactionToolName,
} from './toolBlockKinds'

export type ProcessingDisplayRow =
  | { type: 'block'; id: string; block: ProcessingBlock }
  | { type: 'activity_group'; id: string; blocks: ToolBlock[]; label: string }

type ToolActivityKind = 'file' | 'search' | 'command' | 'create' | 'edit' | 'guidance' | 'tool'

interface ActivityStats {
  files: number
  searches: number
  commands: number
  creates: number
  edits: number
  guidance: number
  tools: number
  failedCommands: number
  failedTools: number
}

const SEARCH_TOOL_HINTS = ['search', 'grep', 'glob']
const SEARCH_COMMANDS = new Set(['rg', 'grep', 'find', 'fd', 'ls', 'tree', 'ag', 'ack'])
const FILE_COMMANDS = new Set(['cat', 'sed', 'head', 'tail', 'wc', 'nl', 'stat', 'du', 'file'])

export function buildProcessingDisplayRows(
  blocks: ProcessingBlock[],
  options: { groupCompletedTools?: boolean } = {}
): ProcessingDisplayRow[] {
  const groupCompletedTools = options.groupCompletedTools ?? true
  const rows: ProcessingDisplayRow[] = []
  let completedTools: ToolBlock[] = []

  const flushCompletedTools = () => {
    if (completedTools.length === 0) return
    rows.push({
      type: 'activity_group',
      id: getToolGroupId(completedTools),
      blocks: completedTools,
      label: summarizeToolBlocks(completedTools),
    })
    completedTools = []
  }

  for (const block of blocks) {
    if (block.type === 'tool' && isContextCompactionToolName(block.toolName)) {
      flushCompletedTools()
      rows.push({ type: 'block', id: block.id, block })
      continue
    }

    if (groupCompletedTools && block.type === 'tool' && isCompletedToolBlock(block)) {
      completedTools.push(block)
      continue
    }

    flushCompletedTools()
    rows.push({ type: 'block', id: block.id, block })
  }

  flushCompletedTools()
  return rows
}

export function summarizeToolBlocks(blocks: ToolBlock[]): string {
  if (isWebSearchActivityGroup(blocks)) {
    return '已搜索网页'
  }

  const stats = getActivityStats(blocks)
  const parts: string[] = []

  if (stats.files > 0) parts.push(`已读取 ${formatCount(stats.files, '个文件')}`)
  if (stats.searches > 0) parts.push('已搜索代码')
  if (stats.creates > 0) parts.push(`已新增 ${formatCount(stats.creates, '个文件')}`)
  if (stats.edits > 0) parts.push(`已编辑 ${formatCount(stats.edits, '个文件')}`)
  if (stats.guidance > 0) parts.push('已引导对话')
  if (stats.commands > 0) parts.push(`已运行 ${formatCount(stats.commands, '条命令')}`)
  if (stats.tools > 0) parts.push(`已执行 ${formatCount(stats.tools, '个工具')}`)
  if (stats.failedCommands > 0) {
    parts.push(`运行失败 ${formatCount(stats.failedCommands, '条命令')}`)
  }
  if (stats.failedTools > 0) parts.push(`执行失败 ${formatCount(stats.failedTools, '个工具')}`)

  return parts.length > 0 ? parts.join(' ') : `已执行 ${formatCount(blocks.length, '个工具')}`
}

function getActivityStats(blocks: ToolBlock[]): ActivityStats {
  return blocks.reduce<ActivityStats>(
    (stats, block) => {
      const kind = getToolActivityKind(block)
      if (block.status === 'error') {
        if (kind === 'command' || isCommandToolName(block.toolName)) {
          stats.failedCommands += 1
        } else {
          stats.failedTools += 1
        }
        return stats
      }

      if (kind === 'file') stats.files += 1
      if (kind === 'search') stats.searches += 1
      if (kind === 'command') stats.commands += 1
      if (kind === 'create') stats.creates += 1
      if (kind === 'edit') stats.edits += 1
      if (kind === 'guidance') stats.guidance += 1
      if (kind === 'tool') stats.tools += 1
      return stats
    },
    {
      files: 0,
      searches: 0,
      commands: 0,
      creates: 0,
      edits: 0,
      guidance: 0,
      tools: 0,
      failedCommands: 0,
      failedTools: 0,
    }
  )
}

function getToolActivityKind(block: ToolBlock): ToolActivityKind {
  const name = block.toolName.toLowerCase()
  if (isFileReadToolName(name)) return 'file'
  if (isFileCreateToolName(name)) return 'create'
  if (isFileEditToolName(name)) return 'edit'
  if (isGuidanceToolName(name)) return 'guidance'
  if (SEARCH_TOOL_HINTS.some(hint => name.includes(hint))) return 'search'
  if (isCommandToolName(name)) {
    return getCommandActivityKind(getInputField(block, 'command', 'cmd', 'commandLine'))
  }
  return 'tool'
}

function getCommandActivityKind(command?: string): ToolActivityKind {
  const executable = getCommandExecutable(command)
  if (!executable) return 'command'
  if (SEARCH_COMMANDS.has(executable)) return 'search'
  if (FILE_COMMANDS.has(executable)) return 'file'
  if (executable === 'git' && command?.includes(' grep ')) return 'search'
  if (executable === 'git' && command?.includes(' ls-files')) return 'search'
  return 'command'
}

function getCommandExecutable(command?: string): string {
  const innerCommand = unwrapShellCommand(command ?? '')
  const match = innerCommand.match(
    /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:sudo\s+)?([^\s]+)/
  )
  const executable = match?.[1]?.split('/').pop()
  return executable?.toLowerCase() ?? ''
}

function unwrapShellCommand(command: string): string {
  const match = command.match(/(?:^|\s)-lc\s+(['"])([\s\S]*)\1/)
  return (match?.[2] ?? command).trim()
}

function isCompletedToolBlock(block: ToolBlock): boolean {
  return block.status === 'done' || block.status === 'error'
}

export function isContextCompactionToolBlock(block: ProcessingBlock): block is ToolBlock {
  return block.type === 'tool' && isContextCompactionToolName(block.toolName)
}

export function isWebSearchToolName(name: string): boolean {
  return name.toLowerCase() === 'web_search'
}

export function isWebSearchActivityGroup(blocks: ToolBlock[]): boolean {
  return blocks.length > 0 && blocks.every(block => isWebSearchToolName(block.toolName))
}

export function isGuidanceActivityGroup(blocks: ToolBlock[]): boolean {
  return blocks.length > 0 && blocks.every(block => isGuidanceToolName(block.toolName))
}

export { isCommandToolName, isGuidanceToolName }

function getToolGroupId(blocks: ToolBlock[]): string {
  const first = blocks[0]?.id ?? 'empty'
  const last = blocks[blocks.length - 1]?.id ?? first
  return `tool-group-${first}-${last}`
}

function formatCount(count: number, unit: string): string {
  return `${count} ${unit}`
}
