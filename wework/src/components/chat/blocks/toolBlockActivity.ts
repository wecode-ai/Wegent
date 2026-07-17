import type { TurnFileChangeItem, TurnFileChangesSummary } from '@/types/api'
import type { FileChangesBlock, ProcessingBlock, ToolBlock } from '@/types/workbench'
import {
  getFileInputPaths,
  getInputField,
  isCommandToolName,
  isFileCreateToolName,
  isFileEditToolName,
  isFileReadToolName,
  isGuidanceToolName,
  isContextCompactionToolName,
  isPatchApplyToolName,
} from './toolBlockKinds'

export type ProcessingDisplayRow =
  | { type: 'block'; id: string; block: ProcessingBlock }
  | { type: 'activity_group'; id: string; blocks: ToolBlock[]; label: string }

export type ToolActivityKind =
  | 'file'
  | 'search'
  | 'command'
  | 'create'
  | 'edit'
  | 'guidance'
  | 'tool'

export interface ToolActivitySearchItem {
  id: string
  query: string
  scope?: string
  label: string
}

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
const HIDDEN_ACTIVITY_TOOLS = new Set(['write_stdin', 'functions.write_stdin'])

export function buildProcessingDisplayRows(
  blocks: ProcessingBlock[],
  options: { groupCompletedTools?: boolean } = {}
): ProcessingDisplayRow[] {
  const groupCompletedTools = options.groupCompletedTools ?? true
  const rows: ProcessingDisplayRow[] = []
  let completedTools: ToolBlock[] = []
  let consecutiveFileChanges: FileChangesBlock[] = []
  const hasFileChangesBlock = blocks.some(block => block.type === 'file_changes')

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

  const appendCompletedTool = (block: ToolBlock) => {
    const previousBlock = completedTools.at(-1)
    if (
      previousBlock &&
      getToolActivityGroupKey(previousBlock) !== getToolActivityGroupKey(block)
    ) {
      flushCompletedTools()
    }
    completedTools.push(block)
  }

  const flushFileChanges = () => {
    if (consecutiveFileChanges.length === 0) return
    const block =
      consecutiveFileChanges.length === 1
        ? consecutiveFileChanges[0]
        : mergeConsecutiveFileChanges(consecutiveFileChanges)
    rows.push({ type: 'block', id: block.id, block })
    consecutiveFileChanges = []
  }

  for (const block of blocks) {
    if (block.type === 'tool' && isContextCompactionToolName(block.toolName)) {
      flushCompletedTools()
      flushFileChanges()
      rows.push({ type: 'block', id: block.id, block })
      continue
    }

    if (isHiddenToolActivityBlock(block)) {
      continue
    }

    if (hasFileChangesBlock && isRedundantPatchApplyBlock(block)) {
      continue
    }

    if (block.type === 'file_changes') {
      flushCompletedTools()
      consecutiveFileChanges.push(block)
      continue
    }

    if (groupCompletedTools && block.type === 'tool' && isCompletedToolBlock(block)) {
      flushFileChanges()
      appendCompletedTool(block)
      continue
    }

    flushCompletedTools()
    flushFileChanges()
    rows.push({ type: 'block', id: block.id, block })
  }

  flushCompletedTools()
  flushFileChanges()
  return rows
}

function getToolActivityGroupKey(block: ToolBlock): string {
  const name = block.toolName.toLowerCase()
  if (isWebSearchToolName(name)) return 'web-search'
  return getToolActivityKind(block)
}

