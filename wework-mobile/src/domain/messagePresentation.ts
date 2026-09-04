import type {
  ChatFileChangeItem,
  ChatFileChangesBlock,
  ChatFileChangesSummary,
  ChatNarrativeBlock,
  ChatProcessingBlock,
  ChatToolBlock,
} from '@/types/runtime'

export type ToolActivityKind =
  'web' | 'file' | 'search' | 'command' | 'create' | 'edit' | 'guidance' | 'tool'

export type MessageDisplayRow =
  | { type: 'narrative'; id: string; block: ChatNarrativeBlock }
  | { type: 'tool'; id: string; block: ChatToolBlock; kind: ToolActivityKind }
  | { type: 'file-changes'; id: string; block: ChatFileChangesBlock }
  | {
      type: 'tool-group'
      id: string
      blocks: ChatToolBlock[]
      kind: ToolActivityKind
      label: string
      failed: boolean
    }

export interface MessageDisplaySegment {
  id: string
  kind: 'tool' | 'narrative'
  rows: MessageDisplayRow[]
}

export interface ProcessingActivityStats {
  command: number
  file: number
  search: number
  edit: number
  other: number
}

export interface GeneratedImageArtifact {
  id: string
  uri: string
  alt: string
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
const PATCH_TOOLS = new Set(['apply_patch', 'functions.apply_patch'])
const GUIDANCE_TOOLS = new Set(['conversation_guidance', 'user_guidance'])
const CONTEXT_COMPACTION_TOOLS = new Set(['context_compaction', 'contextcompaction'])
const HIDDEN_TOOLS = new Set(['write_stdin', 'functions.write_stdin'])
const SEARCH_COMMANDS = new Set(['rg', 'grep', 'find', 'fd', 'ls', 'tree', 'ag', 'ack'])
const FILE_COMMANDS = new Set(['cat', 'sed', 'head', 'tail', 'wc', 'nl', 'stat', 'file'])

export function buildMessageDisplayRows(
  blocks: ChatProcessingBlock[] | undefined,
  finalContent: string,
  options: { groupCompletedTools?: boolean } = {}
): MessageDisplayRow[] {
  const source = blocks ?? []
  const groupCompletedTools = options.groupCompletedTools ?? true
  const rows: MessageDisplayRow[] = []
  const hasFileChanges = source.some(block => block.type === 'file_changes')
  let completedTools: ChatToolBlock[] = []
  let completedGroupKey: string | null = null
  let consecutiveFileChanges: ChatFileChangesBlock[] = []

  const flushCompletedTools = () => {
    if (!completedTools.length) return
    const kind = getGroupKind(completedTools)
    rows.push({
      type: 'tool-group',
      id: `tool-group-${completedTools[0]?.id}-${completedTools.at(-1)?.id}`,
      blocks: completedTools,
      kind,
      label: summarizeToolActivity(completedTools),
      failed: completedTools.some(block => block.status === 'error'),
    })
    completedTools = []
    completedGroupKey = null
  }

  const flushFileChanges = () => {
    if (!consecutiveFileChanges.length) return
    const block = mergeFileChangesBlocks(consecutiveFileChanges)
    rows.push({ type: 'file-changes', id: block.id, block })
    consecutiveFileChanges = []
  }

  for (const block of source) {
    if (block.type === 'thinking') continue
    if (block.type === 'tool' && isHiddenTool(block)) continue
    if (hasFileChanges && block.type === 'tool' && isCompletedPatchTool(block)) continue

    if (block.type === 'file_changes') {
      flushCompletedTools()
      consecutiveFileChanges.push(block)
      continue
    }

    if (block.type === 'tool') {
      flushFileChanges()
      const completed = block.status === 'done' || block.status === 'error'
      if (!groupCompletedTools || !completed || isStandaloneTool(block)) {
        flushCompletedTools()
        rows.push({ type: 'tool', id: block.id, block, kind: getToolActivityKind(block) })
        continue
      }

      const groupKey = toolActivityGroupKey(block)
      if (completedGroupKey && completedGroupKey !== groupKey) flushCompletedTools()
      completedGroupKey = groupKey
      completedTools.push(block)
      continue
    }

    flushCompletedTools()
    flushFileChanges()
    if (block.type === 'text' && block.content.trim() === finalContent.trim()) continue
    if (block.content.trim()) rows.push({ type: 'narrative', id: block.id, block })
  }

  flushCompletedTools()
  flushFileChanges()
  return rows
}

export function buildMessageDisplaySegments(
  blocks: ChatProcessingBlock[] | undefined,
  finalContent: string
): MessageDisplaySegment[] {
  const source = blocks ?? []
  const segments: Array<{ kind: MessageDisplaySegment['kind']; blocks: ChatProcessingBlock[] }> = []

  for (const block of source) {
    const kind = isCollapsibleToolBlock(block) ? 'tool' : 'narrative'
    const previous = segments.at(-1)
    if (previous?.kind === kind) previous.blocks.push(block)
    else segments.push({ kind, blocks: [block] })
  }

  return segments.flatMap((segment, index) => {
    const rows = buildMessageDisplayRows(segment.blocks, finalContent, {
      groupCompletedTools: segment.kind === 'tool',
    })
    return rows.length
      ? [{ id: `${segment.kind}-${index}-${rows[0]?.id}`, kind: segment.kind, rows }]
      : []
  })
}

export function processingActivityStats(rows: MessageDisplayRow[]): ProcessingActivityStats {
  const stats: ProcessingActivityStats = { command: 0, file: 0, search: 0, edit: 0, other: 0 }
  const addTool = (block: ChatToolBlock) => {
    const kind = getToolActivityKind(block)
    if (kind === 'command') stats.command += 1
    else if (kind === 'file') stats.file += 1
    else if (kind === 'search' || kind === 'web') stats.search += 1
    else if (kind === 'edit' || kind === 'create') stats.edit += 1
    else stats.other += 1
  }

  for (const row of rows) {
    if (row.type === 'tool-group') row.blocks.forEach(addTool)
    else if (row.type === 'tool') addTool(row.block)
    else if (row.type === 'file-changes') {
      stats.edit += row.block.fileChanges.fileCount || row.block.fileChanges.files.length
    }
  }
  return stats
}

export function processingSegmentTitle(rows: MessageDisplayRow[]): string {
  const stats = processingActivityStats(rows)
  const toolCount = stats.command + stats.file + stats.search + stats.other
  const onlyEdits = stats.edit > 0 && toolCount === 0
  if (onlyEdits) return `编辑 ${stats.edit} 个文件`
  if (stats.edit > 0) return `编辑 ${stats.edit} 个文件，调用 ${toolCount} 个工具`
  return `调用 ${toolCount} 个工具`
}

export function generatedImagesFromBlocks(
  blocks: ChatProcessingBlock[] | undefined
): GeneratedImageArtifact[] {
  return (blocks ?? []).flatMap(block => {
    if (block.type !== 'tool' || normalizeToolName(block.toolName) !== 'image_generation') return []
    const payload = asRecord(block.renderPayload)
    const image = payload.imageBase64
    if (typeof image !== 'string' || !image.trim()) return []
    const revisedPrompt = payload.revisedPrompt
    return [
      {
        id: block.id,
        uri: image.startsWith('data:') ? image : `data:image/png;base64,${image}`,
        alt:
          typeof revisedPrompt === 'string' && revisedPrompt.trim()
            ? revisedPrompt
            : 'Generated image',
      },
    ]
  })
}

export function getToolActivityKind(block: ChatToolBlock): ToolActivityKind {
  const name = normalizeToolName(block.toolName)
  if (name === 'web_search') return 'web'
  if (matchesToolName(name, FILE_TOOLS)) return 'file'
  if (matchesToolName(name, CREATE_TOOLS)) return 'create'
  if (matchesToolName(name, EDIT_TOOLS)) return 'edit'
  if (matchesToolName(name, GUIDANCE_TOOLS)) return 'guidance'
  if (['search', 'grep', 'glob'].some(hint => name.includes(hint))) return 'search'
  if (isNodeReplTool(name)) return 'command'
  if (matchesToolName(name, COMMAND_TOOLS)) return commandActivityKind(commandFrom(block))
  return 'tool'
}

export function summarizeToolActivity(blocks: ChatToolBlock[]): string {
  if (
    blocks.length > 0 &&
    blocks.every(block => normalizeToolName(block.toolName) === 'web_search')
  ) {
    return '已搜索网页'
  }

  const labels: string[] = []
  const counts = activityCounts(blocks)
  if (counts.file) labels.push(`已读取 ${counts.file} 个文件`)
  if (counts.search) labels.push('已搜索代码')
  if (counts.create) labels.push(`已新增 ${counts.create} 个文件`)
  if (counts.edit) labels.push(`已编辑 ${counts.edit} 个文件`)
  if (counts.guidance) labels.push('已引导对话')
  if (counts.command) labels.push(`已运行 ${counts.command} 条命令`)
  if (counts.tool) labels.push(`已调用 ${counts.tool} 个工具`)
  if (counts.failedCommand) labels.push(`运行失败 ${counts.failedCommand} 条命令`)
  if (counts.failedTool) labels.push(`执行失败 ${counts.failedTool} 个工具`)
  return labels.join(' ') || `已调用 ${blocks.length} 个工具`
}

export function processingDurationLabel(
  blocks: ChatProcessingBlock[] | undefined,
  messageCreatedAt: number,
  messageCompletedAt?: number
): string {
  const visible = blocks?.filter(block => block.type !== 'thinking') ?? []
  const first = visible[0]?.createdAt ?? messageCreatedAt
  const last = visible.at(-1)
  const end = messageCompletedAt ?? last?.completedAt ?? last?.createdAt ?? first
  const durationMs = Math.max(0, end - first)
  return durationMs < 1000 ? '已处理' : `已处理 ${formatDuration(durationMs)}`
}

export function shouldCollapseCompletedProcessing(
  blocks: ChatProcessingBlock[] | undefined,
  finalContent: string,
  rows: MessageDisplayRow[]
): boolean {
  return (
    Boolean(finalContent.trim()) &&
    rows.length > 0 &&
    !blocks?.some(block => block.type === 'plan' && block.content.trim()) &&
    !blocks?.some(block => block.status !== 'done' && block.status !== 'error')
  )
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

export function fileChangeLabel(file: ChatFileChangeItem, running: boolean): string {
  const filename = basename(file.path)
  if (running) {
    if (file.changeType === 'created') return `正在创建 ${filename}`
    if (file.changeType === 'deleted') return `正在删除 ${filename}`
    if (file.changeType === 'renamed') return `正在重命名 ${filename}`
    return `正在编辑 ${filename}`
  }
  if (file.changeType === 'created') return `已创建 ${filename}`
  if (file.changeType === 'deleted') return `已删除 ${filename}`
  if (file.changeType === 'renamed') return `已重命名 ${filename}`
  return `已编辑 ${filename}`
}

function activityCounts(blocks: ChatToolBlock[]) {
  const counts = {
    file: 0,
    search: 0,
    command: 0,
    create: 0,
    edit: 0,
    guidance: 0,
    tool: 0,
    failedCommand: 0,
    failedTool: 0,
  }
  for (const block of blocks) {
    const kind = getToolActivityKind(block)
    if (block.status === 'error') {
      if (kind === 'command') counts.failedCommand += 1
      else counts.failedTool += 1
      continue
    }
    if (kind === 'web' || kind === 'search') counts.search += 1
    else counts[kind] += 1
  }
  return counts
}

function getGroupKind(blocks: ChatToolBlock[]): ToolActivityKind {
  const kinds = blocks.map(getToolActivityKind)
  const primary = kinds.filter(kind => kind !== 'tool')
  const first = primary[0]
  return first && primary.every(kind => kind === first) ? first : 'tool'
}

function toolActivityGroupKey(block: ChatToolBlock): string {
  return normalizeToolName(block.toolName) === 'web_search'
    ? 'web-search'
    : getToolActivityKind(block)
}

function isCompletedPatchTool(block: ChatToolBlock): boolean {
  return block.status === 'done' && matchesToolName(normalizeToolName(block.toolName), PATCH_TOOLS)
}

function isStandaloneTool(block: ChatToolBlock): boolean {
  const name = normalizeToolName(block.toolName)
  if (matchesToolName(name, CONTEXT_COMPACTION_TOOLS)) return true
  const payload = asRecord(block.renderPayload)
  return payload.kind === 'request_user_input' || payload.kind === 'image_generation'
}

function isCollapsibleToolBlock(block: ChatProcessingBlock): boolean {
  if (block.type === 'file_changes') return true
  if (block.type !== 'tool') return false
  const name = normalizeToolName(block.toolName)
  return !matchesToolName(name, GUIDANCE_TOOLS) && !matchesToolName(name, CONTEXT_COMPACTION_TOOLS)
}

function isHiddenTool(block: ChatToolBlock): boolean {
  const name = normalizeToolName(block.toolName)
  return HIDDEN_TOOLS.has(name) || (name === 'runtime_reconnecting' && block.status === 'done')
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
  for (const key of ['command', 'cmd', 'commandLine', 'code']) {
    const value = block.toolInput?.[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function mergeFileChangesBlocks(blocks: ChatFileChangesBlock[]): ChatFileChangesBlock {
  if (blocks.length === 1) return blocks[0] as ChatFileChangesBlock
  const first = blocks[0] as ChatFileChangesBlock
  const latest = blocks.at(-1) as ChatFileChangesBlock
  const summary = mergeFileChangesSummaries(blocks.map(block => block.fileChanges))
  return {
    ...latest,
    id: `file-changes-${first.id}`,
    createdAt: Math.min(...blocks.map(block => block.createdAt)),
    fileChanges: summary,
  }
}

function mergeFileChangesSummaries(summaries: ChatFileChangesSummary[]): ChatFileChangesSummary {
  const files = new Map<string, ChatFileChangeItem>()
  for (const summary of summaries) {
    for (const file of summary.files) {
      const key = `${file.oldPath ?? ''}\0${file.path}`
      const existing = files.get(key)
      files.set(
        key,
        existing
          ? {
              ...file,
              additions: existing.additions + file.additions,
              deletions: existing.deletions + file.deletions,
              binary: existing.binary || file.binary,
            }
          : file
      )
    }
  }
  return {
    fileCount: files.size,
    additions: summaries.reduce((sum, summary) => sum + summary.additions, 0),
    deletions: summaries.reduce((sum, summary) => sum + summary.deletions, 0),
    files: [...files.values()],
  }
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60)
    return remainingSeconds ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? path
}

function isNodeReplTool(name: string): boolean {
  return name === 'node_repl.js' || name === 'node_repl__js' || name.endsWith('__node_repl__js')
}

function matchesToolName(name: string, names: Set<string>): boolean {
  if (names.has(name)) return true
  const suffix = name.split(/__|\./).at(-1)
  return suffix ? names.has(suffix) : false
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase()
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
