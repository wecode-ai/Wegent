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

export type CodexInlineVisualizationPart =
  | { kind: 'markdown'; content: string }
  | { kind: 'visualization'; file: string }

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

    const match = inCodeFence ? null : line.match(CODEX_INLINE_VISUALIZATION_PATTERN)
    if (!match) {
      markdownLines.push(line)
      continue
    }

    const file = unescapeDirectiveValue(match[1] ?? match[2] ?? '')
    if (!isSafeInlineVisualizationFile(file)) {
      markdownLines.push(line)
      continue
    }

    flushMarkdown()
    parts.push({ kind: 'visualization', file })
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

function isSafeInlineVisualizationFile(file: string): boolean {
  const normalized = file.trim().replace(/\\/g, '/')
  return (
    normalized.length > 0 &&
    !normalized.startsWith('/') &&
    !normalized.split('/').some(segment => segment === '..') &&
    /\.(?:html?|xhtml)$/i.test(normalized)
  )
}