function mergeConsecutiveFileChanges(blocks: FileChangesBlock[]): FileChangesBlock {
  const first = blocks[0]
  const latest = blocks[blocks.length - 1]
  const summaries = blocks.map(block => block.fileChanges)
  const files = mergeFileChangeItems(summaries.flatMap(summary => summary.files))
  const diff = summaries
    .map(summary => summary.diff?.trim())
    .filter((value): value is string => Boolean(value))
    .join('\n')

  return {
    ...latest,
    id: `file-changes-${first.id}-${latest.id}`,
    fileChanges: {
      ...latest.fileChanges,
      artifact_id: summaries.map(summary => summary.artifact_id).join(':'),
      additions: sumFileChangeValues(summaries, 'additions'),
      deletions: sumFileChangeValues(summaries, 'deletions'),
      file_count: files.length,
      files,
      ...(diff ? { diff } : {}),
      revertible: summaries.every(summary => summary.revertible !== false),
    },
  }
}

function mergeFileChangeItems(files: TurnFileChangeItem[]): TurnFileChangeItem[] {
  const merged = new Map<string, TurnFileChangeItem>()

  files.forEach(file => {
    const key = `${file.old_path ?? ''}\0${file.path}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...file })
      return
    }

    merged.set(key, {
      ...file,
      additions: existing.additions + file.additions,
      deletions: existing.deletions + file.deletions,
      binary: existing.binary || file.binary,
    })
  })

  return Array.from(merged.values())
}

function sumFileChangeValues(
  summaries: TurnFileChangesSummary[],
  key: 'additions' | 'deletions'
): number {
  return summaries.reduce((sum, summary) => sum + summary[key], 0)
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

export function getToolActivityKind(block: ToolBlock): ToolActivityKind {
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

export function getToolActivityFilePaths(block: ToolBlock): string[] {
  const name = block.toolName.toLowerCase()
  if (isFileReadToolName(name)) return getFileInputPaths(block)
  if (!isCommandToolName(name)) return []

  const command = getInputField(block, 'command', 'cmd', 'commandLine')
  if (getCommandActivityKind(command) !== 'file') return []
  return getReadCommandFilePaths(command)
}

export function getToolActivitySearchItem(block: ToolBlock): ToolActivitySearchItem | undefined {
  const name = block.toolName.toLowerCase()
  if (isWebSearchToolName(name) || getToolActivityKind(block) !== 'search') return undefined

  if (isCommandToolName(name)) {
    const command = getInputField(block, 'command', 'cmd', 'commandLine')
    const summary = getSearchCommandSummary(command, getCommandWorkingDirectory(block))
    if (!summary) return undefined
    return {
      id: `${block.id}-code-search`,
      query: summary.query,
      scope: summary.scope,
      label: formatSearchLabel(summary),
    }
  }

  const query = getInputField(block, 'query', 'pattern', 'search')
  if (!query) return undefined
  const scopePath = getInputField(block, 'path', 'directory', 'dir', 'root')
  const scope = formatSearchScope(scopePath ? [scopePath] : [], getCommandWorkingDirectory(block))
  return {
    id: `${block.id}-code-search`,
    query,
    scope,
    label: formatSearchLabel({ query, scope }),
  }
}

export function getToolActivityGroupKind(blocks: ToolBlock[]): ToolActivityKind {
  const kinds = blocks.map(getToolActivityKind)
  if (kinds.length === 0) return 'tool'

  const primaryKinds = kinds.filter(kind => kind !== 'tool')
  if (primaryKinds.length === 0) return 'tool'

  const firstKind = primaryKinds[0]
  return primaryKinds.every(kind => kind === firstKind) ? firstKind : 'tool'
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

function getReadCommandFilePaths(command?: string): string[] {
  const words = splitShellWords(unwrapShellCommand(command ?? ''))
  const executableIndex = getExecutableWordIndex(words)
  const executable = words[executableIndex]?.split('/').pop()?.toLowerCase()
  if (!executable || !FILE_COMMANDS.has(executable)) return []

  const args = getFirstCommandSegment(words.slice(executableIndex + 1))
  if (executable === 'sed') return getSedInputPaths(args)
  return getPathArguments(args, READ_COMMAND_OPTIONS_WITH_VALUES)
}

function getSearchCommandSummary(
  command: string | undefined,
  cwd: string | undefined
): { query: string; scope?: string } | undefined {
  const words = splitShellWords(unwrapShellCommand(command ?? ''))
  const executableIndex = getExecutableWordIndex(words)
  const executable = words[executableIndex]?.split('/').pop()?.toLowerCase()
  if (!executable) return undefined

  const args = getFirstCommandSegment(words.slice(executableIndex + 1))
  if (executable === 'git') return getGitSearchCommandSummary(args, cwd)
  if (executable === 'find') return getFindSearchCommandSummary(args, cwd)
  if (PATTERN_SEARCH_COMMANDS.has(executable)) {
    const parsed = getPatternSearchArguments(args)
    if (!parsed?.query) return undefined
    return { query: parsed.query, scope: formatSearchScope(parsed.scopes, cwd) }
  }
  return undefined
}

const PATTERN_SEARCH_COMMANDS = new Set(['rg', 'grep', 'ag', 'ack', 'fd'])
const SEARCH_PATTERN_OPTIONS = new Set(['-e', '--regexp', '--pattern'])
const SEARCH_COMMAND_OPTIONS_WITH_VALUES = new Set([
  '-A',
  '--after-context',
  '-B',
  '--before-context',
  '-C',
  '--context',
  '-f',
  '--file',
  '-g',
  '--glob',
  '-j',
  '--threads',
  '-m',
  '--max-count',
  '--max-depth',
  '--sort',
  '--sortr',
  '-t',
  '--type',
  '-T',
  '--type-not',
  '--colors',
  '--color',
  '--engine',
  '--encoding',
  '--ignore-file',
  '--path-separator',
])

function getGitSearchCommandSummary(
  args: string[],
  cwd: string | undefined
): { query: string; scope?: string } | undefined {
  const grepIndex = args.indexOf('grep')
  if (grepIndex === -1) return undefined

  const grepArgs = args.slice(grepIndex + 1)
  const separatorIndex = grepArgs.indexOf('--')
  const searchArgs = separatorIndex === -1 ? grepArgs : grepArgs.slice(0, separatorIndex)
  const pathspecs = separatorIndex === -1 ? [] : grepArgs.slice(separatorIndex + 1)
  const parsed = getPatternSearchArguments(searchArgs)
  if (!parsed?.query) return undefined
  return {
    query: parsed.query,
    scope: formatSearchScope(pathspecs.length > 0 ? pathspecs : parsed.scopes, cwd),
  }
}

function getPatternSearchArguments(args: string[]):
  | {
      query: string
      scopes: string[]
    }
  | undefined {
  let query: string | undefined
  let queryFromOption = false
  const positional: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue
    if (arg === '--') {
      positional.push(...args.slice(index + 1).filter(isLikelyPathArgument))
      break
    }
    if (arg.startsWith('-')) {
      const optionName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
      if (SEARCH_PATTERN_OPTIONS.has(optionName)) {
        if (!query) {
          query = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[index + 1]
          queryFromOption = true
        }
        if (!arg.includes('=')) index += 1
        continue
      }
      if (!arg.includes('=') && SEARCH_COMMAND_OPTIONS_WITH_VALUES.has(optionName)) index += 1
      continue
    }
    positional.push(arg)
  }

  query = query ?? positional[0]
  if (!query) return undefined
  return { query, scopes: queryFromOption ? positional : positional.slice(1) }
}

function getFindSearchCommandSummary(
  args: string[],
  cwd: string | undefined
): { query: string; scope?: string } | undefined {
  const expressionIndex = args.findIndex(arg => arg.startsWith('-') || arg === '(' || arg === '!')
  const scopes = expressionIndex > 0 ? args.slice(0, expressionIndex) : []
  const expression = expressionIndex === -1 ? args : args.slice(expressionIndex)
  const query = getFindExpressionQuery(expression)
  if (!query) return undefined
  return { query, scope: formatSearchScope(scopes, cwd) }
}

const FIND_QUERY_OPTIONS = new Set(['-name', '-iname', '-path', '-ipath', '-regex', '-iregex'])

function getFindExpressionQuery(expression: string[]): string | undefined {
  for (let index = 0; index < expression.length; index += 1) {
    const arg = expression[index]
    if (FIND_QUERY_OPTIONS.has(arg)) return expression[index + 1]
  }
  return undefined
}

function formatSearchLabel(summary: { query: string; scope?: string }): string {
  return summary.scope
    ? `Searched for ${summary.query} in ${summary.scope}`
    : `Searched for ${summary.query}`
}

function formatSearchScope(scopes: string[], cwd: string | undefined): string | undefined {
  const scope = scopes.find(item => item && item !== '.' && item !== './') ?? cwd ?? scopes[0]
  if (!scope) return undefined
  return basename(scope)
}

function getCommandWorkingDirectory(block: Pick<ToolBlock, 'toolInput'>): string | undefined {
  return getInputField(block, 'cwd', 'workdir', 'workingDirectory')
}

const READ_COMMAND_OPTIONS_WITH_VALUES = new Set([
  '-n',
  '--lines',
  '-c',
  '--bytes',
  '-m',
  '--max-count',
  '-t',
  '--type',
])

function getSedInputPaths(args: string[]): string[] {
  const nonOptionArgs = getPathArguments(args, new Set(['-e', '--expression', '-f', '--file']))
  if (nonOptionArgs.length <= 1) return []
  return nonOptionArgs.slice(1)
}

function getPathArguments(args: string[], optionsWithValues: ReadonlySet<string>): string[] {
  const paths: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue
    if (arg === '--') {
      paths.push(...args.slice(index + 1).filter(isLikelyPathArgument))
      break
    }
    if (arg.startsWith('-')) {
      const optionName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
      if (!arg.includes('=') && optionsWithValues.has(optionName)) index += 1
      continue
    }
    if (isLikelyPathArgument(arg)) paths.push(arg)
  }

  return Array.from(new Set(paths))
}

function isLikelyPathArgument(arg: string): boolean {
  return arg.length > 0 && !arg.startsWith('>') && !arg.startsWith('<')
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function getFirstCommandSegment(words: string[]): string[] {
  const boundaryIndex = words.findIndex(word => COMMAND_BOUNDARIES.has(word))
  return boundaryIndex === -1 ? words : words.slice(0, boundaryIndex)
}

const COMMAND_BOUNDARIES = new Set(['|', '||', '&&', ';'])

function getExecutableWordIndex(words: string[]): number {
  let index = 0
  if (words[index] === 'env') {
    index += 1
    while (words[index]?.includes('=')) index += 1
  }
  if (words[index] === 'sudo') index += 1
  return index
}

function splitShellWords(command: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  const pushCurrent = () => {
    if (current.length === 0) return
    words.push(current)
    current = ''
  }

  for (const char of command) {
    if (escaped) {
      // A backslash followed by a newline continues the same shell command.
      if (char !== '\n' && char !== '\r') current += char
      escaped = false
      continue
    }

    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '\n' || char === '\r') {
      pushCurrent()
      if (words.at(-1) !== ';') words.push(';')
      continue
    }

    if (/\s/.test(char)) {
      pushCurrent()
      continue
    }

    if (char === '|' || char === ';' || char === '&') {
      pushCurrent()
      const previous = words[words.length - 1]
      if ((char === '|' || char === '&') && previous === char) {
        words[words.length - 1] = `${char}${char}`
      } else {
        words.push(char)
      }
      continue
    }

    current += char
  }

  pushCurrent()
  return words
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

function isRedundantPatchApplyBlock(block: ProcessingBlock): boolean {
  return block.type === 'tool' && block.status === 'done' && isPatchApplyToolName(block.toolName)
}

function isHiddenToolActivityBlock(block: ProcessingBlock): boolean {
  return block.type === 'tool' && HIDDEN_ACTIVITY_TOOLS.has(block.toolName.toLowerCase())
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
