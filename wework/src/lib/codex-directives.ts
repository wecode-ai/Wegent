const CODEX_UI_DIRECTIVE_NAMES = [
  'archive-thread',
  'automation-citation',
  'code-comment',
  'created-thread',
  'github-details',
  'git-commit',
  'git-create-branch',
  'git-create-pr',
  'git-push',
  'git-stage',
  'inbox-item',
  'pr-auto-fix-progress',
]

const CODE_FENCE_PATTERN = /^\s*(```|~~~)/
const CODEX_UI_DIRECTIVE_LINE_PATTERN = new RegExp(
  `^\\s*::(?::)?(?:${CODEX_UI_DIRECTIVE_NAMES.join('|')})(?:\\b|\\{).*`
)
const CODEX_INLINE_VISUALIZATION_PATTERN =
  /^\s*::codex-inline-vis\{\s*file=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*\}\s*$/
const VISUALIZE_CONTENT_REFERENCE_PATTERN = /^\s*visualize(\{.*\})\s*$/

export type CodexInlineVisualizationPart =
  | { kind: 'markdown'; content: string }
  | { kind: 'visualization'; file: string; mode?: 'wide'; title?: string }

export function splitCodexInlineVisualizations(content: string): CodexInlineVisualizationPart[] {
  const parts: CodexInlineVisualizationPart[] = []
  let markdownLines: string[] = []
  let inCodeFence = false

  const flushMarkdown = () => {
    if (markdownLines.length === 0) return
    parts.push({ kind: 'markdown', content: markdownLines.join('\n') })
    markdownLines = []
  }

  for (const line of content.split('\n')) {
    if (CODE_FENCE_PATTERN.test(line)) {
      inCodeFence = !inCodeFence
      markdownLines.push(line)
      continue
    }

    const visualization = inCodeFence ? null : parseInlineVisualization(line)
    if (!visualization) {
      markdownLines.push(line)
      continue
    }

    flushMarkdown()
    parts.push(visualization)
  }

  flushMarkdown()
  return parts
}

export function stripCodexUiDirectives(content: string): string {
  let inCodeFence = false
  let changed = false
  const lines: string[] = []

  for (const line of content.split('\n')) {
    if (CODE_FENCE_PATTERN.test(line)) {
      inCodeFence = !inCodeFence
      lines.push(line)
      continue
    }

    if (inCodeFence) {
      lines.push(line)
      continue
    }

    if (CODEX_UI_DIRECTIVE_LINE_PATTERN.test(line)) {
      changed = true
      lines.push('')
      continue
    }
    lines.push(line)
  }

  if (!changed) return content

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function unescapeDirectiveValue(value: string): string {
  return value.replace(/\\([\\"'])/g, '$1')
}

function parseInlineVisualization(line: string): CodexInlineVisualizationPart | null {
  const legacyMatch = line.match(CODEX_INLINE_VISUALIZATION_PATTERN)
  if (legacyMatch) {
    const file = unescapeDirectiveValue(legacyMatch[1] ?? legacyMatch[2] ?? '')
    return isSafeLegacyVisualizationFile(file) ? { kind: 'visualization', file } : null
  }

  const contentReferenceMatch = line.match(VISUALIZE_CONTENT_REFERENCE_PATTERN)
  if (!contentReferenceMatch) return null

  try {
    const payload = JSON.parse(contentReferenceMatch[1]) as unknown
    if (!isRecord(payload) || typeof payload.path !== 'string') return null

    const file = payload.path.trim()
    if (!isSafeAbsoluteVisualizationFile(file)) return null
    if (payload.mode !== undefined && payload.mode !== 'wide') return null
    if (payload.title !== undefined && typeof payload.title !== 'string') return null

    return {
      kind: 'visualization',
      file,
      ...(payload.mode === 'wide' ? { mode: 'wide' as const } : {}),
      ...(typeof payload.title === 'string' && payload.title.trim()
        ? { title: payload.title.trim() }
        : {}),
    }
  } catch {
    return null
  }
}

function isSafeLegacyVisualizationFile(file: string): boolean {
  const normalized = file.trim().replace(/\\/g, '/')
  return (
    normalized.length > 0 &&
    !normalized.startsWith('/') &&
    !normalized.split('/').some(segment => segment === '..') &&
    /\.(?:html?|xhtml)$/i.test(normalized)
  )
}

function isSafeAbsoluteVisualizationFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/')
  return (
    (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) &&
    normalized.split('/').includes('visualizations') &&
    !normalized.split('/').some(segment => segment === '..') &&
    /\.(?:html?|xhtml)$/i.test(normalized)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
