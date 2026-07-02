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
