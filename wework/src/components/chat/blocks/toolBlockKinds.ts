import type { ToolBlock } from '@/types/workbench'

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
const PATCH_APPLY_TOOLS = new Set(['apply_patch', 'functions.apply_patch'])
const GUIDANCE_TOOLS = new Set(['conversation_guidance', 'user_guidance'])
const CONTEXT_COMPACTION_TOOLS = new Set(['context_compaction', 'contextcompaction'])
const IMAGE_VIEW_TOOLS = new Set(['view_image', 'image_view', 'imageview'])

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

export function isPatchApplyToolName(name: string): boolean {
  return matchesToolName(name, PATCH_APPLY_TOOLS)
}

export function isGuidanceToolName(name: string): boolean {
  return matchesToolName(name, GUIDANCE_TOOLS)
}

export function isContextCompactionToolName(name: string): boolean {
  return matchesToolName(name, CONTEXT_COMPACTION_TOOLS)
}

export function isImageViewToolName(name: string): boolean {
  return matchesToolName(name, IMAGE_VIEW_TOOLS)
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
  return getFileInputPaths(block)[0]
}

export function getFileInputPaths(block: Pick<ToolBlock, 'toolInput'>): string[] {
  const directPath = getDirectFileInputPath(block.toolInput)
  if (directPath) return [directPath]
  return getPatchFilePaths(block.toolInput)
}

function getDirectFileInputPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  const directPath = getStringField(
    input,
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
  if (directPath) return directPath

  for (const nestedKey of ['input', 'arguments']) {
    const nestedValue = input[nestedKey]
    if (isRecord(nestedValue)) {
      const nestedPath = getDirectFileInputPath(nestedValue)
      if (nestedPath) return nestedPath
    }
  }

  return undefined
}

function getPatchFilePaths(input: Record<string, unknown> | undefined): string[] {
  if (!input) return []
  const patchText = getStringField(input, 'patch', 'input', 'arguments', 'content')
  if (!patchText) return []

  const paths = new Set<string>()
  for (const line of patchText.split('\n')) {
    const match = line.match(/^\*\*\* (?:Add|Delete|Update) File:\s*(.+)$/)
    const path = match?.[1]?.trim()
    if (path) paths.add(path)
  }
  return Array.from(paths)
}

function getStringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
