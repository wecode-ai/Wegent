import type { ToolBlock } from '@/types/workbench'

const COMMAND_TOOLS = new Set([
  'bash',
  'exec_command',
  'execute_command',
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

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase()
}

function toolNameCandidates(name: string): string[] {
  const normalized = normalizeToolName(name)
  const doubleUnderscoreParts = normalized.split('__')
  const lastDoubleUnderscorePart = doubleUnderscoreParts[doubleUnderscoreParts.length - 1]
  const dotParts = normalized.split('.')
  const lastDotPart = dotParts[dotParts.length - 1]

  return Array.from(new Set([normalized, lastDoubleUnderscorePart, lastDotPart]))
}

function matchesToolName(name: string, names: Set<string>): boolean {
  return toolNameCandidates(name).some(candidate => names.has(candidate))
}

export function isCommandToolName(name: string): boolean {
  return matchesToolName(name, COMMAND_TOOLS)
}

export function isFileReadToolName(name: string): boolean {
  return matchesToolName(name, FILE_TOOLS)
}

export function isFileCreateToolName(name: string): boolean {
  return matchesToolName(name, CREATE_TOOLS)
}

export function isFileEditToolName(name: string): boolean {
  return matchesToolName(name, EDIT_TOOLS)
}

export function isGuidanceToolName(name: string): boolean {
  return matchesToolName(name, GUIDANCE_TOOLS)
}

export function getInputField(block: Pick<ToolBlock, 'toolInput'>, ...keys: string[]) {
  if (!block.toolInput) return undefined
  for (const key of keys) {
    const value = block.toolInput[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

export function getFileInputPath(block: Pick<ToolBlock, 'toolInput'>): string | undefined {
  return getInputField(
    block,
    'file_path',
    'filePath',
    'filepath',
    'path',
    'file',
    'filename',
    'target_file',
    'targetFile',
    'notebook_path',
    'notebookPath'
  )
}
